import * as path from "node:path";

import { renameRelativePath } from "./fs-utils.js";
import { handleToInstanceName } from "./layout.js";

/**
 * Shared assistant-entry transform for the vellum → cadet identity surfaces:
 * the cadet lockfile this migrator writes and the retired-assistant metadata
 * manifests. Both carry the same vellum-era entry shape, and both had the
 * same staleness in the v0.0.9 run feedback: `vellum-` brand prefixes kept on
 * ids and names, a `species` field cadet's lockfile contract never had,
 * runtime URLs pointing at the machine's mDNS hostname, data dirs pointing
 * at vellum paths, and vellum cloud registration ids that must not leak
 * into the cadet install.
 *
 * The transform is structural and raw-preserving: fields it doesn't touch
 * (signing keys, tokens, unknown future fields) ride through unchanged.
 */

/** The registration fields a vellum cloud login writes into an entry. */
const VELLUM_PLATFORM_FIELDS = [
  "organizationId",
  "platformAssistantId",
  "platformBaseUrl",
  "platformOrganizationId",
] as const;

export interface EntryTransformOptions {
  /** Map a recorded vellum data dir to its cadet destination (absolute paths). */
  mapInstanceDir: (dir: string) => string;
  /**
   * Where the entry's own instance dir lands when the entry records none —
   * receives the ALREADY-stripped assistant id.
   */
  defaultInstanceDirFor: (strippedAssistantId: string) => string;
  /**
   * The cadet docker image refs for the installed cadet CLI. Docker
   * entries' containerInfo must record THESE — the vellum images the
   * containers ran before are worthless to cadet (v0.0.10 run feedback).
   * When absent (cadet could not be installed), the image refs ride
   * through with a warning issue and the digests are still stripped.
   */
  cadetImages?: { assistant: string; gateway: string; credentialExecutor: string };
}

export interface EntryTransformResult {
  entry: Record<string, unknown>;
  /** Whether the transform changed anything (write-skip for idempotent runs). */
  changed: boolean;
  /**
   * The entry carried vellum cloud identity — `cadet login` must re-establish
   * fresh cloud credentials before the migrated assistants use cloud features.
   */
  hadLegacyPlatformCredentials: boolean;
  /** The entry's docker images could not be repointed at cadet's. */
  dockerImagesUnresolved?: boolean;
}

export function transformAssistantEntry(
  raw: Record<string, unknown>,
  opts: EntryTransformOptions,
): EntryTransformResult {
  const entry: Record<string, unknown> = { ...raw };
  let changed = false;

  // The vellum- brand prefix: ids and display names drop it, matching the
  // instance-dir renames the layout migration performs.
  let assistantId: string | null = null;
  for (const field of ["assistantId", "name"] as const) {
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) {
      const stripped = handleToInstanceName(value);
      if (stripped !== value) {
        entry[field] = stripped;
        changed = true;
      }
      if (field === "assistantId") assistantId = stripped;
    }
  }

  // `species`: a vellum-era field cadet's lockfile contract never had —
  // it would be dead weight in every reader and misleading in the UI.
  if ("species" in entry) {
    delete entry.species;
    changed = true;
  }

  // Vellum cloud identity. The api key and webhook secret themselves live in
  // the encrypted store (the credentials step removes those); the
  // registration ids recorded here must not leak either — `cadet login`
  // re-registers the assistants with cadet cloud from scratch.
  let hadLegacyPlatformCredentials = false;
  for (const field of VELLUM_PLATFORM_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) {
      hadLegacyPlatformCredentials = true;
    }
    if (field in entry) {
      delete entry[field];
      changed = true;
    }
  }

  // runtimeUrl: local assistants recorded the machine's mDNS hostname at
  // hatch (http://MacBook-Pro-8.local:7830). Loopback survives hostname
  // changes and is what every on-machine consumer uses anyway.
  if (
    entry.cloud === "local" &&
    typeof entry.runtimeUrl === "string" &&
    entry.runtimeUrl.length > 0
  ) {
    const rewritten = localRuntimeUrlToLoopback(entry.runtimeUrl);
    if (rewritten !== entry.runtimeUrl) {
      entry.runtimeUrl = rewritten;
      changed = true;
    }
  }

  // Data dirs: point resources.instanceDir at the cadet destination.
  const resources = isRecord(entry.resources) ? entry.resources : undefined;
  if (
    typeof resources?.instanceDir === "string" &&
    resources.instanceDir.length > 0
  ) {
    const mapped = opts.mapInstanceDir(resources.instanceDir);
    if (mapped !== resources.instanceDir) {
      resources.instanceDir = mapped;
      changed = true;
    }
  }
  const mappedInstanceDir =
    typeof resources?.instanceDir === "string" &&
    resources.instanceDir.length > 0
      ? resources.instanceDir
      : null;

  // The legacy top-level baseDataDir: cadet's own lockfile parser folds it
  // into resources.instanceDir (a stale vellum path would poison that
  // migration), and a retired manifest surfaces it verbatim — so make it
  // agree with the cadet instance dir, which ends with the assistant's name.
  if ("baseDataDir" in entry) {
    const target =
      mappedInstanceDir ??
      (assistantId !== null ? opts.defaultInstanceDirFor(assistantId) : null);
    if (target !== null) {
      entry.baseDataDir = target;
    }
    changed = true;
  }

  // containerInfo: docker entries record the images to run. The vellum
  // images are worthless to cadet — repoint the three service images at
  // the refs derived from the installed cadet's version, and drop the
  // digest/network bookkeeping (cadet no longer reads or writes them:
  // the digests pinned hatch-time image state that cadet re-derives at
  // upgrade, and the network name is derived from the instance name).
  let dockerImagesUnresolved = false;
  if (entry.cloud === "docker" && isRecord(entry.containerInfo)) {
    const containerInfo = entry.containerInfo;
    if (opts.cadetImages) {
      containerInfo["assistantImage"] = opts.cadetImages.assistant;
      containerInfo["gatewayImage"] = opts.cadetImages.gateway;
      containerInfo["cesImage"] = opts.cadetImages.credentialExecutor;
      changed = true;
    } else if (typeof containerInfo["assistantImage"] === "string") {
      dockerImagesUnresolved = true;
    }
    for (const field of ["assistantDigest", "gatewayDigest", "cesDigest", "networkName"] as const) {
      if (field in containerInfo) {
        delete containerInfo[field];
        changed = true;
      }
    }
  }

  return {
    entry,
    changed,
    hadLegacyPlatformCredentials,
    ...(dockerImagesUnresolved ? { dockerImagesUnresolved: true } : {}),
  };
}

/**
 * Rewrite a runtimeUrl's hostname to 127.0.0.1, keeping everything else
 * (scheme, port, path, formatting) byte-identical. Already-loopback URLs
 * pass through unchanged, as do unparseable ones.
 */
export function localRuntimeUrlToLoopback(url: string): string {
  const m = url.match(/^(https?:\/\/)([^/@\s:]+)(:\d+)?([/?#].*)?$/i);
  if (!m) return url;
  const host = (m[2] ?? "").toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") {
    return url;
  }
  return `${m[1] ?? ""}127.0.0.1${m[3] ?? ""}${m[4] ?? ""}`;
}

/**
 * Map a recorded vellum data dir to its cadet destination: paths inside the
 * vellum root follow the same rename map the layout migration used, so the
 * entries agree with where the files actually landed. Paths outside the root
 * (the homedir default instance) pass through unchanged — cadet flattens
 * those itself. When the migration ran without layout renames (an
 * already-migrated root), the recorded path maps to its verbatim
 * destination.
 */
export function makeInstanceDirMapper(opts: {
  vellumRoot: string;
  cadetRoot: string;
  applyRenames: boolean;
}): (dir: string) => string {
  return (dir: string): string => {
    const rel = path.relative(opts.vellumRoot, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return dir;
    return path.join(
      opts.cadetRoot,
      opts.applyRenames ? renameRelativePath(rel) : rel.split("\\").join("/"),
    );
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
