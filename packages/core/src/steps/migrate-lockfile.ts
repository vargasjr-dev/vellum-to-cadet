import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  makeInstanceDirMapper,
  transformAssistantEntry,
} from "../entry-transform.js";
import { readRawVellumLockfile } from "../discover.js";
import {
  adoptExistingPorts,
  declashEntryPorts,
  rewriteRuntimeUrlPort,
} from "../port-declash.js";
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
 * Ports are the one raw-preserving ride-through the migration UNDONE: a
 * vellum entry's recorded ports were the ones the vellum assistant bound,
 * and a user keeping the vellum install (running it alongside cadet, or
 * letting it auto-start after a reboot) had two assistants competing for
 * the same gateway/daemon ports. Every converted assistant therefore gets
 * FRESH ports (port-declash.ts) — the vellum port space is left to vellum.
 * Re-runs adopt an existing same-id entry's ports instead, so healing the
 * lockfile never churns the ports of an already-migrated assistant.
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

/** The vellum config dir for the same env — the guardian tokens' source. */
function vellumConfigDir(envSuffix: string): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDir(), ".config");
  return path.join(configHome, `vellum${envSuffix}`);
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
  /**
   * The cadet docker image refs for the installed cadet CLI — written into
   * docker entries' containerInfo (never the vellum images). Null when the
   * cadet CLI could not be installed/asked; the digests are stripped
   * regardless.
   */
  cadetImages?: { assistant: string; gateway: string; credentialExecutor: string } | null;
  /**
   * WHY cadetImages is null (binary missing vs unparsable `cadet --version`
   * output) — the docker-image-refs warning names it instead of a vague
   * "unavailable" (field QA: the warning fired while a working cadet printed
   * a version the old parser couldn't read, with no reason shown).
   */
  cadetVersionUnavailableReason?: string;
  /**
   * Bind probe for the port de-clash; a port is allocatable when this
   * resolves true. Tests inject a deterministic probe — production uses
   * the real 0.0.0.0 bind (port-declash.ts).
   */
  isPortFree?: (port: number) => Promise<boolean>;
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
    // MERGE-AND-REPLACE (v0.0.15 field feedback: "should absolutely merge
    // in and replace"). The cadet lockfile is live state — its root
    // fields (device identity, tokens) and its own assistants are KEPT;
    // every converted vellum entry UPSERTS by assistantId, replacing any
    // same-id entry wholesale. Re-runs heal the lockfile too: the
    // migrated assistants land even when a previous run skipped here.
    const converted = convertVellumLockfile(source.data, opts);
    if (converted.assistantCount === 0) {
      parts.push(`${source.path} records no assistants — nothing to merge`);
    } else {
      try {
        const destRaw = JSON.parse(await fs.readFile(dest, "utf8")) as Record<string, unknown>;
        const destAssistants = Array.isArray(destRaw.assistants)
          ? destRaw.assistants.filter(
              (e): e is Record<string, unknown> =>
                typeof e === "object" && e !== null && !Array.isArray(e),
            )
          : [];
        const convertedIds = new Set(
          converted.assistants
            .map((e) => e.assistantId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        );
        const survivors = destAssistants.filter(
          (e) => !(
            typeof e.assistantId === "string" && convertedIds.has(e.assistantId)
          ),
        );
        const existingById = new Map(
          destAssistants
            .filter(
              (e): e is Record<string, unknown> & { assistantId: string } =>
                typeof e.assistantId === "string" && convertedIds.has(e.assistantId),
            )
            .map((e) => [e.assistantId, e]),
        );
        const declashSummary = await declashConvertedAssistants(
          converted.assistants,
          survivors,
          existingById,
          opts,
          issues,
        );
        if (declashSummary) parts.push(declashSummary);
        const merged = [...survivors, ...converted.assistants];
        const lockfile: Record<string, unknown> = { ...destRaw, assistants: merged };
        // Active assistant: the cadet lockfile's choice stands; only a
        // lockfile without one inherits the vellum pick (brand prefix
        // stripped, same rule the fresh conversion applies).
        const convertedActive = converted.lockfile.activeAssistant;
        if (typeof lockfile.activeAssistant !== "string" && typeof convertedActive === "string") {
          lockfile.activeAssistant = convertedActive;
        }
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(dest, JSON.stringify(lockfile, null, 2) + "\n", "utf8");
        parts.push(
          `merged ${converted.assistantCount} assistant(s) from ${source.path} into the cadet lockfile at ${dest}`,
        );
      } catch (err) {
        issues.push({
          severity: "warning",
          message: `the cadet lockfile at ${dest} could not be merged (${(err as Error).message}) — merge the assistants from ${source.path} manually`,
        });
        parts.push("cadet lockfile exists — merge failed");
      }
    }
    if (converted.legacyPlatformCredentials) {
      data["legacyPlatformCredentials"] = true;
    }
    if (converted.dockerImagesUnresolved) {
      issues.push({
        severity: "warning",
        message:
          `docker assistant(s) kept their vellum image refs — ${
            opts.cadetVersionUnavailableReason ?? "the cadet CLI version was unavailable to resolve cadet's"
          }. Wake will fail until \`cadet hatch\` or \`cadet upgrade\` refreshes them.`,
      });
    }
  } else {
    const converted = convertVellumLockfile(source.data, opts);
    if (converted.assistantCount === 0) {
      parts.push(`${source.path} records no assistants — nothing to convert`);
    } else {
      const declashSummary = await declashConvertedAssistants(
        converted.assistants,
        [],
        null,
        opts,
        issues,
      );
      if (declashSummary) parts.push(declashSummary);
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
    if (converted.dockerImagesUnresolved) {
      issues.push({
        severity: "warning",
        message:
          `docker assistant(s) kept their vellum image refs — ${
            opts.cadetVersionUnavailableReason ?? "the cadet CLI version was unavailable to resolve cadet's"
          }. Wake will fail until \`cadet hatch\` or \`cadet upgrade\` refreshes them.`,
      });
    }
  }

  // ── 2. Move a legacy home-level cadet lockfile into the canonical path. ──
  const home = await moveLegacyCadetLockfile(destDir, dest);
  parts.push(home.summary);
  issues.push(...home.issues);

  // ── 3. Guardian tokens: the vellum config dir's per-assistant state. ──
  const tokens = await migrateGuardianTokens(opts, destDir, issues);
  if (tokens) parts.push(tokens);

  const summary = parts.filter((p) => p.length > 0).join("; ");
  return { step: "migrate-lockfile", status: "completed", summary, issues, data };
}

/** The `resources` port fields the port de-clash reasons about. */
const RESOURCE_PORT_FIELDS = [
  "daemonPort",
  "gatewayPort",
  "qdrantPort",
  "cesPort",
] as const;

/** The numeric resource ports an entry records — the de-clash's claim book. */
function recordedResourcePorts(entry: Record<string, unknown>): number[] {
  const resources = entry.resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
    return [];
  }
  const ports: number[] = [];
  for (const field of RESOURCE_PORT_FIELDS) {
    const value = (resources as Record<string, unknown>)[field];
    if (typeof value === "number") ports.push(value);
  }
  return ports;
}

function describePortMoves(moves: { field: string; from: number; to: number }[]): string {
  return moves
    .map((m) => `${m.field.replace(/Port$/, "")} ${m.from} → ${m.to}`)
    .join(", ");
}

/**
 * The port de-clash pass over the converted entries: every entry new to the
 * cadet lockfile gets FRESH ports (the vellum port space is left to vellum —
 * a user keeping the vellum install running alongside cadet must not have
 * the two competing for the same gateway/daemon ports), while an entry the
 * cadet lockfile already records (a re-run healing the lockfile) ADOPTS its
 * existing ports — an already-migrated assistant, possibly awake, never has
 * its ports churned out from under it. Mutates the entries in place; the
 * callers write them right after. A port-walk exhaustion (100-port window
 * gone) warns and leaves that entry's remaining ports as recorded — cadet's
 * wake reports the conflict when it actually binds.
 */
async function declashConvertedAssistants(
  assistants: Record<string, unknown>[],
  survivors: Record<string, unknown>[],
  existingById: Map<string, Record<string, unknown>> | null,
  opts: MigrateLockfileOptions,
  issues: StepIssue[],
): Promise<string> {
  const claimed = new Set<number>();
  for (const survivor of survivors) {
    for (const port of recordedResourcePorts(survivor)) claimed.add(port);
  }

  let movedAssistants = 0;
  let adoptedAssistants = 0;
  for (const entry of assistants) {
    const id = typeof entry.assistantId === "string" ? entry.assistantId : null;
    const existing =
      id !== null && existingById !== null ? (existingById.get(id) ?? null) : null;

    if (existing) {
      const adopted = adoptExistingPorts(entry, existing);
      if (adopted !== null) {
        adoptedAssistants += 1;
        for (const port of recordedResourcePorts(entry)) claimed.add(port);
        if (adopted.gatewayPort !== null && typeof entry.runtimeUrl === "string") {
          entry.runtimeUrl = rewriteRuntimeUrlPort(entry.runtimeUrl, adopted.gatewayPort);
        }
        try {
          const result = await declashEntryPorts(entry, {
            envSuffix: opts.envSuffix,
            claimed,
            isPortFree: opts.isPortFree,
            keepFields: new Set(adopted.fields),
          });
          if (result && result.moves.length > 0) {
            movedAssistants += 1;
            issues.push({
              severity: "info",
              message: `${entry.assistantId}: kept its existing cadet ports, allocated fresh ones for the rest (${describePortMoves(result.moves)})`,
            });
          }
        } catch (err) {
          issues.push({
            severity: "warning",
            message: `${entry.assistantId}: could not finish the port de-clash (${(err as Error).message}) — its remaining recorded ports ride through unchanged, and \`cadet wake\` reports any conflict when it binds`,
          });
        }
        for (const port of recordedResourcePorts(entry)) claimed.add(port);
        continue;
      }
    }

    try {
      const result = await declashEntryPorts(entry, {
        envSuffix: opts.envSuffix,
        claimed,
        isPortFree: opts.isPortFree,
      });
      if (result && result.moves.length > 0) {
        movedAssistants += 1;
        issues.push({
          severity: "info",
          message: `${entry.assistantId}: allocated fresh ports (${describePortMoves(result.moves)}) — the vellum install keeps its port space`,
        });
      }
    } catch (err) {
      issues.push({
        severity: "warning",
        message: `${entry.assistantId}: could not allocate fresh ports (${(err as Error).message}) — its recorded ports ride through unchanged, and \`cadet wake\` reports any conflict when it binds`,
      });
    }
    for (const port of recordedResourcePorts(entry)) claimed.add(port);
  }

  const parts: string[] = [];
  if (movedAssistants > 0) {
    parts.push(`allocated fresh ports for ${movedAssistants} assistant(s)`);
  }
  if (adoptedAssistants > 0) {
    parts.push(`kept existing ports for ${adoptedAssistants} already-migrated assistant(s)`);
  }
  return parts.join("; ");
}

/**
 * Vellum-runtime root fields that must NOT ride into the cadet lockfile
 * (v0.0.10 run feedback: the converted lockfile carried them all). They
 * describe the VELLUM install's upgrade state — cadet's own upgrade
 * machinery writes its own from scratch, and inheriting vellum's makes
 * cadet believe it has a deployed service group it has never deployed:
 * the rollback fields (previous*), the db/workspace migration watermarks,
 * and the vellum service-group version pin.
 */
const VELLUM_ROOT_FIELDS_TO_DROP: ReadonlyArray<string> = [
  "serviceGroupVersion",
  "previousServiceGroupVersion",
  "previousContainerInfo",
  "version",
  "previousDbMigrationVersion",
  "previousWorkspaceMigrationId",
];

/** Convert the raw vellum lockfile JSON into its cadet form. */
function convertVellumLockfile(
  raw: Record<string, unknown>,
  opts: MigrateLockfileOptions,
): {
  lockfile: Record<string, unknown>;
  /** The converted entries, top-level for the existing-lockfile merge. */
  assistants: Record<string, unknown>[];
  assistantCount: number;
  legacyPlatformCredentials: boolean;
  dockerImagesUnresolved: boolean;
} {
  const mapInstanceDir = makeInstanceDirMapper({
    vellumRoot: opts.vellumRoot,
    cadetRoot: opts.cadetRoot,
    applyRenames: opts.applyRenames,
  });

  const rawAssistants = Array.isArray(raw.assistants) ? raw.assistants : [];
  const assistants: Record<string, unknown>[] = [];
  let legacyPlatformCredentials = false;
  let dockerImagesUnresolved = false;
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
      cadetImages: opts.cadetImages ?? undefined,
    });
    if (result.hadLegacyPlatformCredentials) legacyPlatformCredentials = true;
    if (result.dockerImagesUnresolved) dockerImagesUnresolved = true;
    assistants.push(result.entry);
  }

  // Known-good root fields ride through (device identity, tokens, whatever
  // cadet's parser reads); the vellum-runtime upgrade bookkeeping does not.
  const lockfile: Record<string, unknown> = { ...raw, assistants };
  for (const field of VELLUM_ROOT_FIELDS_TO_DROP) {
    delete lockfile[field];
  }
  if (typeof raw.activeAssistant === "string" && raw.activeAssistant.length > 0) {
    lockfile.activeAssistant = raw.activeAssistant.replace(/^vellum-/, "");
  }

  return {
    lockfile,
    assistants,
    assistantCount: assistants.length,
    legacyPlatformCredentials,
    dockerImagesUnresolved,
  };
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

/**
 * Copy the vellum config dir's per-assistant guardian tokens into cadet's.
 * `$XDG_CONFIG_HOME/vellum[-env]/assistants/<id>/guardian-token.json` lives
 * OUTSIDE every vellum root — docker-only installs (all their heavy data in
 * docker volumes) never create the data root at all — so this lockfile step
 * is the one place that knows both the source ids and the converted ones.
 * Cadet reads the identical shape from its own config dir
 * (`$XDG_CONFIG_HOME/cadet[-env]/assistants/<assistantId>/guardian-token.json`,
 * mycadet-temp cli/src/lib/guardian-token.ts) — without the copy, `cadet
 * client` after a completed migration 401s (field QA). COPY, never move:
 * the vellum token stays as the untouched backup, and re-runs re-copy
 * idempotently.
 */
async function migrateGuardianTokens(
  opts: MigrateLockfileOptions,
  destDir: string,
  issues: StepIssue[],
): Promise<string> {
  const source = await readRawVellumLockfile();
  if (source === null) return "";
  const rawAssistants = source.data["assistants"];
  if (!Array.isArray(rawAssistants)) return "";

  const sourceConfigDir = vellumConfigDir(opts.envSuffix);
  const copied = new Set<string>();
  for (const raw of rawAssistants) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const ids = [record["assistantId"], record["name"]].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (ids.length === 0) continue;
    // The converted lockfile drops the vellum- brand prefix (the same rule
    // transformAssistantEntry applies) — cadet's token path keys on that id.
    const destId = ids[0]!.replace(/^vellum-/, "");
    for (const id of new Set(ids)) {
      const token = path.join(sourceConfigDir, "assistants", id, "guardian-token.json");
      const dest = path.join(destDir, "assistants", destId, "guardian-token.json");
      if (!(await pathExists(token)) || copied.has(dest)) continue;
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(token, dest);
        copied.add(dest);
      } catch (err) {
        issues.push({
          severity: "warning",
          message: `could not copy the guardian token for ${destId} (${(err as Error).message}) — run \`cadet login\` to re-authenticate`,
        });
      }
    }
  }
  return copied.size > 0 ? `copied ${copied.size} guardian token(s) into the cadet config dir` : "";
}
