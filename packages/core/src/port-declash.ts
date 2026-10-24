import * as net from "node:net";

/**
 * Fresh port allocation for migrated assistants (the port de-clash).
 *
 * A vellum entry's `resources` carry the ports the vellum assistant bound —
 * and the transform is raw-preserving, so before this module they rode into
 * the cadet lockfile byte-identical. A user keeping the vellum install
 * around (running it alongside cadet, or letting it auto-start after a
 * reboot) then has two assistants competing for the same gateway/daemon
 * ports. The migration therefore allocates FRESH ports for every converted
 * assistant: the vellum port space is left to vellum, and cadet's own
 * allocator rules (walk upward from the environment's base ports, skip
 * everything claimed) keep the new choices collision-free.
 *
 * Re-runs must not churn: `migrate-lockfile` adopts an existing same-id
 * cadet entry's ports (via {@link adoptExistingPorts}) instead of
 * reallocating, so an already-migrated assistant keeps its ports — and a
 * wake that later finds one held by a foreign process heals it (cadet-side).
 *
 * The bases mirror cadet's `cli/src/lib/environments/paths.ts`
 * `DEFAULT_PORTS` (production) and `@mycadet/environments` `portBlock`
 * (non-prod envs: base, base+100, base+200, base+300). The migrator is
 * standalone and cannot import cadet's packages, so the table is duplicated
 * here — cadet's paths.ts is the source of truth.
 */

export interface PortBases {
  daemon: number;
  gateway: number;
  qdrant: number;
  ces: number;
}

/** cadet production's legacy, non-contiguous port set. */
const PROD_BASES: PortBases = { daemon: 7821, gateway: 7830, qdrant: 6333, ces: 8090 };

/** cadet's non-prod env blocks: a 1000-port window, services spaced 100 apart. */
function portBlock(base: number): PortBases {
  return { daemon: base, gateway: base + 100, qdrant: base + 200, ces: base + 300 };
}

const ENV_BLOCKS: Record<string, PortBases> = {
  staging: portBlock(17000),
  test: portBlock(19000),
  dev: portBlock(18000),
  local: portBlock(20000),
};

/**
 * The base ports cadet's own allocator would walk from for an install with
 * the given config-dir env suffix ("" for the default install). Unknown
 * suffixes get the production bases: cross-env collision is the only
 * problem per-env blocks target, and a single machine runs one env's
 * assistants.
 */
export function basePortsForEnvSuffix(envSuffix: string): PortBases {
  const name = envSuffix.startsWith("-") ? envSuffix.slice(1) : envSuffix;
  return ENV_BLOCKS[name] ?? PROD_BASES;
}

/** The `resources` port fields the migrator reallocates, and the base each walks from. */
const RESOURCE_PORT_FIELDS: ReadonlyArray<{ field: string; base: keyof PortBases }> = [
  { field: "daemonPort", base: "daemon" },
  { field: "gatewayPort", base: "gateway" },
  { field: "qdrantPort", base: "qdrant" },
  { field: "cesPort", base: "ces" },
];

export interface DeclashMove {
  field: string;
  from: number;
  to: number;
}

export interface DeclashOptions {
  /** cadet env suffix for the config dir (from envSuffixFor(vellumRoot)). */
  envSuffix: string;
  /**
   * Ports recorded by every OTHER entry in the destination lockfile — the
   * new allocations must not collide with assistants already there.
   */
  claimed?: ReadonlySet<number>;
  /**
   * Bind probe; a port is allocatable when this resolves true. Defaults to
   * a real 0.0.0.0 bind so a port anything currently holds (vellum running
   * alongside, a dev server) is skipped.
   */
  isPortFree?: (port: number) => Promise<boolean>;
  /**
   * `resources` field names whose recorded value must survive as-is — the
   * ports adopted from an existing same-id cadet entry (re-runs). Kept
   * fields still seed the exclusion set so the reallocated fields never
   * collide with them.
   */
  keepFields?: ReadonlySet<string>;
}

export interface DeclashResult {
  /** One per reallocated field, in allocation order. */
  moves: DeclashMove[];
}

/**
 * Allocate fresh ports for one converted entry's recorded `resources` ports.
 * Local and docker entries both publish host ports from `resources` (docker
 * wake resolves `{{ gatewayPort }}` from it), so both are de-clashed;
 * paired/cloud entries and entries recording no ports pass through null.
 * The entry's OWN recorded ports are excluded from the walk too — a fresh
 * allocation never re-picks a vellum port, even a currently-free one, so
 * vellum restarting later cannot collide with the migrated cadet.
 *
 * Throws when an environment's 100-port walk is exhausted (mirrors cadet's
 * findAvailablePort) — the caller converts that into a step issue.
 */
export async function declashEntryPorts(
  entry: Record<string, unknown>,
  opts: DeclashOptions,
): Promise<DeclashResult | null> {
  if (entry.cloud !== "local" && entry.cloud !== "docker") return null;
  const resources = entry.resources;
  if (!isRecord(resources)) return null;
  const recorded = RESOURCE_PORT_FIELDS.filter(
    ({ field }) => typeof resources[field] === "number",
  );
  if (recorded.length === 0) return null;

  const isPortFree = opts.isPortFree ?? defaultIsPortFree;
  const bases = basePortsForEnvSuffix(opts.envSuffix);

  const excluded = new Set<number>(opts.claimed ?? []);
  for (const { field } of RESOURCE_PORT_FIELDS) {
    const value = resources[field];
    if (typeof value === "number") excluded.add(value);
  }

  const moves: DeclashMove[] = [];
  for (const { field, base } of recorded) {
    if (opts.keepFields?.has(field)) continue;
    const from = resources[field] as number;
    const to = await walkFromPort(bases[base], excluded, isPortFree);
    resources[field] = to;
    excluded.add(to);
    moves.push({ field, from, to });
  }

  // The runtime url's port follows the gateway port (scheme, host, path and
  // formatting stay byte-identical) so clients that read the lockfile land
  // on the same port the gateway will bind.
  const gateway = moves.find((m) => m.field === "gatewayPort");
  if (gateway && typeof entry.runtimeUrl === "string") {
    const rewritten = replaceUrlPort(entry.runtimeUrl, gateway.from, gateway.to);
    if (rewritten !== entry.runtimeUrl) entry.runtimeUrl = rewritten;
  }

  return { moves };
}

/**
 * Adopt an existing same-id cadet entry's ports into a converted entry
 * (merge-and-replace re-runs): the cadet lockfile is live state, so an
 * entry that survived a previous run — possibly awake right now — keeps its
 * ports; everything else about the converted entry still replaces it.
 * Returns what was adopted (the gateway port, so the runtime url can follow
 * it, and the field names, so the de-clash keeps them), or null when the
 * existing entry records no usable ports.
 */
export interface AdoptedPorts {
  gatewayPort: number | null;
  fields: string[];
}

export function adoptExistingPorts(
  converted: Record<string, unknown>,
  existing: Record<string, unknown>,
): AdoptedPorts | null {
  const convertedResources = converted.resources;
  const existingResources = existing.resources;
  if (!isRecord(convertedResources) || !isRecord(existingResources)) return null;

  const fields: string[] = [];
  let gatewayPort: number | null = null;
  for (const { field } of RESOURCE_PORT_FIELDS) {
    const value = existingResources[field];
    if (typeof value !== "number") continue;
    convertedResources[field] = value;
    fields.push(field);
    if (field === "gatewayPort") gatewayPort = value;
  }
  return fields.length > 0 ? { gatewayPort, fields } : null;
}

/**
 * Point a converted entry's runtime url at an adopted gateway port: the
 * url's existing port segment is replaced wholesale (the adopted port is
 * cadet's own allocation, not a delta from the vellum one). Urls without a
 * port segment pass through unchanged.
 */
export function rewriteRuntimeUrlPort(url: string, gatewayPort: number): string {
  const m = url.match(/^(https?:\/\/)([^/@\s:]+):(\d+)([/?#].*)?$/i);
  if (!m) return url;
  return `${m[1]}${m[2]}:${gatewayPort}${m[4] ?? ""}`;
}

/** Walk upward from `base`, skipping excluded and occupied ports (max 100 — cadet's walk length). */
async function walkFromPort(
  base: number,
  excluded: ReadonlySet<number>,
  isPortFree: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let offset = 0; offset < 100; offset++) {
    const port = base + offset;
    if (excluded.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port scanning from ${base} to ${base + 99}`);
}


/**
 * Probe a port by binding it on 0.0.0.0 — the strictest "nothing holds
 * this" test (a loopback-bound holder fails it, and so does a LAN-bound
 * one). Non-in-use bind failures (EACCES, …) also read as occupied: the
 * walker just moves on.
 */
export function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const settle = (free: boolean): void => {
      server.removeAllListeners();
      server.close(() => resolve(free));
    };
    server.once("error", () => settle(false));
    server.once("listening", () => settle(true));
    server.listen(port, "0.0.0.0");
  });
}

function replaceUrlPort(url: string, from: number, to: number): string {
  const m = url.match(/^(https?:\/\/)([^/@\s:]+):(\d+)([/?#].*)?$/i);
  if (!m || Number(m[3]) !== from) return url;
  return `${m[1]}${m[2]}:${to}${m[4] ?? ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
