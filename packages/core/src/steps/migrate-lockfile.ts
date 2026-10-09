import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { StepIssue, StepResult } from "../types.js";

/**
 * Legacy home-level lockfile names cadet itself no longer reads. The
 * migration moves the newest one into the canonical config-dir location so
 * an install that predates the move keeps its identity (device id,
 * assistants, tokens) without the read side carrying fallbacks.
 */
const LEGACY_LOCKFILE_NAMES = [".cadet.lock.json", ".cadet.lockfile.json"];

/**
 * The user's home dir. $HOME first (live — tests and sandboxes redirect it;
 * bun snapshots os.homedir() at boot), passwd fallback mirrors os.homedir().
 */
function homeDir(): string {
  return process.env.HOME?.trim() || os.homedir();
}

function configLockfileDir(envSuffix: string): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDir(), ".config");
  return path.join(configHome, `cadet${envSuffix}`);
}

/**
 * Move the legacy home-level cadet lockfile into the canonical config-dir
 * path. A MOVE, never a copy-then-leave: the home-level file is cadet's own
 * state file, and leaving it behind would mean two divergent copies.
 *
 * Skipped (with a warning issue) when there is nothing to move, or when the
 * canonical file already exists — overwriting live cadet state with a stale
 * home-level copy is a decision for the user, not for us.
 */
export async function migrateHomeLockfile(envSuffix: string): Promise<StepResult> {
  const issues: StepIssue[] = [];
  const destDir = configLockfileDir(envSuffix);
  const dest = path.join(destDir, "lockfile.json");

  // Newest-first: .cadet.lock.json is the modern legacy name.
  let source: string | null = null;
  for (const name of LEGACY_LOCKFILE_NAMES) {
    const candidate = path.join(homeDir(), name);
    if (await pathExists(candidate)) {
      source = candidate;
      break;
    }
  }

  if (source === null) {
    return {
      step: "migrate-lockfile",
      status: "skipped",
      summary: "no legacy home-level lockfile to move",
    };
  }

  if (await pathExists(dest)) {
    issues.push({
      severity: "warning",
      message:
        `both ${source} and ${dest} exist — left the home-level file in place; ` +
        "verify the config-dir lockfile has your assistant, then remove the stale copy manually",
    });
    return {
      step: "migrate-lockfile",
      status: "completed",
      summary: `config-dir lockfile already exists — ${source} left untouched (needs your review)`,
      issues,
      data: { source, dest, moved: false },
    };
  }

  try {
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(source, dest);
    return {
      step: "migrate-lockfile",
      status: "completed",
      summary: `moved ${source} → ${dest}`,
      data: { source, dest, moved: true },
    };
  } catch (err) {
    issues.push({
      severity: "warning",
      message:
        `could not move ${source} → ${dest} (${(err as Error).message}); move it manually to keep your assistant identity`,
    });
    return {
      step: "migrate-lockfile",
      status: "completed",
      summary: `legacy lockfile left in place — could not move it`,
      issues,
      data: { source, dest, moved: false },
    };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
