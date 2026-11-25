import { promises as fs } from "node:fs";
import * as path from "node:path";

import { discoverVellumRoots, readCadetLockfileAssistantCount, type VellumRootCandidate } from "./discover.js";
import { envSuffixFor, toCadetRoot, vellumDataRoot } from "./steps/detect.js";

/**
 * Desktop-wrapper API — the seams the Cadet desktop app consumes.
 *
 * packages/electron-desktop is a thin shim over THIS module: the probe
 * decides when the migration prompt may appear, the state file decides
 * when it may never appear again, and `migrate()` (runner.ts) is the run
 * itself. No desktop-specific logic may live in the app.
 */

/** Version of the on-disk state-file schema. */
const STATE_VERSION = 1;

/** The state file's name on the vellum XDG side. */
const STATE_FILE = ".cadet-migration-state.json";

/**
 * Why the desktop prompt is quiet. `no-vellum-root`: nothing to migrate.
 * `cadet-in-use`: the cadet lockfile already tracks assistants (the
 * lockfile-level gate — the desktop offer exists for machines that have
 * never run cadet). `already-migrated` / `declined`: the vellum-side state
 * file silences the prompt for good.
 */
export type DesktopProbeQuietReason =
  | "no-vellum-root"
  | "nothing-to-migrate"
  | "cadet-in-use"
  | "already-migrated"
  | "declined";

export type DesktopProbe =
  | {
      status: "offer";
      /** The trusted vellum root this offer migrates. */
      vellumRoot: string;
      /** The cadet root the migration would land in (from toCadetRoot). */
      cadetRoot: string;
      /** Modern-layout assistant handles (legacy single-roots offer none). */
      assistantHandles: string[];
      /** Retired-assistant archives riding along (consent-screen count). */
      retiredCount: number;
      /** The root's layout — legacy single-root or modern multi-instance. */
      layout: "legacy" | "modern";
    }
  | { status: "quiet"; reason: DesktopProbeQuietReason };

/**
 * The migration bookkeeping written on the VELLUM XDG side — the machine's
 * memory of "this vellum install was dealt with", so the desktop prompt
 * never resurfaces after a completed migration (or a checked
 * don't-ask-again decline), even if the cadet side is later wiped.
 */
export interface DesktopMigrationState {
  version: number;
  status: "migrated" | "declined";
  /** ISO timestamp of the write. */
  at: string;
  /** The vellum root this state refers to. */
  vellumRoot: string;
  /** The cadet root the migration landed in, when known. */
  cadetRoot?: string;
}

/**
 * Where the state file lives: the vellum XDG data root (`vellumDataRoot`)
 * — inside the root itself for modern installs, the `~/.local/share/vellum`
 * sibling for legacy `~/.vellum` installs. Deterministic from the root the
 * probe discovered, so a later probe always finds what an earlier run wrote.
 */
export function desktopMigrationStatePath(vellumRoot: string): string {
  return path.join(vellumDataRoot(vellumRoot), STATE_FILE);
}

/** Best-effort read: null when absent, unreadable, or an unknown shape. */
export async function readDesktopMigrationState(
  vellumRoot: string,
): Promise<DesktopMigrationState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(desktopMigrationStatePath(vellumRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DesktopMigrationState;
    if (
      parsed?.version !== STATE_VERSION ||
      (parsed.status !== "migrated" && parsed.status !== "declined") ||
      typeof parsed.at !== "string" ||
      typeof parsed.vellumRoot !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write the state atomically, best-effort. A failed write never fails the
 * migration it books — the worst case is the prompt returning next launch,
 * which is the safe default.
 */
export async function writeDesktopMigrationState(
  state: DesktopMigrationState,
): Promise<boolean> {
  const file = desktopMigrationStatePath(state.vellumRoot);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Book a completed migration. Never downgrades an existing record.
 */
export async function markMigrated(
  vellumRoot: string,
  cadetRoot?: string,
): Promise<boolean> {
  const existing = await readDesktopMigrationState(vellumRoot);
  if (existing?.status === "migrated") return false;
  return writeDesktopMigrationState({
    version: STATE_VERSION,
    status: "migrated",
    at: new Date().toISOString(),
    vellumRoot,
    ...(cadetRoot ? { cadetRoot } : {}),
  });
}

/**
 * Book a don't-ask-again decline (the consent screen's checkbox). Never
 * downgrades a migrated record — a checked box on a machine that already
 * migrated keeps the migrated state.
 */
export async function markDeclined(
  vellumRoot: string,
  cadetRoot?: string,
): Promise<boolean> {
  if ((await readDesktopMigrationState(vellumRoot))?.status === "migrated") return false;
  return writeDesktopMigrationState({
    version: STATE_VERSION,
    status: "declined",
    at: new Date().toISOString(),
    vellumRoot,
    ...(cadetRoot ? { cadetRoot } : {}),
  });
}

/** Modern roots keep their assistants under `<root>/assistants`. */
async function modernHandles(vellumRoot: string): Promise<string[]> {
  const handles: string[] = [];
  try {
    for (const entry of await fs.readdir(path.join(vellumRoot, "assistants"), { withFileTypes: true })) {
      if (entry.isDirectory()) handles.push(entry.name);
    }
  } catch {
    // Legacy single-root layout — no assistants/ dir.
  }
  return handles.sort();
}

async function countRetired(vellumRoot: string): Promise<number> {
  try {
    const entries = await fs.readdir(path.join(vellumRoot, "retired"));
    return entries.filter((name) => name.endsWith(".tar.gz")).length;
  } catch {
    return 0;
  }
}

/**
 * The desktop boot probe: MAY this machine be offered the migration?
 *
 * Cheap by construction — fs stats, marker scans, and lockfile reads only.
 * No tree size walk (the consent screen gets its byte counts later, from
 * `gatherConfirmInfo` during the run's own detect), no process discovery,
 * no docker daemon call — the gate is the cadet LOCKFILE alone.
 *
 * Gate order: an explicit root wins; otherwise discovery's best candidate.
 * The vellum-side state file silences first (migrated and declined both),
 * then the cadet lockfile (a machine already using cadet is not offered),
 * then modern roots must still carry at least one assistant.
 */
export async function probeDesktopInstall(
  options: { vellumRoot?: string; cadetRoot?: string } = {},
): Promise<DesktopProbe> {
  let candidate: { root: string; layout: "legacy" | "modern" } | null = null;
  if (options.vellumRoot) {
    const base = path.basename(options.vellumRoot);
    candidate = {
      root: options.vellumRoot,
      layout: base === ".vellum" || base.startsWith(".vellum-") ? "legacy" : "modern",
    };
  } else {
    let roots: VellumRootCandidate[];
    try {
      roots = await discoverVellumRoots();
    } catch {
      roots = [];
    }
    const best = roots[0];
    if (!best) return { status: "quiet", reason: "no-vellum-root" };
    candidate = { root: best.root, layout: best.layout };
  }
  const vellumRoot = candidate.root;

  const state = await readDesktopMigrationState(vellumRoot);
  if (state?.status === "migrated") return { status: "quiet", reason: "already-migrated" };
  if (state?.status === "declined") return { status: "quiet", reason: "declined" };

  // The lockfile gate: a cadet config-dir lockfile tracking assistants
  // means cadet is already in use — the desktop offer is for machines
  // that have never run it. Missing/unparsable counts as 0 (offer).
  const cadetCount = await readCadetLockfileAssistantCount(envSuffixFor(vellumRoot));
  if (cadetCount > 0) return { status: "quiet", reason: "cadet-in-use" };

  const handles = await modernHandles(vellumRoot);
  if (handles.length === 0 && candidate.layout === "modern") {
    return { status: "quiet", reason: "nothing-to-migrate" };
  }

  return {
    status: "offer",
    vellumRoot,
    cadetRoot: options.cadetRoot ?? toCadetRoot(vellumRoot),
    assistantHandles: handles,
    retiredCount: await countRetired(vellumRoot),
    layout: candidate.layout,
  };
}
