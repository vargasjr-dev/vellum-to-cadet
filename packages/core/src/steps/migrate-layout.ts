import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  applySubstitutions,
  isDbArtifact,
  isRewriteEligible,
  isUnderWorkspaceRuntime,
  isVerbatimDir,
  renameRelativePath,
  stateRelativePath,
  walkTree,
} from "../fs-utils.js";
import { DEFAULT_TARGET_CTX, USER_WORKSPACE_DIR, type MigrationTargetCtx } from "../layout.js";
import type { FileAction, DetectInfo, StepResult } from "../types.js";

/**
 * Build the full copy plan (dry-run safe — pure filesystem reads), then
 * optionally execute it. Every file gets exactly one action:
 *
 *   rewrite     — machine-owned text file: substitutions applied
 *   rename-only — text file whose *path* changed but contents are untouched
 *   verbatim    — byte-for-byte copy (user data, keys, databases, binaries)
 */
export async function buildCopyPlan(vellumRoot: string): Promise<FileAction[]> {
  const entries = await walkTree(vellumRoot);
  const plan: FileAction[] = [];

  for (const entry of entries) {
    const destRel = renameRelativePath(entry.relPath);
    // Eligibility rules (verbatim dirs, workspace runtime, db artifacts) are
    // defined relative to the assistant state root — in the modern layout
    // that is assistants/<name>/.vellum/, which dissolves into the dest.
    const stateRel = stateRelativePath(entry.relPath);
    if (entry.isDirectory) {
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

    plan.push({
      src: entry.relPath,
      dest: destRel,
      action,
      bytes: stat.size,
    });
  }

  return plan;
}

export async function migrateLayout(
  detect: DetectInfo,
  timestamp: string,
  targetCtx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): Promise<StepResult> {
  try {
    const plan = await buildCopyPlan(detect.vellumRoot);
    await execute(detect, plan, timestamp, targetCtx);

    const fileCount = plan.filter((p) => p.bytes > 0 || p.action === "verbatim").length;
    const rewrites = plan.filter((p) => p.action === "rewrite");
    const renamed = plan.filter((p) => p.dest !== p.src);
    const dbs = plan.filter((p) => isDbArtifact(stateRelativePath(p.src)));
    const runtimeData = plan.filter((p) => isUnderWorkspaceRuntime(stateRelativePath(p.src)));

    return {
      step: "migrate-layout",
      status: "completed",
      summary: `migrated ${fileCount} entries → ${detect.cadetRoot} (${rewrites.length} rewritten, ${renamed.length} renamed, ${dbs.length} db artifact(s) verbatim)`,
      files: plan,
      data: {
        rewritten: rewrites.length,
        renamed: renamed.length,
        dbArtifactsVerbatim: dbs.map((d) => d.src),
        workspaceRuntimeVerbatim: runtimeData.length,
      },
    };
  } catch (err) {
    return {
      step: "migrate-layout",
      status: "failed",
      summary: `migration failed: ${(err as Error).message}`,
      issues: [{ severity: "error", message: (err as Error).message }],
    };
  }
}

async function execute(
  detect: DetectInfo,
  plan: FileAction[],
  timestamp: string,
  targetCtx: MigrationTargetCtx,
): Promise<void> {
  const cadetRoot = detect.cadetRoot;
  await fs.mkdir(cadetRoot, { recursive: true });

  for (const f of plan) {
    const destAbs = path.join(cadetRoot, f.dest);
    if (f.bytes === 0 && f.action === "verbatim") {
      // Directory entry.
      await fs.mkdir(destAbs, { recursive: true });
      continue;
    }
    const srcAbs = path.join(detect.vellumRoot, f.src);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });

    if (f.action === "rewrite") {
      const raw = await fs.readFile(srcAbs, "utf8");
      const { text, counts } = applySubstitutions(raw, targetCtx);
      f.substitutions = counts;
      await fs.writeFile(destAbs, text, "utf8");
    } else {
      await fs.copyFile(srcAbs, destAbs);
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
