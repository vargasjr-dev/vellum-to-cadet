import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { walkTree } from "../fs-utils.js";
import type { StepResult } from "../types.js";

/**
 * Full byte-for-byte backup of the vellum root before any mutation.
 * The backup lives OUTSIDE both roots, in a timestamped sibling directory,
 * with a sha256 manifest so verify and rollback have ground truth.
 */
export function backupDirFor(vellumRoot: string, timestamp: string): string {
  const parent = path.dirname(vellumRoot);
  return path.join(parent, `.vellum-migration-backups`, timestamp);
}

export async function backup(vellumRoot: string, timestamp: string): Promise<StepResult> {
  const backupRoot = backupDirFor(vellumRoot, timestamp);
  try {
    const entries = await walkTree(vellumRoot);
    let fileCount = 0;
    let dirCount = 0;
    let byteCount = 0;

    await fs.mkdir(backupRoot, { recursive: true });

    const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];

    for (const entry of entries) {
      const dest = path.join(backupRoot, entry.relPath);
      if (entry.isDirectory) {
        await fs.mkdir(dest, { recursive: true });
        dirCount++;
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const buf = await fs.readFile(entry.absPath);
      await fs.writeFile(dest, buf);
      const stat = await fs.stat(entry.absPath);
      await fs.chmod(dest, stat.mode);
      manifestFiles.push({
        path: entry.relPath,
        bytes: buf.byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
      });
      fileCount++;
      byteCount += buf.byteLength;
    }

    // Symlinks preserved by name.
    const symlinkManifest: string[] = [];
    await preserveSymlinks(vellumRoot, backupRoot, symlinkManifest);

    await fs.writeFile(
      path.join(backupRoot, "manifest.json"),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          sourceRoot: vellumRoot,
          fileCount,
          dirCount,
          byteCount,
          files: manifestFiles,
          symlinks: symlinkManifest,
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      step: "backup",
      status: "completed",
      summary: `backed up ${fileCount} files (${(byteCount / 1_000_000).toFixed(1)}MB) → ${backupRoot}`,
      data: { backupRoot, fileCount, byteCount },
    };
  } catch (err) {
    return {
      step: "backup",
      status: "failed",
      summary: `backup failed: ${(err as Error).message}`,
      issues: [{ severity: "error", message: (err as Error).message }],
    };
  }
}

async function preserveSymlinks(root: string, backupRoot: string, manifest: string[]): Promise<void> {
  async function visit(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(childAbs, childRel);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(childAbs);
        const dest = path.join(backupRoot, childRel);
        try {
          await fs.symlink(target, dest);
          manifest.push(`${childRel} → ${target}`);
        } catch {
          // Best effort — the manifest records the miss.
          manifest.push(`${childRel} → ${target} (FAILED)`);
        }
      }
    }
  }
  await visit(root, "");
}
