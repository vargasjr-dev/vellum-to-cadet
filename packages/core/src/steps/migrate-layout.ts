import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  applySubstitutions,
  isDbArtifact,
  isRewriteEligible,
  isUnderWorkspaceRuntime,
  isVerbatimDir,
  matchesExclude,
  renameRelativePath,
  sanctionedContentTransform,
  stateRelativePath,
  walkTree,
} from "../fs-utils.js";
import { DEFAULT_TARGET_CTX, USER_WORKSPACE_DIR, type MigrationTargetCtx } from "../layout.js";
import type { FileAction, DetectInfo, StepIssue, StepResult } from "../types.js";

/**
 * Build the full copy plan (dry-run safe — pure filesystem reads), then
 * optionally execute it. Every file gets exactly one action:
 *
 *   rewrite     — machine-owned text file: substitutions applied
 *   rename-only — text file whose *path* changed but contents are untouched
 *   verbatim    — byte-for-byte copy (user data, keys, databases, binaries)
 */
/**
 * Paths --exclude must never touch: the assistant discovery markers and
 * the lockfiles. Everything else in the verbatim category is fair game.
 */
const EXCLUDE_PROTECTED_SEGMENTS = new Set([".vellum-assistant"]);
const EXCLUDE_PROTECTED_BASENAMES = new Set([".vellum.lock.json", ".vellum.lockfile.json"]);

function isExcludeProtected(relPath: string): boolean {
  const posix = relPath.split(path.sep).join("/");
  return (
    posix.split("/").some((seg) => EXCLUDE_PROTECTED_SEGMENTS.has(seg)) ||
    EXCLUDE_PROTECTED_BASENAMES.has(posix.slice(posix.lastIndexOf("/") + 1))
  );
}

export async function buildCopyPlan(
  vellumRoot: string,
  exclude: string[] = [],
): Promise<{ actions: FileAction[]; excluded: FileAction[] }> {
  const entries = await walkTree(vellumRoot);
  const plan: FileAction[] = [];
  const excluded: FileAction[] = [];

  for (const entry of entries) {
    const destRel = renameRelativePath(entry.relPath);
    // Eligibility rules (verbatim dirs, workspace runtime, db artifacts) are
    // defined relative to the assistant state root — in the modern layout
    // that is assistants/<name>/.vellum/, which dissolves into the dest.
    const stateRel = stateRelativePath(entry.relPath);
    if (entry.isDirectory) {
      if (exclude.length > 0 && matchesExclude(entry.relPath, exclude)) {
        excluded.push({ src: entry.relPath, dest: destRel, action: "verbatim", bytes: 0 });
        continue;
      }
      plan.push({
        src: entry.relPath,
        dest: destRel,
        action: "verbatim",
        bytes: 0,
      });
      continue;
    }

    const stat = await fs.stat(entry.absPath);
    let action: FileAction["action"] = "verbatim";
    if (isRewriteEligible(stateRel) && !isDbArtifact(stateRel)) {
      action = "rewrite";
    } else if (destRel !== entry.relPath) {
      action = "rename-only";
    }

    const planned = {
      src: entry.relPath,
      dest: destRel,
      action,
      bytes: stat.size,
    };
    // --exclude only skips content-untouched files (verbatim + rename-only
    // user data, logs, caches) — never REWRITE-category structural files
    // (their transforms expect them), never the markers and lockfiles the
    // migrated assistant is built from. Removing a rewrite file would
    // break the migration; a skipped log file regrows.
    if (
      action !== "rewrite" &&
      exclude.length > 0 &&
      !isExcludeProtected(entry.relPath) &&
      matchesExclude(entry.relPath, exclude)
    ) {
      excluded.push(planned);
      continue;
    }
    plan.push(planned);
  }

  return { actions: plan, excluded };
}

export async function migrateLayout(
  detect: DetectInfo,
  timestamp: string,
  targetCtx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
  exclude: string[] = [],
): Promise<StepResult> {
  try {
    const { actions: plan, excluded } = await buildCopyPlan(detect.vellumRoot, exclude);
    const { substeps } = await execute(detect, plan, timestamp, targetCtx);

    const fileCount = plan.filter((p) => p.bytes > 0 || p.action === "verbatim").length;
    const rewrites = plan.filter((p) => p.action === "rewrite");
    const renamed = plan.filter((p) => p.dest !== p.src);
    const dbs = plan.filter((p) => isDbArtifact(stateRelativePath(p.src)));
    const runtimeData = plan.filter((p) => isUnderWorkspaceRuntime(stateRelativePath(p.src)));

    // The headline stays short; the breakdown and per-transform takeaways
    // render as nested bullets (only the ones that actually changed
    // something — "0 change(s)" lines are noise).
    const takeaways: StepIssue[] = [];

    // Instance-dir renames (vellum-<x> → <x>) can theoretically collide when
    // two source assistants collapse onto one name — never let that eat data
    // silently.
    const seenDests = new Set<string>();
    for (const p of plan) {
      if (seenDests.has(p.dest)) {
        takeaways.push({
          severity: "warning",
          message: `multiple source paths map to ${p.dest} (last copy wins) — review the migrated root`,
        });
      }
      seenDests.add(p.dest);
    }

    // --exclude: the skipped content is a user decision, but it must be
    // impossible to miss in the report.
    if (excluded.length > 0) {
      const excludedBytes = excluded.reduce((sum, e) => sum + e.bytes, 0);
      takeaways.push({
        severity: "warning",
        message: `--exclude skipped ${excluded.length} file(s) (${(excludedBytes / 1024 / 1024).toFixed(1)} MB) — they are NOT in the migrated root`,
      });
    }

    if (rewrites.length + renamed.length + dbs.length > 0) {
      takeaways.push({
        severity: "info",
        message: `${rewrites.length} rewritten, ${renamed.length} renamed, ${dbs.length} db artifact(s) verbatim`,
      });
    }
    takeaways.push(
      ...Object.entries(substeps)
        .filter(([, s]) => s.changes > 0)
        .map(
          ([name, s]): StepIssue => ({
            severity: "info",
            message: `${name}: ${s.changes} change(s) in ${s.files} file(s)`,
          }),
        ),
    );

    return {
      step: "migrate-layout",
      status: "completed",
      summary: `migrated ${fileCount} entries → ${detect.cadetRoot}`,
      issues: takeaways,
      files: plan,
      data: {
        rewritten: rewrites.length,
        renamed: renamed.length,
        dbArtifactsVerbatim: dbs.map((d) => d.src),
        workspaceRuntimeVerbatim: runtimeData.length,
        substeps,
        excluded: excluded.map((e) => ({ src: e.src, bytes: e.bytes })),
      },
    };
  } catch (err) {
    const at = errPath(err);
    return {
      step: "migrate-layout",
      status: "failed",
      summary: `migration failed: ${(err as Error).message}${at}`,
      issues: [{ severity: "error", message: `${(err as Error).message}${at}` }],
    };
  }
}

/** fs errors carry the offending path — surface it, never crash blind. */
export function errPath(err: unknown): string {
  const p = (err as NodeJS.ErrnoException | null)?.path;
  return typeof p === "string" && p.length > 0 ? ` (at ${p})` : "";
}

interface LayoutSubsteps {
  files: number;
  changes: number;
}

async function execute(
  detect: DetectInfo,
  plan: FileAction[],
  timestamp: string,
  targetCtx: MigrationTargetCtx,
): Promise<{ substeps: Record<string, LayoutSubsteps> }> {
  const cadetRoot = detect.cadetRoot;
  await fs.mkdir(cadetRoot, { recursive: true });

  // Explicit per-target accounting — each workspace case reports separately.
  const substeps: Record<string, { files: number; changes: number }> = {};
  const bump = (name: string, changes: number): void => {
    const s = (substeps[name] ??= { files: 0, changes: 0 });
    s.files++;
    s.changes += changes;
  };

  for (const f of plan) {
    const destAbs = path.join(cadetRoot, f.dest);
    if (f.bytes === 0 && f.action === "verbatim") {
      // Directory entry.
      await fs.mkdir(destAbs, { recursive: true });
      continue;
    }
    const srcAbs = path.join(detect.vellumRoot, f.src);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });

    // Guard against EISDIR: whatever the plan thought at build time, if the
    // source is a directory NOW, create it as one and move on.
    if ((await fs.stat(srcAbs)).isDirectory()) {
      await fs.mkdir(destAbs, { recursive: true });
      continue;
    }

    try {
      await copyOne(f, srcAbs, destAbs, stateRelativePath(f.src), targetCtx, bump);
    } catch (err) {
      // Annotate with the plan-relative path — indirect failures may not
      // carry the fs error's own path.
      throw new Error(`${(err as Error).message} (at ${f.src})`);
    }
    const srcStat = await fs.stat(srcAbs);
    await fs.chmod(destAbs, srcStat.mode);
  }

  await recoverLegacyBackupKey(cadetRoot);

  await preserveSymlinks(detect.vellumRoot, cadetRoot);

  // Write the migration manifest — the audit trail + idempotency marker.
  await fs.writeFile(
    path.join(cadetRoot, ".cadet-migration-manifest.json"),
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        sourceRoot: detect.vellumRoot,
        vellumVersion: detect.version,
        deploymentKind: detect.deploymentKind,
        files: plan.map((p) => ({
          src: p.src,
          dest: p.dest,
          action: p.action,
          bytes: p.bytes,
          substitutions: p.substitutions,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  void timestamp;
  return { substeps };
}

async function copyOne(
  f: FileAction,
  srcAbs: string,
  destAbs: string,
  stateRel: string,
  targetCtx: MigrationTargetCtx,
  bump: (name: string, changes: number) => void,
): Promise<void> {
  if (f.action === "rewrite") {
    const raw = await fs.readFile(srcAbs, "utf8");
    // Binary guard: rewrite-class eligibility is extension-based, and an
    // extensionless binary must never round-trip through utf-8. A decoded
    // read containing U+FFFD is invalid utf-8 — copy the bytes verbatim.
    if (raw.includes("\uFFFD")) {
      await fs.copyFile(srcAbs, destAbs);
      return;
    }
    // One shared dispatch with repair + verify: every sanctioned rewrite
    // is a named substep, everything unmapped stays generic machine-file
    // substitutions.
    const sanctioned = sanctionedContentTransform(stateRel, raw, targetCtx);
    let text: string;
    let counts: Record<string, number> = {};
    if (sanctioned) {
      text = sanctioned.text;
      counts = sanctioned.counts;
      bump(sanctioned.substep, Object.values(counts).reduce((a, b) => a + b, 0));
      for (const [name, n] of Object.entries(sanctioned.substeps ?? {})) {
        if (n > 0) bump(name, n);
      }
    } else {
      const applied = applySubstitutions(raw, targetCtx);
      text = applied.text;
      counts = applied.counts;
    }
    f.substitutions = counts;
    await fs.writeFile(destAbs, text, "utf8");
  } else {
    await fs.copyFile(srcAbs, destAbs);
  }
}

/**
 * Recover the backup encryption key from its pre-XDG workspace location
 * (vellum's migration 061 parked it at `workspace/.backup.key`; 0.12 moved
 * it into the security dir). The workspace itself is user data and stays
 * byte-for-byte, so this is a COPY, never a move — the cadet gateway reads
 * the key only from `gateway-security/backup.key`, and a re-key here would
 * make every pre-migration offsite backup unrestorable. Skipped when the
 * dissolved `protected/backup.key` already landed there.
 */
export async function recoverLegacyBackupKey(cadetRoot: string): Promise<void> {
  const source = path.join(cadetRoot, USER_WORKSPACE_DIR, ".backup.key");
  const destDir = path.join(cadetRoot, "gateway-security");
  const dest = path.join(destDir, "backup.key");
  try {
    await fs.access(source);
  } catch {
    return;
  }
  try {
    await fs.access(dest);
    return; // Dissolved protected/backup.key won — nothing to recover.
  } catch {
    // Target absent — recover.
  }
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(source, dest);
}

async function preserveSymlinks(vellumRoot: string, cadetRoot: string): Promise<void> {
  const entries = await walkTree(vellumRoot);
  void entries;
  async function visit(abs: string, rel: string): Promise<void> {
    const dirEntries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of dirEntries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(childAbs, childRel);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(childAbs);
        const destAbs = path.join(cadetRoot, renameRelativePath(childRel));
        try {
          await fs.symlink(target, destAbs);
        } catch {
          // Recorded as a miss by verify; symlink recreation is best-effort.
        }
      }
    }
  }
  await visit(vellumRoot, "");
}
