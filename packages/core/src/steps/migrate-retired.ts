import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  isDbArtifact,
  isRewriteEligible,
  sanctionedContentTransform,
  stateRelativePath,
  walkTree,
} from "../fs-utils.js";
import { DEFAULT_TARGET_CTX, type MigrationTargetCtx } from "../layout.js";
import type { StepIssue, StepItemEvent, StepResult } from "../types.js";
import {
  isGatewayDbStateRel,
  migrateAssistantDbAt,
  migrateGatewayDbAt,
} from "./migrate-assistant-db.js";

const execFile = promisify(execFileCb);

/**
 * Retired-assistant archives (`retired/<name>.tar.gz`, plus the
 * `<name>.tar.gz.tmp` scratch trees an interrupted retire leaves behind)
 * ride along in the vellum root and land in the cadet root verbatim. They hold the same
 * vellum-branded paths, tokens, and dbs as the live tree, so each one is
 * untarred, run through the same assistant-logic migration, and re-tarred.
 *
 * Success here is OPTIONAL by design: a retired archive is cold storage,
 * not a live assistant. Any archive that fails (corrupt tar, unreadable
 * entries, unsupported layout) is reported as a warning and left exactly
 * as it was — the migration never fails because of one.
 */

const TMP_SUFFIX = ".tar.gz.tmp";

/** Archive inventory: finished tars + leftover scratch trees. */
interface RetiredTarget {
  name: string;
  tarPath: string | null;
  scratchPath: string | null;
  /** We created the scratch dir this run — safe to remove on failure. */
  scratchIsOurs: boolean;
}

export async function migrateRetiredArchives(
  cadetRoot: string,
  targetCtx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
  onItem?: (item: StepItemEvent) => void,
): Promise<StepResult> {
  const step = "migrate-retired";
  const retiredDir = path.join(cadetRoot, "retired");
  let entries;
  try {
    entries = await fs.readdir(retiredDir, { withFileTypes: true });
  } catch {
    return { step, status: "skipped", summary: "no retired directory in the migrated root" };
  }

  const targets: RetiredTarget[] = [];
  // Leftover scratch trees first (an interrupted retire, or a scratch dir
  // from an earlier run of this step): they may be the only extracted copy,
  // so they are migrated before any tar overwrites the scratch location,
  // and finished into a tar when none ever landed.
  for (const entry of entries) {
    if (!(entry.isDirectory() && entry.name.endsWith(TMP_SUFFIX))) continue;
    const name = entry.name.slice(0, -TMP_SUFFIX.length);
    const tarPath = path.join(retiredDir, `${name}.tar.gz`);
    targets.push({
      name,
      tarPath: (await fileExists(tarPath)) ? tarPath : null,
      scratchPath: path.join(retiredDir, entry.name),
      scratchIsOurs: false,
    });
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".tar.gz")) {
      const name = entry.name.slice(0, -".tar.gz".length);
      const existing = targets.find((t) => t.name === name);
      if (existing) {
        existing.tarPath = path.join(retiredDir, entry.name);
        continue;
      }
      targets.push({
        name,
        tarPath: path.join(retiredDir, entry.name),
        scratchPath: null,
        scratchIsOurs: false,
      });
    }
  }

  if (targets.length === 0) {
    return { step, status: "skipped", summary: "no retired archives to migrate" };
  }

  const issues: StepIssue[] = [];
  let migrated = 0;
  let failed = 0;
  let contentChanges = 0;
  let dbRows = 0;

  for (const target of targets) {
    onItem?.({ name: target.name, status: "started" });
    try {
      const result = await migrateOneArchive(retiredDir, target, targetCtx, issues);
      migrated++;
      contentChanges += result.contentChanges;
      dbRows += result.dbRows;
      onItem?.({
        name: target.name,
        status: "completed",
        summary:
          result.contentChanges > 0 || result.dbRows > 0
            ? `migrated (${result.contentChanges} content change(s), ${result.dbRows} db row(s))`
            : "migrated",
      });
    } catch (err) {
      failed++;
      onItem?.({ name: target.name, status: "warning", summary: "left as-is" });
      issues.push({
        severity: "warning",
        message: `retired archive '${target.name}': ${(err as Error).message}${truncationHint(err)} — left as-is, continuing`,
      });
      // Our scratch dir goes; anything pre-existing stays untouched.
      if (target.scratchIsOurs && target.scratchPath) {
        await fs.rm(target.scratchPath, { recursive: true, force: true });
      }
    }
  }

  const summary =
    failed > 0
      ? `retired archives: ${migrated} migrated, ${failed} left as-is`
      : `retired archives: ${migrated} migrated (${contentChanges} content change(s), ${dbRows} db row(s))`;
  return { step, status: "completed", summary, issues, data: { migrated, failed, contentChanges, dbRows } };
}

/** Explain a truncated gzip stream: the archive was never fully written. */
function truncationHint(err: unknown): string {
  return /truncated gzip|unexpected end of file/i.test((err as Error).message)
    ? " — the archive looks truncated (an interrupted retire never finished writing it; the data past that point is unrecoverable)"
    : "";
}

async function migrateOneArchive(
  retiredDir: string,
  target: RetiredTarget,
  ctx: MigrationTargetCtx,
  issues: StepIssue[],
): Promise<{ contentChanges: number; dbRows: number }> {
  const scratchPath = path.join(retiredDir, `${target.name}${TMP_SUFFIX}`);

  // No finished tar = an interrupted retire: the leftover tree IS the
  // archive-in-progress — migrate it and finish the tar.
  if (!target.tarPath) {
    const result = await migrateExtractedTree(target.scratchPath!, ctx, issues);
    const tarOut = path.join(retiredDir, `${target.name}.tar.gz`);
    await execFile("tar", ["-czf", tarOut, "-C", target.scratchPath!, "."]);
    await fs.rm(target.scratchPath!, { recursive: true, force: true });
    return result;
  }

  // Finished tar: extract, migrate the tree, re-tar atomically (a failed
  // re-tar must never destroy the original), clean up.
  await fs.rm(scratchPath, { recursive: true, force: true });
  target.scratchPath = scratchPath;
  target.scratchIsOurs = true;
  await fs.mkdir(scratchPath, { recursive: true });
  await execFile("tar", ["-xzf", target.tarPath, "-C", scratchPath]);

  const result = await migrateExtractedTree(scratchPath, ctx, issues);

  const tarNew = `${target.tarPath}.new`;
  await execFile("tar", ["-czf", tarNew, "-C", scratchPath, "."]);
  await fs.rename(tarNew, target.tarPath);
  await fs.rm(scratchPath, { recursive: true, force: true });
  return result;
}

/** Run the live-tree migration logic over an extracted archive, in place. */
async function migrateExtractedTree(
  treeRoot: string,
  ctx: MigrationTargetCtx,
  issues: StepIssue[],
): Promise<{ contentChanges: number; dbRows: number }> {
  const tree = await walkTree(treeRoot);
  let contentChanges = 0;
  let dbRows = 0;

  for (const entry of tree) {
    if (entry.isDirectory) continue;
    const stateRel = stateRelativePath(entry.relPath);

    // dbs: same value migration as the live tree, aimed at this tree.
    if (isDbArtifact(stateRel)) {
      const isAssistantDb = stateRel === "workspace/data/db/assistant.db";
      const isGatewayDb = isGatewayDbStateRel(stateRel.replace(/^workspace\//, ""));
      if (!isAssistantDb && !isGatewayDb) continue;
      const result = isAssistantDb
        ? await migrateAssistantDbAt(treeRoot, entry.relPath)
        : await migrateGatewayDbAt(treeRoot, entry.relPath);
      dbRows += countDbRows(result);
      for (const issue of result.issues ?? []) {
        issues.push({ ...issue, message: `${entry.relPath}: ${issue.message}` });
      }
      continue;
    }

    // Content: same sanctioned rewrites as the live tree.
    if (!isRewriteEligible(stateRel)) continue;
    try {
      const raw = await fs.readFile(entry.absPath, "utf8");
      const sanctioned = sanctionedContentTransform(stateRel, raw, ctx);
      if (!sanctioned) continue;
      const total = Object.values(sanctioned.counts).reduce((a, b) => a + b, 0);
      if (total > 0) {
        await fs.writeFile(entry.absPath, sanctioned.text, "utf8");
        contentChanges += total;
      }
    } catch (err) {
      issues.push({
        severity: "warning",
        message: `${entry.relPath}: ${(err as Error).message} — skipped, continuing`,
      });
    }
  }
  return { contentChanges, dbRows };
}

/** Total rows a migrateDbValues result reports across its substeps. */
function countDbRows(result: StepResult): number {
  const substeps = (result.data as { substeps?: Record<string, number> } | undefined)?.substeps;
  if (!substeps) return 0;
  return Object.values(substeps).reduce((a, b) => a + b, 0);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
