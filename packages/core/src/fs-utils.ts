import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  DB_EXTENSIONS,
  PATH_MOVES,
  PATH_RENAMES,
  REWRITE_EXACT_NAMES,
  REWRITE_EXTENSIONS,
  TEXT_SUBSTITUTIONS,
  USER_WORKSPACE_DIR,
  VERBATIM_DIRS,
  WORKSPACE_RUNTIME_DIR,
  dissolveProtectedDir,
} from "./layout.js";
import type { FileAction } from "./types.js";

/** Rename a single path segment (file or directory name). */
export function renameSegment(name: string): string {
  let out = name;
  for (const r of PATH_RENAMES) {
    if (out === r.from) {
      out = r.to;
      break;
    }
  }
  return out;
}

/**
 * The modern multi-instance layout keeps each assistant's state at
 * `assistants/<name>/.vellum/...`. Cadet flattens state into the instance
 * dir (`assistants/<name>/workspace`, …), so the `.vellum` level dissolves
 * in the destination path. A no-op for legacy single-root trees, which
 * never had this shape.
 */
export function dissolveInstanceState(relPath: string): string {
  const m = relPath.match(/^(assistants\/[^/]+)\/\.vellum(\/|$)/);
  if (!m) return relPath;
  return `${m[1]}${m[2]}${relPath.slice(m[0].length)}`;
}

/**
 * Path relative to the assistant state root — for layout-agnostic rules
 * (verbatim dirs, workspace runtime, db artifacts). Legacy paths are their
 * own state-relative form.
 */
export function stateRelativePath(relPath: string): string {
  const m = relPath.match(/^assistants\/[^/]+\/\.vellum(\/|$)/);
  return m ? relPath.slice(m[0].length) : relPath;
}

/**
 * Whole-path remap for state-root gateway state (see PATH_MOVES). Matched
 * against the state-relative form (instance prefix stripped) so the modern
 * per-instance layout (`assistants/<name>/.vellum/data/gateway.sqlite`)
 * maps the same as the legacy single-root one, with the prefix re-applied.
 */
export function applyPathMoves(stateRel: string): string | null {
  const norm = stateRel.split("\\").join("/");
  const m = norm.match(/^(assistants\/[^/]+\/)(.+)$/);
  const rel = m ? m[2] : norm;
  for (const move of PATH_MOVES) {
    if (rel === move.from) return (m ? m[1] : "") + move.to;
  }
  return null;
}

/** Apply the full rename map to a relative path, segment by segment. */
export function renameRelativePath(relPath: string): string {
  const stateRel = dissolveInstanceState(relPath);
  const moved = applyPathMoves(stateRel);
  if (moved) return moved;
  return dissolveProtectedDir(
    stateRel
      .split("/")
      .map(renameSegment)
      .join("/"),
  );
}

export function extensionOf(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isRewriteEligible(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  // Never rewrite the user-facing workspace or protected keys.
  if (norm === USER_WORKSPACE_DIR || norm.startsWith(`${USER_WORKSPACE_DIR}/`)) return false;
  for (const dir of VERBATIM_DIRS) {
    if (norm === dir || norm.startsWith(`${dir}/`)) return false;
  }
  const base = path.basename(norm);
  if (REWRITE_EXACT_NAMES.has(base)) return true;
  return REWRITE_EXTENSIONS.has(extensionOf(base));
}

export function isVerbatimDir(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return VERBATIM_DIRS.some((d) => norm === d || norm.startsWith(`${d}/`));
}

export function isDbArtifact(relPath: string): boolean {
  return DB_EXTENSIONS.has(extensionOf(relPath));
}

export function isUnderWorkspaceRuntime(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return norm.startsWith(`${USER_WORKSPACE_DIR}/${WORKSPACE_RUNTIME_DIR}/`);
}

/** Apply every text substitution, returning the new content and per-name counts. */
export function applySubstitutions(
  content: string,
): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let text = content;
  for (const sub of TEXT_SUBSTITUTIONS) {
    text = text.replace(sub.pattern, (...args) => {
      counts[sub.name] = (counts[sub.name] ?? 0) + 1;
      const matched = args[0] as string;
      if (typeof sub.replace === "function") {
        return (sub.replace as (m: string) => string)(matched);
      }
      return sub.replace;
    });
  }
  return { text, counts };
}

export interface WalkEntry {
  absPath: string;
  relPath: string;
  isDirectory: boolean;
}

/** Depth-first walk of a tree, directories before their contents. */
export async function walkTree(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  async function visit(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ absPath: childAbs, relPath: childRel, isDirectory: true });
        await visit(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push({ absPath: childAbs, relPath: childRel, isDirectory: false });
      }
      // Symlinks: preserved by copy below via link(); skipped in the walk.
    }
  }
  await visit(root, "");
  return out;
}

/** Recursively size a tree in bytes (files only). */
export async function treeSize(root: string): Promise<number> {
  let total = 0;
  const entries = await walkTree(root);
  for (const e of entries) {
    if (!e.isDirectory) {
      total += (await fs.stat(e.absPath)).size;
    }
  }
  return total;
}

export async function sha256File(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Execute a planned migration: create the cadet root, copy every planned file
 * (verbatim or rewritten), recreate symlinks, and preserve executable bits.
 */
export async function executeCopyPlan(
  vellumRoot: string,
  cadetRoot: string,
  plan: FileAction[],
  log: (msg: string) => void = () => {},
): Promise<void> {
  await fs.mkdir(cadetRoot, { recursive: true });

  // Directories first (plan includes every directory entry).
  const dirs = new Set<string>();
  for (const f of plan) {
    const destAbs = path.join(cadetRoot, f.dest);
    dirs.add(path.dirname(destAbs));
  }
  for (const d of [...dirs].sort()) {
    await fs.mkdir(d, { recursive: true });
  }

  for (const f of plan) {
    const srcAbs = path.join(vellumRoot, f.src);
    const destAbs = path.join(cadetRoot, f.dest);

    if (f.action === "rewrite") {
      const raw = await fs.readFile(srcAbs, "utf8");
      const { text, counts } = applySubstitutions(raw);
      await fs.writeFile(destAbs, text, "utf8");
      f.substitutions = counts;
    } else {
      await fs.copyFile(srcAbs, destAbs);
    }

    // Preserve mode (executable bits on hook scripts etc.).
    const srcStat = await fs.stat(srcAbs);
    await fs.chmod(destAbs, srcStat.mode);
  }

  // Symlinks inside the tree (not part of the walk): recreate by name.
  const symlinks = await collectSymlinks(vellumRoot);
  for (const s of symlinks) {
    const destAbs = path.join(cadetRoot, renameRelativePath(s.relPath));
    try {
      const target = await fs.readlink(s.absPath);
      await fs.symlink(target, destAbs);
      log(`symlink ${s.relPath} → ${target}`);
    } catch (err) {
      log(`symlink ${s.relPath}: ${(err as Error).message}`);
    }
  }
}

async function collectSymlinks(root: string): Promise<Array<{ absPath: string; relPath: string }>> {
  const out: Array<{ absPath: string; relPath: string }> = [];
  async function visit(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(childAbs, childRel);
      } else if (entry.isSymbolicLink()) {
        out.push({ absPath: childAbs, relPath: childRel });
      }
    }
  }
  await visit(root, "");
  return out;
}
