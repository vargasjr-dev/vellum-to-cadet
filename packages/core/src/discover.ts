import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Vellum root discovery. The CLI should never require the user to know where
 * their vellum assistant lives — we find it from:
 *
 *   1. legacy env overrides the assistant itself honored
 *      (VELLUM_DATA_DIR / VELLUM_WORKSPACE_DIR → workspace dir's parent)
 *   2. the default home location (~/.vellum)
 *
 * A candidate is CONFIRMED when it contains at least one vellum marker
 * (workspace dir, desktop marker, device registry, protected keys). Scores
 * rank multiple candidates deterministically.
 */

export interface VellumRootCandidate {
  root: string;
  score: number;
  markers: string[];
  origin: string;
  /** legacy: single root (~/.vellum). modern: multi-instance XDG layout. */
  layout: "legacy" | "modern";
}

const MARKERS: ReadonlyArray<{ rel: string; weight: number }> = [
  { rel: "workspace", weight: 2 },
  { rel: ".vellum-assistant", weight: 3 },
  { rel: ".vellumAssistant", weight: 3 },
  { rel: "device/registry.json", weight: 2 },
  { rel: "protected", weight: 2 },
  { rel: "skills", weight: 1 },
  { rel: "plugins", weight: 1 },
  { rel: "config.json", weight: 1 },
];

/** Markers only the vellum assistant creates — generic names don't count. */
const STRONG_MARKERS = new Set([".vellum-assistant", ".vellumAssistant", "device/registry.json", "protected"]);

/**
 * HOME-first home resolution. os.homedir() alone ignores runtime env changes
 * under some runtimes; reading $HOME explicitly keeps discovery predictable
 * inside containers and test harnesses alike.
 */
function home(): string {
  const fromEnv = process.env["HOME"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return os.homedir();
}

/**
 * Where modern (0.12.x) multi-instance roots live: ~/.local/share/vellum and
 * its env-suffixed siblings (vellum-dev, …). Returned entries exist on disk.
 */
export async function modernRootCandidates(): Promise<Array<{ root: string; origin: string }>> {
  const shareDir = path.join(home(), ".local", "share");
  let names: string[];
  try {
    names = (await fs.readdir(shareDir)).filter((n) => /^vellum(-[a-z0-9-]+)?$/.test(n));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => ({
      root: path.join(shareDir, name),
      origin: name === "vellum" ? "default XDG data location" : `XDG data location (env: ${name.slice("vellum-".length)})`,
    }));
}

/** Where the vellum 0.12.x assistant could plausibly live on this machine. */
export function candidateRoots(): Array<{ root: string; origin: string }> {
  const homeDir = home();
  const candidates: Array<{ root: string | undefined; origin: string }> = [
    // Legacy env overrides — the assistant resolved these itself.
    { root: process.env["VELLUM_DATA_DIR"], origin: "VELLUM_DATA_DIR" },
    {
      root: process.env["VELLUM_WORKSPACE_DIR"]
        ? path.dirname(process.env["VELLUM_WORKSPACE_DIR"])
        : undefined,
      origin: "VELLUM_WORKSPACE_DIR",
    },
    { root: path.join(homeDir, ".vellum"), origin: "default home location" },
  ];
  return candidates
    .filter((c): c is { root: string; origin: string } => typeof c.root === "string" && c.root.length > 0)
    // The workspace env var points INSIDE the root; env could point anywhere.
    .map((c) => ({ root: normalizeRoot(c.root), origin: c.origin }));
}

/**
 * If the candidate is the workspace directory itself (marked by containing
 * `data/db`), climb to its parent — the migration operates on the root.
 */
function normalizeRoot(root: string): string {
  if (path.basename(root) === "workspace") return path.dirname(root);
  return root;
}

export async function discoverVellumRoots(): Promise<VellumRootCandidate[]> {
  const found = new Map<string, VellumRootCandidate>();

  for (const candidate of [...candidateRoots(), ...(await modernRootCandidates())]) {
    const stat = await statOrNull(candidate.root);
    if (!stat?.isDirectory()) continue;

    // Modern multi-instance layout: assistants/<name>/.vellum/ state dirs.
    const modern = await modernAssistants(candidate.root);
    if (modern.length > 0) {
      const stateDir = path.join(candidate.root, "assistants", modern[0]!, ".vellum");
      const innerMarkers: string[] = [];
      let score = MODERN_LAYOUT_BONUS;
      for (const marker of MARKERS) {
        if (await exists(path.join(stateDir, marker.rel))) {
          innerMarkers.push(marker.rel);
          score += marker.weight;
        }
      }
      // Same trust gate as legacy: a `.vellum` dir alone isn't enough —
      // require a marker only the assistant creates inside it.
      if (!innerMarkers.some((m) => STRONG_MARKERS.has(m))) continue;
      const markers = ["assistants/*/.vellum", ...innerMarkers];
      const key = await realpath(candidate.root);
      const existing = found.get(key);
      if (!existing || existing.score < score) {
        found.set(key, { root: key, score, markers, origin: candidate.origin, layout: "modern" });
      }
      continue;
    }

    const markers: string[] = [];
    let score = 0;
    for (const marker of MARKERS) {
      if (await exists(path.join(candidate.root, marker.rel))) {
        markers.push(marker.rel);
        score += marker.weight;
      }
    }
    if (score === 0) continue; // A directory named .vellum with nothing in it isn't a vellum root.
    // Generic dir names (workspace/, skills/) exist everywhere — require at
    // least one marker only the assistant creates before trusting a root.
    if (!markers.some((m) => STRONG_MARKERS.has(m))) continue;

    const key = await realpath(candidate.root);
    const existing = found.get(key);
    if (!existing || existing.score < score) {
      found.set(key, { root: key, score, markers, origin: candidate.origin, layout: "legacy" });
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
}

/** Modern roots outrank a coexisting legacy root: they are what current versions write. */
const MODERN_LAYOUT_BONUS = 10;

/** Assistant names with a `.vellum` state dir under a modern XDG root. */
async function modernAssistants(root: string): Promise<string[]> {
  const assistantsDir = path.join(root, "assistants");
  let names: string[];
  try {
    names = (await fs.readdir(assistantsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (await exists(path.join(assistantsDir, name, ".vellum"))) found.push(name);
  }
  return found;
}

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await statOrNull(p)) !== null;
}

async function realpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Cadet-root discovery for repair mode. Repair never takes a path
 * argument — it finds every cadet root this migrator created and fixes
 * them all. Candidates mirror the vellum side: bare home roots
 * (~/.cadet, ~/.cadet-<env>) and the modern XDG roots
 * (~/.local/share/cadet[-<env>]) with their assistants/<name> instance
 * dirs. A candidate qualifies only when it carries the migration
 * manifest — the migrator's own audit trail — so foreign or hand-made
 * cadet roots are never touched.
 */
export async function discoverCadetRoots(): Promise<string[]> {
  const homeDir = home();
  const candidates = new Set<string>();

  const bare = await fs.readdir(homeDir).catch(() => []);
  for (const name of bare) {
    if (name === ".cadet" || name.startsWith(".cadet-")) {
      candidates.add(path.join(homeDir, name));
    }
  }

  const shareDir = path.join(homeDir, ".local", "share");
  const share = await fs.readdir(shareDir).catch(() => []);
  for (const name of share) {
    if (!/^cadet(-[a-z0-9-]+)?$/.test(name)) continue;
    const root = path.join(shareDir, name);
    candidates.add(root);
    const instances = await fs
      .readdir(path.join(root, "assistants"))
      .catch(() => []);
    for (const instance of instances) {
      candidates.add(path.join(root, "assistants", instance));
    }
  }

  const qualified: string[] = [];
  for (const candidate of [...candidates].sort()) {
    try {
      if ((await fs.stat(path.join(candidate, ".cadet-migration-manifest.json"))).isFile()) {
        qualified.push(candidate);
      }
    } catch {
      // Not a migrated cadet root.
    }
  }
  return qualified;
}
