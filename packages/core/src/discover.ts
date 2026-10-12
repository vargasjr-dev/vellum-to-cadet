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
  { rel: "guardian-token.json", weight: 3 },
  { rel: "skills", weight: 1 },
  { rel: "plugins", weight: 1 },
  { rel: "config.json", weight: 1 },
];

/**
 * Markers only the vellum assistant creates inside its roots — generic names
 * don't count. Cadet keeps its own guardian tokens under its config dir
 * (~/.config/cadet/assistants/<id>/guardian-token.json), but discovery never
 * scans cadet paths, so those can't tip a vellum-root decision.
 */
const STRONG_MARKERS = new Set([
  ".vellum-assistant",
  ".vellumAssistant",
  "device/registry.json",
  "protected",
  "guardian-token.json",
]);

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
 * Where the modern (0.12.x) multi-instance production DATA root lives:
 * ~/.local/share/vellum — host assistants' state dirs (assistants/<name>/.vellum).
 * The migrator targets production assistants only — env siblings
 * (vellum-dev, vellum-staging, …) are never candidates.
 */
export function modernDataRootPath(): string {
  return path.join(home(), ".local", "share", "vellum");
}

/**
 * The modern CONFIG root: ~/.config/vellum — client identity, logs, and the
 * per-assistant guardian tokens (assistants/<name>/guardian-token.json).
 * Docker-only installs never create the data dir at all — all of their heavy
 * data lives in docker volumes — so this is the ONLY on-disk vellum state
 * those installs have (field QA: migrating a docker-only assistant found the
 * lockfile but "no vellum root directory on disk").
 */
export function modernConfigRootPath(): string {
  return path.join(home(), ".config", "vellum");
}

/**
 * The modern root, when it exists on disk. The data root wins when both dirs
 * exist (a host install) so one installation never surfaces as two roots to
 * pick between; the config root is the root only for docker-only installs,
 * and their config-dir state still rides the lockfile step's guardian-token
 * copy on host installs.
 */
export async function modernRootCandidates(): Promise<Array<{ root: string; origin: string }>> {
  const dataRoot = modernDataRootPath();
  if (await exists(dataRoot)) {
    return [{ root: dataRoot, origin: "default XDG data location" }];
  }
  const configRoot = modernConfigRootPath();
  if (await exists(configRoot)) {
    return [{ root: configRoot, origin: "default XDG config location" }];
  }
  return [];
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

/**
 * Every root location discovery considers — the legacy env overrides and
 * the home root, plus the modern XDG root whether or not it exists. The
 * failure report must name them all: listing only the legacy home root
 * reads like the modern layout was never looked for.
 */
export function searchedRootPaths(): string[] {
  return [
    ...candidateRoots().map((c) => c.root),
    modernDataRootPath(),
    modernConfigRootPath(),
  ];
}

/**
 * Every location the no-installation failure report names — the root dirs
 * and every lockfile path, whether or not they exist on disk. A report
 * that only names the legacy home root reads like the modern layout was
 * never looked for.
 */
export async function searchedLocations(): Promise<string[]> {
  return [
    ...new Set([
      ...searchedRootPaths(),
      path.join(home(), ".config", "vellum", "lockfile.json"),
      ...(await lockfileCandidates()),
    ]),
  ];
}

export async function discoverVellumRoots(): Promise<VellumRootCandidate[]> {
  const found = new Map<string, VellumRootCandidate>();

  for (const candidate of [...candidateRoots(), ...(await modernRootCandidates())]) {
    const stat = await statOrNull(candidate.root);
    if (!stat?.isDirectory()) continue;

    // Modern multi-instance layout: assistants/<name>/.vellum/ state dirs
    // (the data layout) or assistants/<name>/guardian-token.json (the
    // config layout docker-only installs have).
    const modern = await modernAssistants(candidate.root);
    if (modern.length > 0) {
      const innerMarkers = new Set<string>();
      let score = MODERN_LAYOUT_BONUS;
      for (const assistant of modern) {
        for (const marker of MARKERS) {
          if (innerMarkers.has(marker.rel)) continue; // counted once
          if (await exists(path.join(assistant.markerDir, marker.rel))) {
            innerMarkers.add(marker.rel);
            score += marker.weight;
          }
        }
      }
      // Same trust gate as legacy: a `.vellum` dir alone isn't enough —
      // require a marker only the assistant creates inside it.
      if (![...innerMarkers].some((m) => STRONG_MARKERS.has(m))) continue;
      const hasStateDirs = modern.some((a) => a.markerDir.endsWith(".vellum"));
      const markers = [
        hasStateDirs ? "assistants/*/.vellum" : "assistants/*/guardian-token.json",
        ...innerMarkers,
      ];
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

  // Nothing on disk carried a trusted root. A docker-tracked install keeps
  // its record in the vellum lockfile (the assistant data itself lives in
  // docker volumes, not on disk), and real docker hatches still create the
  // host root for the CLI's own state — but nothing in that root may carry
  // a strong marker. The lockfile's own record is vellum's signature, so
  // when it tracks docker instances it corroborates the modern root the
  // marker scan couldn't trust.
  if (found.size === 0) {
    const docker = await readDockerLockfileEvidence();
    if (docker.instances.length > 0) {
      for (const root of [modernDataRootPath(), modernConfigRootPath()]) {
        if (!(await exists(root))) continue;
        const key = await realpath(root);
        found.set(key, {
          root: key,
          score: MODERN_LAYOUT_BONUS,
          markers: ["vellum lockfile"],
          origin: "docker-tracked vellum lockfile",
          layout: "modern",
        });
        break;
      }
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
}

/** Modern roots outrank a coexisting legacy root: they are what current versions write. */
const MODERN_LAYOUT_BONUS = 10;

/** A modern assistant dir under a root's assistants/: either carries the
 * `.vellum` state dir (the data layout) or a guardian token directly (the
 * config layout docker-only installs have — their data lives in docker
 * volumes, so the config dir is the only on-disk state). */
interface ModernAssistantDir {
  name: string;
  /** Where the trust markers live: the `.vellum` state dir, or the
   * assistant dir itself in the config layout. */
  markerDir: string;
}

/** Assistant dirs with a `.vellum` state dir or a guardian token under a
 * modern XDG root. */
async function modernAssistants(root: string): Promise<ModernAssistantDir[]> {
  const assistantsDir = path.join(root, "assistants");
  let names: string[];
  try {
    names = (await fs.readdir(assistantsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const found: ModernAssistantDir[] = [];
  for (const name of names) {
    const dir = path.join(assistantsDir, name);
    if (await exists(path.join(dir, ".vellum"))) {
      found.push({ name, markerDir: path.join(dir, ".vellum") });
    } else if (await exists(path.join(dir, "guardian-token.json"))) {
      found.push({ name, markerDir: dir });
    }
  }
  return found;
}

/**
 * The vellum markers ONE directory carries, scored the way root discovery
 * scores candidates: legacy markers at the root itself, modern
 * multi-instance markers inside assistants/<name>/.vellum or the
 * per-assistant config dirs. `strong` is the same trust gate discovery
 * applies — at least one marker only the vellum assistant creates. Exported
 * for the cloud export contract: a staged root must pass the gate discovery
 * would apply to it before the migrator runs against it.
 */
export async function inspectRootMarkers(
  root: string,
): Promise<{ markers: string[]; strong: boolean }> {
  const stat = await statOrNull(root);
  if (!stat?.isDirectory()) return { markers: [], strong: false };

  const found = new Set<string>();
  for (const marker of MARKERS) {
    if (await exists(path.join(root, marker.rel))) found.add(marker.rel);
  }
  for (const assistant of await modernAssistants(root)) {
    for (const marker of MARKERS) {
      if (await exists(path.join(assistant.markerDir, marker.rel))) found.add(marker.rel);
    }
  }
  const markers = [...found];
  return { markers, strong: markers.some((m) => STRONG_MARKERS.has(m)) };
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
 * them all. The migrator targets production assistants only, so the
 * candidates are the production roots: the bare home root (~/.cadet) and
 * the modern XDG root (~/.local/share/cadet) with its assistants/<name>
 * instance dirs — env-suffixed siblings (cadet-dev, …) are never
 * candidates. A candidate qualifies only when it carries the migration
 * manifest — the migrator's own audit trail — so foreign or hand-made
 * cadet roots are never touched.
 */
export async function discoverCadetRoots(): Promise<string[]> {
  const homeDir = home();
  const candidates = new Set<string>();

  const bare = await fs.readdir(homeDir).catch(() => []);
  for (const name of bare) {
    if (name === ".cadet") {
      candidates.add(path.join(homeDir, name));
    }
  }

  const shareDir = path.join(homeDir, ".local", "share");
  const share = await fs.readdir(shareDir).catch(() => []);
  for (const name of share) {
    if (name !== "cadet") continue;
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

const VELLUM_LOCKFILE_NAMES = [".vellum.lock.json", ".vellum.lockfile.json"];

interface RawLockfileEntry {
  assistantId?: unknown;
  name?: unknown;
  cloud?: unknown;
  containerInfo?: {
    assistantImage?: unknown;
    gatewayImage?: unknown;
    cesImage?: unknown;
  } | null;
}

/**
 * Every plausible vellum lockfile location: the e2e hook dir, the
 * home-level legacy names, and the production XDG config dir (`vellum`
 * variants) that hold the canonical lockfile.
 */
export async function lockfileCandidates(): Promise<string[]> {
  const homeDir = home();
  const candidates: string[] = [];
  const lockfileDir = process.env.VELLUM_LOCKFILE_DIR?.trim();
  if (lockfileDir) {
    candidates.push(path.join(lockfileDir, "lockfile.json"));
  }
  for (const name of VELLUM_LOCKFILE_NAMES) {
    candidates.push(path.join(homeDir, name));
  }
  try {
    for (const entry of await fs.readdir(path.join(homeDir, ".config"))) {
      if (entry === "vellum") {
        candidates.push(path.join(homeDir, ".config", entry, "lockfile.json"));
      }
    }
  } catch {
    // No XDG config dir — fine.
  }
  return candidates;
}

/**
 * Read the FIRST existing vellum lockfile as raw JSON — unknown fields
 * intact, priority order the same one the vellum CLI reads in. Returns null
 * when no candidate exists or none parses. The lockfile conversion uses
 * this (not readLockfileEntries, which narrows to a few fields) so the
 * cadet lockfile it writes preserves every field the entry carried.
 */
export async function readRawVellumLockfile(): Promise<{
  path: string;
  data: Record<string, unknown>;
} | null> {
  for (const candidate of await lockfileCandidates()) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return { path: candidate, data };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read every assistant entry the vellum lockfiles record — the same record
 * `vellum ps` is derived from. Best-effort: missing, malformed, or lockless
 * installs yield nothing.
 */
export async function readLockfileEntries(): Promise<RawLockfileEntry[]> {
  const entries: RawLockfileEntry[] = [];
  for (const candidate of await lockfileCandidates()) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
    let parsed: { assistants?: RawLockfileEntry[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    entries.push(...(parsed.assistants ?? []));
  }
  return entries;
}

/**
 * Sleep targets for the stop step. The vellum CLI has no sleep-all flag,
 * so the migrator sleeps each lockfile-tracked assistant by id (falling
 * back to the entry's name when it has no id). Deduped: the same assistant
 * can surface from more than one candidate file.
 */
export async function readLockfileAssistants(): Promise<
  Array<{ identifier: string }>
> {
  const seen = new Set<string>();
  const out: Array<{ identifier: string }> = [];
  for (const entry of await readLockfileEntries()) {
    const identifier =
      typeof entry.assistantId === "string" && entry.assistantId.length > 0
        ? entry.assistantId
        : typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : null;
    if (identifier == null || seen.has(identifier)) continue;
    seen.add(identifier);
    out.push({ identifier });
  }
  return out;
}

/**
 * The instances the lockfile records as docker-deployed, plus their images.
 * Only lockfile-tracked assistants matter — the vellum CLI's own `sleep`
 * command stops their containers, so the migrator never touches docker
 * itself. Best-effort: a missing, malformed, or lockless install yields
 * no evidence.
 */
export async function readDockerLockfileEvidence(): Promise<{
  instances: string[];
  images: string[];
}> {
  const instances = new Set<string>();
  const images = new Set<string>();
  for (const entry of await readLockfileEntries()) {
    if (entry.cloud !== "docker" || typeof entry.assistantId !== "string") continue;
    instances.add(entry.assistantId);
    for (const image of [
      entry.containerInfo?.assistantImage,
      entry.containerInfo?.gatewayImage,
      entry.containerInfo?.cesImage,
    ]) {
      if (typeof image === "string" && image.length > 0) images.add(image);
    }
  }
  return { instances: [...instances], images: [...images] };
}
