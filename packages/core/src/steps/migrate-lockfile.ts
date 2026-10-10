import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  makeInstanceDirMapper,
  transformAssistantEntry,
} from "../entry-transform.js";
import { readRawVellumLockfile } from "./detect.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * The cadet lockfile: vellum's lives at the home level (~/.vellum.lock.json)
 * and cadet reads the canonical config-dir one (~/.config/cadet/
 * lockfile.json) — so the migration CONVERTS the vellum lockfile into the
 * cadet location, with every entry transformed (brand prefixes dropped,
 * species removed, runtime urls loopback, data dirs repointed, vellum cloud
 * identity stripped). Without this the migrated install has no lockfile at
 * all: `cadet ps`/`wake --all` see nothing (v0.0.9 run feedback).
 *
 * Legacy home-level cadet lockfile names cadet itself no longer reads are
 * also moved into the canonical config-dir location so an install that
 * predates the move keeps its identity (device id, assistants, tokens)
 * without the read side carrying fallbacks.
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

export interface MigrateLockfileOptions {
  vellumRoot: string;
  cadetRoot: string;
  /** cadet env suffix for the config dir (from envSuffixFor(vellumRoot)). */
  envSuffix: string;
  /**
   * True when this run renamed instance dirs (a fresh migration) — mapped
   * data dirs follow the rename map. False on an already-migrated root,
   * where the recorded dirs are the physical ones.
   */
  applyRenames: boolean;
}

/**
 * Migrate the lockfile: convert the vellum lockfile into the cadet
 * canonical config-dir one, then move any legacy home-level cadet lockfile.
 * One step — both parts write the same destination file.
 */
export async function migrateLockfile(opts: MigrateLockfileOptions): Promise<StepResult> {
  const destDir = configLockfileDir(opts.envSuffix);
  const dest = path.join(destDir, "lockfile.json");

  const issues: StepIssue[] = [];
  const parts: string[] = [];
  const data: Record<string, unknown> = { dest };

  // ── 1. Convert the vellum lockfile into the cadet canonical lockfile. ──
  const source = await readRawVellumLockfile();
  if (source === null) {
    parts.push("no vellum lockfile found");
  } else if (await pathExists(dest)) {
    issues.push({
      severity: "warning",
      message:
        `the cadet lockfile at ${dest} already exists — the assistants recorded in ${source.path} ` +
        "were NOT merged into it; review it and merge manually if assistants are missing",
    });
    parts.push(`cadet lockfile already exists — ${source.path} not converted`);
  } else {
    const converted = convertVellumLockfile(source.data, opts);
    if (converted.assistantCount === 0) {
      parts.push(`${source.path} records no assistants — nothing to convert`);
    } else {
      try {
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(
          dest,
          JSON.stringify(converted.lockfile, null, 2) + "\n",
          "utf8",
        );
        parts.push(
          `wrote the cadet lockfile at ${dest} (${converted.assistantCount} assistant(s) from ${source.path})`,
        );
      } catch (err) {
        issues.push({
          severity: "warning",
          message: `could not write ${dest} (${(err as Error).message}) — write it manually to keep your assistants`,
        });
        parts.push("cadet lockfile could not be written");
      }
    }
    if (converted.legacyPlatformCredentials) {
      data["legacyPlatformCredentials"] = true;
    }
  }

  // ── 2. Move a legacy home-level cadet lockfile into the canonical path. ──
  const home = await moveLegacyCadetLockfile(destDir, dest);
  parts.push(home.summary);
  issues.push(...home.issues);

  const summary = parts.filter((p) => p.length > 0).join("; ");
  return { step: "migrate-lockfile", status: "completed", summary, issues, data };
}

/** Convert the raw vellum lockfile JSON into its cadet form. */
function convertVellumLockfile(
  raw: Record<string, unknown>,
  opts: MigrateLockfileOptions,
): { lockfile: Record<string, unknown>; assistantCount: number; legacyPlatformCredentials: boolean } {
  const mapInstanceDir = makeInstanceDirMapper({
    vellumRoot: opts.vellumRoot,
    cadetRoot: opts.cadetRoot,
    applyRenames: opts.applyRenames,
  });

  const rawAssistants = Array.isArray(raw.assistants) ? raw.assistants : [];
  const assistants: Record<string, unknown>[] = [];
  let legacyPlatformCredentials = false;
  for (const entry of rawAssistants) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).assistantId !== "string" ||
      ((entry as Record<string, unknown>).assistantId as string).length === 0
    ) {
      continue;
    }
    const result = transformAssistantEntry(entry as Record<string, unknown>, {
      mapInstanceDir,
      defaultInstanceDirFor: (id) => path.join(opts.cadetRoot, "assistants", id),
    });
    if (result.hadLegacyPlatformCredentials) legacyPlatformCredentials = true;
    assistants.push(result.entry);
  }

  // Unknown top-level fields ride through (cadet's parser ignores what it
  // doesn't know); the active assistant's id drops the brand prefix too.
  const lockfile: Record<string, unknown> = { ...raw, assistants };
  if (typeof raw.activeAssistant === "string" && raw.activeAssistant.length > 0) {
    lockfile.activeAssistant = raw.activeAssistant.replace(/^vellum-/, "");
  }

  return { lockfile, assistantCount: assistants.length, legacyPlatformCredentials };
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
async function moveLegacyCadetLockfile(
  destDir: string,
  dest: string,
): Promise<{ summary: string; issues: StepIssue[] }> {
  const issues: StepIssue[] = [];

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
    return { summary: "", issues };
  }

  if (await pathExists(dest)) {
    issues.push({
      severity: "warning",
      message:
        `both ${source} and ${dest} exist — left the home-level file in place; ` +
        "verify the config-dir lockfile has your assistant, then remove the stale copy manually",
    });
    return { summary: `legacy cadet lockfile left in place (${source})`, issues };
  }

  try {
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(source, dest);
    return { summary: `moved ${source} → ${dest}`, issues };
  } catch (err) {
    issues.push({
      severity: "warning",
      message:
        `could not move ${source} → ${dest} (${(err as Error).message}); move it manually to keep your assistant identity`,
    });
    return { summary: "legacy cadet lockfile left in place — could not move it", issues };
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
