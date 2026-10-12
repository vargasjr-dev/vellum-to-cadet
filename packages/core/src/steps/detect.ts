import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DetectInfo, DockerDeployment, MigrateOptions, ProcessOps } from "../types.js";
import { discoveryPatterns } from "../process.js";
import { treeSize } from "../fs-utils.js";
import { handleToInstanceName, LEGACY_INSTANCE_NAME } from "../layout.js";
import { readDockerLockfileEvidence } from "../discover.js";

export const DEFAULT_VELLUM_ROOT = path.join(os.homedir(), ".vellum");

/**
 * The cadet root mirrors the vellum root's shape:
 *   ~/.local/share/vellum[-env] → ~/.local/share/cadet[-env]
 *   ~/.vellum[-env]             → ~/.local/share/cadet[-env]/assistants/<name>
 *                                 (a NAMED instance in cadet's multi-instance
 *                                 layout — never a bare ~/.cadet root)
 * Custom roots migrate to a sibling named `cadet`.
 */
export function toCadetRoot(vellumRoot: string): string {
  const base = path.basename(vellumRoot);
  if (base === "vellum" || base.startsWith("vellum-")) {
    return path.join(path.dirname(vellumRoot), `cadet${base.slice("vellum".length)}`);
  }
  if (base === ".vellum" || base.startsWith(".vellum-")) {
    const dataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    const envSuffix = envSuffixFor(vellumRoot);
    return path.join(
      dataHome,
      `cadet${envSuffix}`,
      "assistants",
      LEGACY_INSTANCE_NAME,
    );
  }
  return path.join(path.dirname(vellumRoot), "cadet");
}

/**
 * The environment suffix a vellum root maps to in cadet's XDG layout
 * ("" for the default install, "-<env>" for an env-scoped one). Shared by
 * the data-root derivation and the config-dir lockfile move, which must
 * agree on the env.
 */
export function envSuffixFor(vellumRoot: string): string {
  const base = path.basename(vellumRoot);
  if (base.startsWith("vellum-")) return base.slice("vellum".length);
  if (base.startsWith(".vellum-")) return base.slice(".vellum".length);
  return "";
}

/**
 * Known external places that may reference the vellum root without living
 * inside it. We detect and report these; touching them is a follow-up.
 */
const EXTERNAL_REFERENCE_PROBES: ReadonlyArray<{ label: string; file: string }> = [
  { label: "launchd agent", file: path.join(os.homedir(), "Library/LaunchAgents") },
  { label: "systemd unit", file: path.join(os.homedir(), ".config/systemd/user") },
];

export async function detect(options: MigrateOptions, ops: ProcessOps): Promise<DetectInfo> {
  const vellumRoot = options.vellumRoot ?? DEFAULT_VELLUM_ROOT;

  const docker = await readDockerLockfileEvidence();

  let cadetRoot = options.cadetRoot ?? toCadetRoot(vellumRoot);

  const vellumRootExists = await pathExists(vellumRoot);

  // The root flags must describe the cadet root the RUNNER acts on. The
  // handle rename below reassigns cadetRoot after the initial guess —
  // flags read before it describe a path nothing ever created, and a
  // re-run over a renamed (docker) instance then classified fresh FOREVER:
  // run 2 re-migrated the layout over a populated instance instead of
  // going verify-only (v0.0.15 field run). Read them against the FINAL
  // root, after the rename.
  const readRootFlags = async (dir: string) => {
    const flags = { exists: false, populated: false, previousManifest: false };
    if (await pathExists(dir)) {
      flags.exists = true;
      const entries = await fs.readdir(dir);
      flags.populated = entries.length > 0;
      flags.previousManifest = entries.includes(".cadet-migration-manifest.json");
    }
    return flags;
  };
  let rootFlags = await readRootFlags(cadetRoot);

  const runningProcesses = vellumRootExists
    ? await ops.find(discoveryPatterns())
    : [];

  // Modern-layout assistant dir names (the handles, e.g.
  // "vellum-fresh-eel-8di6pa"). The migration names the cadet instance
  // after the handle, not our own default. Docker-deployed assistants keep
  // their data in docker volumes — no dirs under the root — so the
  // lockfile-tracked instance ids are handles too and must join this list,
  // or the migration falls back to the generic "vellum" instance name
  // instead of the assistant's own (v0.0.10 run feedback).
  const assistantHandles: string[] = [];
  if (vellumRootExists) {
    try {
      for (const name of await fs.readdir(path.join(vellumRoot, "assistants"), { withFileTypes: true })) {
        if (name.isDirectory()) assistantHandles.push(name.name);
      }
    } catch {
      // Legacy single-root layout — no assistants/ dir.
    }
  }
  for (const id of docker.instances) {
    if (!assistantHandles.includes(id)) assistantHandles.push(id);
  }
  assistantHandles.sort();

  // A legacy single-root install migrates INTO a named instance dir. When
  // we know the real handle (docker ids included), name it after that —
  // not the generic "vellum" (v0.0.10 run feedback: the docker assistant's
  // data landed at assistants/vellum instead of its own name).
  if (
    options.cadetRoot === undefined &&
    assistantHandles.length > 0 &&
    isLegacyRootName(path.basename(vellumRoot))
  ) {
    cadetRoot = path.join(
      path.dirname(cadetRoot),
      handleToInstanceName(assistantHandles[0] ?? ""),
    );
    rootFlags = await readRootFlags(cadetRoot);
  }

  const rootSizeBytes = vellumRootExists ? await treeSize(vellumRoot) : 0;

  return {
    vellumRoot,
    cadetRoot,
    vellumRootExists,
    cadetRootExists: rootFlags.exists,
    cadetRootPopulated: rootFlags.populated,
    previousManifest: rootFlags.previousManifest,
    version: (await ops.vellumVersion()) ?? (await detectVersion(vellumRoot)),
    assistantHandles,
    retiredCount: await countRetiredArchives(vellumRoot),
    deploymentKind: await detectDeploymentKind(vellumRoot, docker),
    docker,
    runningProcesses,
    rootSizeBytes,
    externalReferences: await detectExternalReferences(vellumRoot),
  };
}

/** The legacy single-root names: `.vellum` and `.vellum-<env>`. */
function isLegacyRootName(base: string): boolean {
  return base === ".vellum" || base.startsWith(".vellum-");
}

/** Retired-assistant archives in the vellum root's retired/ dir. */
async function countRetiredArchives(vellumRoot: string): Promise<number> {
  try {
    const entries = await fs.readdir(path.join(vellumRoot, "retired"));
    return entries.filter((name) => name.endsWith(".tar.gz")).length;
  } catch {
    return 0;
  }
}

async function detectVersion(vellumRoot: string): Promise<string | null> {
  // 0.12.x recorded its version in the desktop marker; best-effort read.
  // Modern layout: the marker lives inside each assistant's state dir.
  const candidates = [
    path.join(vellumRoot, ".vellum-assistant", "version"),
    path.join(vellumRoot, "version"),
  ];
  try {
    for (const name of await fs.readdir(path.join(vellumRoot, "assistants"))) {
      candidates.push(path.join(vellumRoot, "assistants", name, ".vellum", ".vellum-assistant", "version"));
    }
  } catch {
    // Legacy single-root layout — nothing to add.
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      try {
        return (await fs.readFile(candidate, "utf8")).trim() || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function detectDeploymentKind(
  vellumRoot: string,
  docker: DetectInfo["docker"],
): Promise<DetectInfo["deploymentKind"]> {
  if (await pathExists("/.dockerenv")) return "docker";
  if (docker.instances.length > 0) return "docker";
  if (
    await pathExists(
      path.join(vellumRoot, ".vellum-assistant"),
    )
  ) {
    return "desktop";
  }
  // Modern layout: the marker lives inside each assistant's state dir.
  try {
    for (const name of await fs.readdir(path.join(vellumRoot, "assistants"))) {
      if (
        await pathExists(
          path.join(vellumRoot, "assistants", name, ".vellum", ".vellum-assistant"),
        )
      ) {
        return "desktop";
      }
    }
  } catch {
    // Not a modern root.
  }
  return "local";
}

async function detectExternalReferences(vellumRoot: string): Promise<string[]> {
  const refs: string[] = [];
  for (const probe of EXTERNAL_REFERENCE_PROBES) {
    if (!(await pathExists(probe.file))) continue;
    try {
      const stat = await fs.stat(probe.file);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(probe.file);
        if (entries.length > 0) {
          refs.push(`${probe.label}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${probe.file}`);
        }
      }
    } catch {
      // Unreadable — skip silently, it's a best-effort probe.
    }
  }
  void vellumRoot;
  return refs;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** How the destination for this migration run was resolved. */
export type TargetResolution =
  | { kind: "clear"; cadetRoot: string }
  | {
      kind: "fresh";
      cadetRoot: string;
      /** The fresh instance name (e.g. "vellum-2") used for path rewrites. */
      freshName: string;
      /** The occupied target that was left untouched. */
      occupied: string;
    }
  /** Verify-only: a previous migration's manifest was found at the target. */
  | { kind: "already-migrated"; cadetRoot: string; manifestDir: string }
  /** Explicit --cadet-root pointing at a populated root with no manifest —
   * the user chose the path deliberately, so we refuse instead of inventing one. */
  | { kind: "conflict"; cadetRoot: string; occupied: string };

/**
 * Resolve the directory the vellum root migrates into, idempotently.
 *
 * An occupied target (exists, populated, no migration manifest) is no longer
 * a hard error: the migrated assistant moves into a FRESH instance dir under
 * the cadet root's assistants/ tree (vellum, vellum-2, vellum-3, … — the
 * first name with no directory at all), leaving the existing cadet data
 * untouched. A previous migration's manifest anywhere in the candidates
 * makes the run verify-only against that dir instead of double-migrating.
 */
export async function resolveMigrationTarget(
  detect: DetectInfo,
  cadetRootExplicit: boolean,
): Promise<TargetResolution> {
  const occupied = detect.cadetRootExists && detect.cadetRootPopulated && !detect.previousManifest;
  if (!occupied) {
    if (detect.previousManifest) {
      return { kind: "already-migrated", cadetRoot: detect.cadetRoot, manifestDir: detect.cadetRoot };
    }
    return { kind: "clear", cadetRoot: detect.cadetRoot };
  }

  // The user picked this path on purpose — an auto-invented sibling would
  // silently ignore their choice. Surface the conflict instead.
  if (cadetRootExplicit) {
    return { kind: "conflict", cadetRoot: detect.cadetRoot, occupied: detect.cadetRoot };
  }

  // Where do named instances live for this target shape?
  //   legacy (~/.vellum): target IS the instance dir → siblings live beside it
  //   modern (~/.local/share/vellum): target is the cadet root → instances
  //     live under its assistants/ tree
  const parent = path.basename(path.dirname(detect.cadetRoot)) === "assistants"
    ? path.dirname(detect.cadetRoot)
    : path.join(detect.cadetRoot, "assistants");
  const baseName = path.basename(path.dirname(detect.cadetRoot)) === "assistants"
    ? path.basename(detect.cadetRoot)
    : handleToInstanceName(detect.assistantHandles[0] ?? "");

  // A previous run against this same shape may have landed in a suffixed
  // instance already — its manifest makes this run verify-only.
  try {
    const entries = await fs.readdir(parent);
    const legacyNames = baseName === LEGACY_INSTANCE_NAME
      ? []
      : [LEGACY_INSTANCE_NAME, ...suffixedNames(LEGACY_INSTANCE_NAME)];
    for (const name of [baseName, ...suffixedNames(baseName), ...legacyNames]) {
      if (!entries.includes(name)) continue;
      const candidate = path.join(parent, name);
      const files = await fs.readdir(candidate);
      if (files.includes(".cadet-migration-manifest.json")) {
        return { kind: "already-migrated", cadetRoot: candidate, manifestDir: candidate };
      }
    }
  } catch {
    // Parent unreadable — fall through to fresh-name resolution.
  }

  const freshName = await firstFreshInstanceName(parent, baseName);
  return {
    kind: "fresh",
    cadetRoot: path.join(parent, freshName),
    freshName,
    occupied: detect.cadetRoot,
  };
}

function suffixedNames(base: string): string[] {
  return Array.from({ length: 50 }, (_, i) => `${base}-${i + 2}`);
}

async function firstFreshInstanceName(parent: string, base: string): Promise<string> {
  for (const name of [base, ...suffixedNames(base)]) {
    if (!(await pathExists(path.join(parent, name)))) return name;
  }
  // 50 suffixes deep is not a real scenario; fail loudly rather than guess.
  throw new Error(`could not find a fresh instance directory under ${parent}`);
}
