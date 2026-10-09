import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  isDbArtifact,
  isRewriteEligible,
  renameRelativePath,
  sanctionedContentTransform,
  stateRelativePath,
  walkTree,
} from "../fs-utils.js";
import { DEFAULT_TARGET_CTX, type MigrationTargetCtx } from "../layout.js";
import { openSqliteDatabase, type SqliteDatabase } from "../sqlite.js";
import {
  ASSISTANT_DB_STATE_REL,
  CHANNEL_COLUMNS,
  GATEWAY_CHANNEL_COLUMNS,
} from "./migrate-assistant-db.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * The value-migrated DBs: each is checked semantically (zero remaining
 * vellum-branded rows) instead of byte-for-byte, and their -wal/-shm sidecars
 * are expected to vanish (the open folds them in, the close checkpoints).
 * Exported so repair mode re-checks the same registry against the cadet root.
 */
export const VALUE_MIGRATED_DBS: ReadonlyArray<{
  stateRel: string;
  columns: ReadonlyArray<{ table: string; column: string }>;
  messages?: boolean;
  connections?: boolean;
}> = [
  { stateRel: ASSISTANT_DB_STATE_REL, columns: CHANNEL_COLUMNS, messages: true, connections: true },
  // Both gateway source forms (protected/ and the older data/) land at the
  // same destination, so one registry entry covers them.
  { stateRel: "protected/gateway.sqlite", columns: GATEWAY_CHANNEL_COLUMNS },
];

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
  targetCtx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): Promise<StepResult> {
  const issues: StepIssue[] = [];
  const source = await walkTree(vellumRoot);
  let checked = 0;
  let byteIdentical = 0;
  let rewrittenClean = 0;
  let dbsChecked = 0;

  for (const entry of source) {
    if (entry.isDirectory) continue;
    const stateRel = stateRelativePath(entry.relPath);

    // Retired archives are migrated by migrate-retired, optionally by
    // design — they are cold storage, not part of the live-tree guarantee,
    // and their re-tarred bytes legitimately differ from the source.
    if (stateRel === "retired" || stateRel.startsWith("retired/")) continue;

    // Value-migrated DBs are checked semantically below; their -wal/-shm
    // sidecars are folded into the main db on checkpoint and removed — their
    // absence at the destination is expected.
    const migratedDb = VALUE_MIGRATED_DBS.find(
      (d) =>
        stateRel === d.stateRel ||
        stateRel === `${d.stateRel}-wal` ||
        stateRel === `${d.stateRel}-shm`,
    );
    if (migratedDb) {
      if (stateRel !== migratedDb.stateRel) continue;
      checked++;
      const destAbs = path.join(cadetRoot, renameRelativePath(entry.relPath));
      const leftover = await dbVellumRows(destAbs, migratedDb);
      if (leftover === "unreadable") {
        // Not a real sqlite file — fall back to byte comparison (the
        // value-migration step leaves non-sqlite files verbatim).
        if (!(await bytesMatch(entry.absPath, path.join(cadetRoot, renameRelativePath(entry.relPath))))) {
          issues.push({
            severity: "error",
            path: entry.relPath,
            message: "db differs from backup source and could not be checked semantically",
          });
        } else {
          byteIdentical++;
        }
      } else if (leftover > 0) {
        issues.push({
          severity: "error",
          path: entry.relPath,
          message: `${leftover} vellum-branded row(s)/link(s) remain in ${migratedDb.stateRel}`,
        });
      } else {
        dbsChecked++;
      }
      // Sidecars vanish on checkpoint; other DB artifacts (untouched) are
      // byte-identical by construction, checked by nothing here.
      continue;
    }
    const destRel = renameRelativePath(entry.relPath);
    const destAbs = path.join(cadetRoot, destRel);

    if (!(await exists(destAbs))) {
      issues.push({ severity: "error", path: entry.relPath, message: "missing in cadet root" });
      continue;
    }
    checked++;

    // A single unreadable entry (a directory wearing a file's name, odd
    // filesystem state) must never crash the migration — it becomes a
    // warning and the run continues.
    let srcBuf: Buffer;
    let destBuf: Buffer;
    try {
      srcBuf = await fs.readFile(entry.absPath);
      destBuf = await fs.readFile(destAbs);
    } catch (err) {
      issues.push({
        severity: "warning",
        path: entry.relPath,
        message: `unreadable, skipped: ${(err as Error).message}`,
      });
      continue;
    }
    const srcHash = createHash("sha256").update(srcBuf).digest("hex");
    const destHash = createHash("sha256").update(destBuf).digest("hex");

    if (srcHash === destHash) {
      byteIdentical++;
      continue;
    }

    // Different bytes — acceptable only if the file was supposed to be
    // rewritten AND the rewrite is exactly the sanctioned transform (or, for
    // generic machine files, left no vellum tokens behind).
    if (isSupposedToBeRewritten(stateRel)) {
      // Sanctioned rewrites get a semantic check: the destination must be
      // EXACTLY the source through the shared transform — nothing else.
      // Token scans would false-positive on prose that legitimately
      // mentions vellum (skill docs, persona files, quoted messages).
      const sanctioned = sanctionedContentTransform(stateRel, srcBuf.toString("utf8"), targetCtx);
      if (sanctioned) {
        if (destBuf.toString("utf8") === sanctioned.text) {
          rewrittenClean++;
        } else {
          issues.push({
            severity: "error",
            path: entry.relPath,
            message: `${sanctioned.substep}: destination differs from the sanctioned rewrite`,
          });
        }
        continue;
      }
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
 * Count vellum-branded values remaining in a value-migrated DB: channel-id
 * rows across the db's explicit column list, plus (assistant db only)
 * `vellum://` attachment links / `vellum` JSON refs in message content and
 * `vellum`-spelled managed-connection rows. Returns "unreadable" when the
 * file is not a real sqlite database (callers fall back to byte comparison).
 */
/** Zero-vellum-rows checker, shared with repair-mode verification. */
export async function dbVellumRows(
  dbPath: string,
  spec: { columns: ReadonlyArray<{ table: string; column: string }>; messages?: boolean; connections?: boolean },
): Promise<number | "unreadable"> {
  let db: SqliteDatabase;
  try {
    db = openSqliteDatabase(dbPath, { readonly: true });
  } catch {
    return "unreadable";
  }
  try {
    let total = 0;
    const tableExists = (name: string): boolean =>
      !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    const columnExists = (table: string, column: string): boolean =>
      !!db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column);
    for (const { table, column } of spec.columns) {
      if (!tableExists(table)) continue;
      // Missing columns are known schema drift (the old product's migration
      // 120 dropped the messages channel columns), not an error — nothing to
      // check there.
      if (!columnExists(table, column)) continue;
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = 'vellum'`)
        .get() as { c: number } | null;
      total += row?.c ?? 0;
    }
    if (spec.messages && tableExists("messages")) {
      if (columnExists("messages", "content")) {
        const links = db
          .prepare(`SELECT COUNT(*) AS c FROM messages WHERE content LIKE '%vellum://%'`)
          .get() as { c: number } | null;
        total += links?.c ?? 0;
      }
      if (columnExists("messages", "metadata")) {
        const meta = db
          .prepare(`SELECT COUNT(*) AS c FROM messages WHERE metadata LIKE '%"vellum"%'`)
          .get() as { c: number } | null;
        total += meta?.c ?? 0;
      }
    }
    if (spec.connections && tableExists("provider_connections")) {
      const conns = db
        .prepare(
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
