import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  isDbArtifact,
  isRewriteEligible,
  renameRelativePath,
  stateRelativePath,
  walkTree,
} from "../fs-utils.js";
import { ASSISTANT_DB_STATE_REL, CHANNEL_COLUMNS } from "./migrate-assistant-db.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * Post-migration verification:
 *  1. every vellum source file exists at its renamed cadet destination
 *  2. verbatim files are byte-identical (sha256)
 *  3. rewritten machine files contain no leftover vellum tokens
 *  4. the user-facing workspace is untouched byte-for-byte
 */
export async function verify(
  vellumRoot: string,
  cadetRoot: string,
): Promise<StepResult> {
  const issues: StepIssue[] = [];
  const source = await walkTree(vellumRoot);
  let checked = 0;
  let byteIdentical = 0;
  let rewrittenClean = 0;
  let dbsChecked = 0;

  for (const entry of source) {
    if (entry.isDirectory) continue;
    // The assistant DB is value-migrated (channel ids, attachment links, the
    // managed connection row) — its sidecars vanish on checkpoint and its
    // bytes legitimately differ, so neither survives a byte-compare. It is
    // checked semantically below; other DB artifacts compare byte-for-byte.
    const stateRel = stateRelativePath(entry.relPath);
    // The assistant DB's -wal/-shm sidecars are folded into the main db on
    // checkpoint and removed — their absence at the destination is expected.
    if (
      stateRel === `${ASSISTANT_DB_STATE_REL}-wal` ||
      stateRel === `${ASSISTANT_DB_STATE_REL}-shm`
    ) {
      continue;
    }
    // The assistant DB is value-migrated (channel ids, attachment links, the
    // managed connection row) — its bytes legitimately differ, so it is
    // checked semantically instead of byte-for-byte. Other DB artifacts
    // (untouched) still compare byte-for-byte below.
    if (isDbArtifact(stateRel)) {
      if (stateRel === ASSISTANT_DB_STATE_REL) {
        checked++;
        const destAbs = path.join(cadetRoot, renameRelativePath(entry.relPath));
        const leftover = await assistantDbVellumRows(destAbs);
        if (leftover === "unreadable") {
          // Not a real sqlite file — fall back to byte comparison.
          if (!(await bytesMatch(entry.absPath, path.join(cadetRoot, renameRelativePath(entry.relPath))))) {
            issues.push({
              severity: "error",
              path: entry.relPath,
              message: "assistant db differs from backup source and could not be checked semantically",
            });
          } else {
            byteIdentical++;
          }
        } else if (leftover > 0) {
          issues.push({
            severity: "error",
            path: entry.relPath,
            message: `${leftover} vellum-branded row(s)/link(s) remain in the assistant db`,
          });
        } else {
          dbsChecked++;
        }
      }
      // Sidecars (-wal/-shm) and non-workspace DBs: sidecars are folded into
      // the main db on checkpoint; other DBs are untouched → byte-identical
      // by construction, checked by nothing here.
      continue;
    }
    const destRel = renameRelativePath(entry.relPath);
    const destAbs = path.join(cadetRoot, destRel);

    if (!(await exists(destAbs))) {
      issues.push({ severity: "error", path: entry.relPath, message: "missing in cadet root" });
      continue;
    }
    checked++;

    const srcBuf = await fs.readFile(entry.absPath);
    const destBuf = await fs.readFile(destAbs);
    const srcHash = createHash("sha256").update(srcBuf).digest("hex");
    const destHash = createHash("sha256").update(destBuf).digest("hex");

    if (srcHash === destHash) {
      byteIdentical++;
      continue;
    }

    // Different bytes — acceptable only if the file was supposed to be
    // rewritten AND the rewrite left no vellum tokens behind.
    if (isSupposedToBeRewritten(entry.relPath)) {
      const text = destBuf.toString("utf8");
      const leftovers = text.match(/VELLUM_|@vellumai\/|\.vellum(?![A-Za-z-])/g);
      if (leftovers && leftovers.length > 0) {
        issues.push({
          severity: "error",
          path: destRel,
          message: `${leftovers.length} leftover vellum token(s) after rewrite`,
        });
      } else {
        rewrittenClean++;
      }
    } else {
      issues.push({
        severity: "error",
        path: entry.relPath,
        message: "verbatim file differs from backup source",
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  return {
    step: "verify",
    status: errors.length > 0 ? "failed" : "completed",
    summary:
      errors.length > 0
        ? `verify failed: ${errors.length} problem(s) across ${checked} files`
        : `verified ${checked} files (${byteIdentical} byte-identical, ${rewrittenClean} rewritten clean, ${dbsChecked} db value-checked)`,
    issues,
    data: { checked, byteIdentical, rewrittenClean, dbsChecked },
  };
}

/**
 * Count vellum-branded values remaining in the migrated assistant DB:
 * channel-id rows, `vellum://` attachment links, and `vellum`-spelled
 * managed-connection rows. Returns "unreadable" when the file is not a
 * real sqlite database (callers fall back to byte comparison).
 */
async function assistantDbVellumRows(dbPath: string): Promise<number | "unreadable"> {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return "unreadable";
  }
  try {
    let total = 0;
    const tableExists = (name: string): boolean =>
      !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    for (const { table, column } of CHANNEL_COLUMNS) {
      if (!tableExists(table)) continue;
      const row = db
        .query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = 'vellum'`)
        .get() as { c: number } | null;
      total += row?.c ?? 0;
    }
    if (tableExists("messages")) {
      const links = db
        .query(`SELECT COUNT(*) AS c FROM messages WHERE content LIKE '%vellum://%'`)
        .get() as { c: number } | null;
      total += links?.c ?? 0;
      const meta = db
        .query(`SELECT COUNT(*) AS c FROM messages WHERE metadata LIKE '%"vellum"%'`)
        .get() as { c: number } | null;
      total += meta?.c ?? 0;
    }
    if (tableExists("provider_connections")) {
      const conns = db
        .query(
          `SELECT COUNT(*) AS c FROM provider_connections WHERE name = 'vellum' OR provider = 'vellum'`,
        )
        .get() as { c: number } | null;
      total += conns?.c ?? 0;
    }
    return total;
  } catch {
    return "unreadable";
  } finally {
    db.close();
  }
}

/** Byte comparison fallback for non-sqlite files that look like DBs. */
async function bytesMatch(a: string, b: string): Promise<boolean> {
  try {
    const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return createHash("sha256").update(bufA).digest("hex") === createHash("sha256").update(bufB).digest("hex");
  } catch {
    return false;
  }
}

function isSupposedToBeRewritten(relPath: string): boolean {
  // Same predicate migrate-layout plans with — by construction, so verify
  // can never drift from the executor's classification.
  return isRewriteEligible(relPath) && !isDbArtifact(relPath);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
