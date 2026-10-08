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
 *   3. docker bind-mount conventions (/data/.vellum, /volumes/…)
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
    { root: "/data/.vellum", origin: "docker volume convention" },
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

  for (const candidate of candidateRoots()) {
    const stat = await statOrNull(candidate.root);
    if (!stat?.isDirectory()) continue;

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
      found.set(key, { root: key, score, markers, origin: candidate.origin });
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
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
