/**
 * The vellum → cadet rename map.
 *
 * This file is the single source of truth for every name that changed
 * between vellum 0.12.6 (the last parked vellum release) and cadet.
 * It was extracted by diffing the pre-rename and post-rename trees of the
 * cadet repo's history.
 *
 * Everything the migration does — path segment renames, text substitutions —
 * flows from the tables below. New discoveries (from real customer data)
 * land here first.
 */

/**
 * Deterministic instance name a legacy single-root assistant receives when
 * it migrates into cadet's multi-instance layout
 * (`~/.vellum` → `~/.local/share/cadet/assistants/vellum`). Vellum 0.12.6
 * recorded no instance name, so the migrated instance carries its origin.
 */
export const LEGACY_INSTANCE_NAME = "vellum";

/**
 * The product cloud every migrated assistant lands on. The legacy install's
 * `platform.baseUrl` pointed at the vellum platform; cadet's equivalent is
 * the cadet cloud (config section `cloud`, key `baseUrl` — the harness's
 * `auth info` reports it verbatim).
 */
export const CADET_CLOUD_BASE_URL = "https://cloud.mycadet.ai";

/**
 * The cadet instance name for a migrated assistant: vellum assistants have
 * handles like "vellum-fresh-eel-8di6pa" — cadet keeps the distinctive part
 * ("fresh-eel-8di6pa"), dropping the brand prefix. Falls back to the legacy
 * instance name when there is no handle to strip.
 */
export function handleToInstanceName(handle: string): string {
  const stripped = handle.replace(/^vellum-/, "").trim();
  return stripped.length > 0 ? stripped : LEGACY_INSTANCE_NAME;
}

/**
 * Where the migrated tree lands THIS RUN, threaded through every path
 * rewrite. Most migrations install the legacy instance name into a clear
 * (or absent) cadet root, so the default matches the historical behavior;
 * when the cadet root is already populated, the migrator resolves a fresh
 * instance name (see `resolveMigrationTarget`) and threads it here so every
 * rewrite points at the directory the files actually land in.
 */
export interface MigrationTargetCtx {
  instanceName: string;
  nested: boolean;
}

export const DEFAULT_TARGET_CTX: MigrationTargetCtx = {
  instanceName: LEGACY_INSTANCE_NAME,
  nested: false,
};

/**
 * Whole-path remaps for state-root gateway state. The cadet gateway reads
 * its database, guardian-init locks, and backup key ONLY from the gateway
 * security dir, and no longer relocates legacy paths itself (that recovery
 * machinery was deleted from the gateway — the migrator owns relocations).
 * Vellum 0.12.6 kept the gateway DB at the state root's `data/` dir and the
 * guardian-init locks at the state root, so both must move to
 * `gateway-security/` or a migrated instance would silently lose trust
 * rules, guardian state, and channel registrations (fresh DB + re-init).
 *
 * Checked after instance-state dissolution and BEFORE segment renames, so
 * both the legacy single-root and the modern per-instance forms match.
 */
export const PATH_MOVES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "data/gateway.sqlite", to: "gateway-security/gateway.sqlite" },
  { from: "data/gateway.sqlite-wal", to: "gateway-security/gateway.sqlite-wal" },
  { from: "data/gateway.sqlite-shm", to: "gateway-security/gateway.sqlite-shm" },
  { from: "guardian-init.lock", to: "gateway-security/guardian-init.lock" },
  {
    from: "guardian-init-consumed.json",
    to: "gateway-security/guardian-init-consumed.json",
  },
];

/** Directory/file names that must be renamed, applied to every path segment. */
export const PATH_RENAMES: ReadonlyArray<{ from: string; to: string; note?: string }> = [
  { from: ".vellum-assistant-ios", to: ".cadet-assistant-ios", note: "iOS helper; removed in cadet but renamed for parity if present" },
  { from: ".vellum-mac-helper", to: ".cadet-mac-helper" },
  { from: ".vellum-assistant", to: ".cadetAssistant", note: "desktop marker; kebab→camel in cadet" },
  { from: ".vellumAssistant", to: ".cadetAssistant" },
  { from: ".vellum-skill-run", to: ".cadet-skill-run" },
  { from: ".vellumBridge", to: ".cadetBridge" },
  { from: ".vellumShared", to: ".cadetShared", note: "feature removed in cadet; renamed for parity if present" },
  { from: ".vellum-eval", to: ".cadet-eval" },
  { from: ".vellum-cursor", to: ".cadet-cursor", note: "feature removed in cadet; renamed for parity if present" },
];

/**
 * The vellum `protected/` directory dissolves in cadet: vellum 0.12.x
 * combined gateway security material, CES state, and assistant sync state
 * into one dir, while cadet splits them per service (the platform's
 * `<instanceDir>/{gateway-security,ces-security,ces-data}` layout).
 *
 * Destination-only — file contents stay verbatim (keys, grants, audit logs
 * are never rewritten).
 */

/** Files that move to the CES security dir (the encrypted credential store). */
const CES_SECURITY_FILES = new Set(["keys.enc", "store.key"]);

/** Dirs whose contents move to the CES data root (grants, audit, tool store). */
const CES_DATA_DIRS = new Set(["credential-executor"]);

/** Dirs whose contents move to the assistant sync-state dir. */
const ASSISTANT_SYNC_DIRS = new Set(["platform-sync"]);

/**
 * Map a state-relative vellum path (`protected/...`, already dissolved of
 * the `.vellum` instance level) to its cadet destination. Anything under
 * `protected/` not claimed by CES or the assistant sync state is gateway
 * security material (trust rules, signing keys, backup key, feature flags,
 * device registry). Returns the path unchanged when it is not under
 * `protected/`.
 */
export function dissolveProtectedDir(relPath: string): string {
  const norm = relPath.split("\\").join("/");
  // `protected` may sit at the state root or, after instance-state
  // dissolution, directly inside an instance dir.
  const m = norm.match(/^((?:assistants\/[^/]+\/)?)protected(?=$|\/)/);
  if (!m) return relPath;

  const rest = norm.slice(m[0].length).replace(/^\//, "");
  if (rest === "") return `${m[1]}gateway-security`; // Bare dir: dominant tenant.

  const base = rest.split("/")[0] ?? rest;
  const mapped = CES_SECURITY_FILES.has(rest)
    ? `ces-security/${rest}`
    : CES_DATA_DIRS.has(base)
      ? `ces-data/${rest.slice(base.length + 1)}`
      : ASSISTANT_SYNC_DIRS.has(base)
        ? `platform-sync/${rest.slice(base.length + 1)}`
        : `gateway-security/${rest}`;
  return `${m[1]}${mapped}`;
}

/**
 * Text substitutions applied inside machine-owned files (never inside the
 * user-facing workspace). Order matters: the path-name alternation is
 * longest-first so `.vellum-assistant` is never mangled by a bare `.vellum`,
 * and the protected-layout remap must run AFTER the path rules (it rewrites
 * the already-renamed `/protected` value tails per env var).
 */
export function textSubstitutions(
  ctx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): ReadonlyArray<{
  name: string;
  pattern: RegExp;
  replace: string | ((match: string) => string);
}> {
  return [
  {
    name: "instance-state-paths",
    // Machine files record absolute state paths like
    // ~/.local/share/vellum/assistants/velly/.vellum/workspace — the state
    // dir level dissolves in cadet (state flattens into the instance dir),
    // so drop the trailing `/.vellum` segment. Must run before the root
    // rename below so `.vellum` is never rewritten to `.cadet` here.
    pattern: /\bassistants([/\\])[^/\\\s"']+\1\.vellum(?![A-Za-z-])/g,
    replace: (match: string) => match.replace(/[/\\]\.vellum$/, ""),
  },
  {
    name: "instance-name-prefix",
    // Machine files referencing an instance dir by its vellum-era name
    // (assistants/vellum-grand-ram/…) — the migrated instance dir drops the
    // brand prefix (same rule as dissolveInstanceState), so recorded paths
    // must agree. A dir named exactly "vellum" never matches (no dash).
    // A function: applySubstitutions returns string replaces verbatim, so a
    // "$1" there would land in the file literally.
    pattern: /\bassistants([/\\])vellum-(?=[^/\\\s"'])/g,
    replace: (match: string) => match.replace(/^(assistants([/\\]))vellum-/, "$1"),
  },
  {
    name: "xdg-root-paths",
    // The modern XDG data root: .local/share/vellum[-env] → .local/share/cadet[-env].
    pattern: /\.local([/\\])share\1vellum(-[A-Za-z0-9-]+)?(?![A-Za-z0-9-])/g,
    replace: (match: string) => {
      const suffix = match.match(/(-[A-Za-z0-9-]+)$/);
      const sep = match.includes("\\") ? "\\" : "/";
      const tail = suffix ? suffix[1] : "";
      // When migrating into a fresh instance dir inside an existing cadet
      // root, recorded state paths must point at the instance the files
      // actually land in, not the bare cadet root.
      const nested = ctx.nested ? `/assistants/${ctx.instanceName}` : "";
      return `.local${sep}share${sep}cadet${tail}${nested}`;
    },
  },
  {
    name: "env-prefix",
    // VELLUM_DAEMON_NOAUTH → CADET_DAEMON_NOAUTH, etc.
    pattern: /\bVELLUM_/g,
    replace: "CADET_",
  },
  {
    name: "protected-layout",
    // Security-dir env values point at the old combined `protected` dir;
    // cadet splits it per service. Line-scoped so the destination follows
    // the variable: GATEWAY_SECURITY_DIR → gateway-security,
    // CREDENTIAL_SECURITY_DIR → ces-security, and the CES local data root
    // (…/protected/credential-executor — also where the bootstrap socket
    // lived) → ces-data on any line. Runs after the path rules so it
    // rewrites the already-renamed value tails.
    pattern: /^[^\n]*(?:\b(?:CADET_)?(?:GATEWAY_SECURITY_DIR|CREDENTIAL_SECURITY_DIR)\b|\/protected\/credential-executor(?![\w-]))[^\n]*$/gm,
    replace: (line: string) => {
      const isCredential = /\b(?:CADET_)?CREDENTIAL_SECURITY_DIR\b/.test(line);
      const dirName = isCredential ? "ces-security" : "gateway-security";
      return line
        .replace(/\/protected\/credential-executor(?![\w-])/g, "/ces-data")
        .replace(/\/protected(?![\w-])/g, `/${dirName}`);
    },
  },
  {
    name: "npm-scope",
    pattern: /@vellumai\//g,
    replace: "@mycadet/",
  },
  {
    name: "paths-and-dotfiles",
    // Longest-first alternation built from PATH_RENAMES + the bare root.
    pattern: buildPathPattern(),
    replace: (match: string) => replacePathToken(match, ctx),
  },
  ];
}

function buildPathPattern(): RegExp {
  const tokens = [
    ...PATH_RENAMES.map((r) => escapeRegex(r.from)),
    // Legacy lockfile names keep their pre-XDG cadet spellings — cadet
    // still reads those for device-id continuity.
    "\\.vellum\\.lock(?:file)?\\.json",
    // The legacy single root: ~/.vellum or ~/.vellum-<env> — but not a
    // prefix of a longer name (those were already consumed above), and
    // never inside a URL authority (`https://api.vellum.ai` is a hostname,
    // not a dotfile path — the lookbehind blocks any match whose run-up
    // reaches a scheme://... position). The old platform URL
    // `https://platform.vellum.ai` must survive text substitution intact;
    // the config contract's JSON pass owns that value instead.
    "(?<!://[^\\s/]*)\\.vellum(-[A-Za-z0-9-]+)?(?![A-Za-z-])",
  ];
  return new RegExp(tokens.join("|"), "g");
}

function replacePathToken(match: string, ctx: MigrationTargetCtx): string {
  const rename = PATH_RENAMES.find((r) => r.from === match);
  if (rename) return rename.to;
  if (match.startsWith(".vellum.lock")) {
    return ".cadet" + match.slice(".vellum".length);
  }
  // The legacy root directory becomes the migrated NAMED INSTANCE under
  // the XDG data root:
  //   ~/.vellum      → ~/.local/share/cadet/assistants/vellum
  //   ~/.vellum-<env> → ~/.local/share/cadet-<env>/assistants/vellum
  // (POSIX separators — vellum 0.12.6 never shipped on Windows.)
  const envSuffix = match.startsWith(".vellum-")
    ? match.slice(".vellum".length)
    : "";
  return `.local/share/cadet${envSuffix}/assistants/${ctx.instanceName}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Ownership rules — what may be textually rewritten and what must never be.
// ---------------------------------------------------------------------------

/**
 * Directories inside the migrated tree that are copied byte-for-byte and
 * never rewritten: OS key material, credentials, private CES state.
 */
export const VERBATIM_DIRS: ReadonlyArray<string> = ["protected"];

/**
 * The user-facing workspace. Everything in here is user data (it is itself a
 * git repo) and must be migrated byte-for-byte — EXCEPT `workspace/data/`,
 * which is machine-owned runtime state (`data/db/assistant.db`, avatars,
 * stream state) and may be rewritten/inspected in later versions.
 */
export const USER_WORKSPACE_DIR = "workspace";

/**
 * Runtime state inside the user workspace. Machine-owned, but v0 copies it
 * verbatim and records it for inspection — content rewrites inside SQLite
 * require real customer data to validate against.
 */
export const WORKSPACE_RUNTIME_DIR = "data";

/**
 * Explicit rewrite targets INSIDE the user workspace. The workspace is
 * otherwise never touched by the generic substitution machinery — each of
 * these is its own reported substep with its own transform:
 *
 * - `workspace/config.json` ("config.json rewrite") — the gateway-facing
 *   contract (written by the CLI, not the user). LLM/speech profiles record
 *   `provider: "vellum"`; cadet dispatches only the "cadet" managed
 *   provider. Gets path/env substitutions PLUS JSON value rewrites.
 * - `workspace/skills/<name>/install-meta.json` ("skills renames") — skill
 *   install metadata records `origin: "vellum"`; cadet's origin enum has no
 *   "vellum". Gets JSON value rewrites.
 * - `workspace/plugins/**` ("plugin import rewrites") — user-authored
 *   plugin sources importing `@vellumai/plugin-api`; the renamed package is
 *   `@mycadet/plugin-api`. Gets the npm-scope substitution only.
 *
 * User-authored skill/docs content stays verbatim, as does everything in
 * `workspace/data` (the runtime state dir — its SQLite values are handled
 * by the explicit assistant-db step, not text rewrites).
 */

/** The gateway-facing config contract inside the workspace. */
export function isWorkspaceConfigContract(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return norm === `${USER_WORKSPACE_DIR}/config.json`;
}

/**
 * The CES credential metadata index — service/field/allow-list records.
 * Secret values never live in this file (secure-key backend only), so the
 * index is also where legacy product-service PLACEHOLDERS surface: entries
 * whose service is the legacy product name carry no cadet meaning and are
 * dropped during migration (see sanitizeCesCredentialMetadata).
 */
export function isCesCredentialMetadata(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return (
    norm === "data/credentials/metadata.json" ||
    norm === "protected/credential-executor/metadata.json"
  );
}

/** Path segments that never count as assistant-authored scripts. */
const WORKSPACE_SWEEP_EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "vendor",
]);

/** Local lowercase-extension helper (layout stays dependency-free). */
function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/**
 * Assistant-authored workspace files (bin/, lib/, schedules/, notes/ …):
 * plain text that may reference the legacy workspace env var. These are
 * USER files — the only rewrite they may ever receive is the single-token
 * workspace env sweep (see sanctionedContentTransform), never the full
 * machine-file substitution list.
 */
export function isWorkspaceScript(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  const ws = `${USER_WORKSPACE_DIR}/`;
  if (!norm.startsWith(ws)) return false;
  // Local db-artifact check (fs-utils imports from here — no round trip).
  if (DB_EXTENSIONS.has(extensionOf(norm))) return false;
  // The machine-owned workspace categories have their own transforms and
  // must not be claimed by the sweep.
  if (
    isWorkspaceConfigContract(norm) ||
    isSkillInstallMeta(norm) ||
    isSkillFrontmatter(norm) ||
    isPluginSource(norm) ||
    isConversationLog(norm) ||
    isRuntimeLog(norm) ||
    isPersonaPrompt(norm)
  ) {
    return false;
  }
  const segments = norm.slice(ws.length).split("/");
  for (const seg of segments) {
    if (WORKSPACE_SWEEP_EXCLUDED_SEGMENTS.has(seg)) return false;
  }
  const base = segments[segments.length - 1] ?? norm;
  // Extensionless files (bin/vj, Makefile, Dockerfile…) are eligible: the
  // sweep only touches bytes that literally contain the legacy token, and
  // copyOne's utf-8 guard keeps true binaries out of text handling.
  if (!base.includes(".")) return true;
  return REWRITE_EXACT_NAMES.has(base) || REWRITE_EXTENSIONS.has(extensionOf(base));
}

/** Per-skill install metadata (`workspace/skills/<name>/install-meta.json`). */
export function isSkillInstallMeta(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  const ws = `${USER_WORKSPACE_DIR}/`;
  if (!norm.startsWith(ws)) return false;
  return /^skills\/[^/]+\/install-meta\.json$/.test(norm.slice(ws.length));
}

/** User-installed plugin sources (`workspace/plugins/**`). */
export function isPluginSource(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return norm.startsWith(`${USER_WORKSPACE_DIR}/plugins/`);
}

/**
 * Installed-skill frontmatter (`workspace/skills/<name>/SKILL.md`). The
 * frontmatter's `metadata:` block is a machine contract: cadet reads
 * `metadata.cadet.*` (display-name, category, activation-hints, avoid-when,
 * feature-flag, includes) and has no legacy `vellum` tolerance — a skill
 * installed by the old product keeps its `metadata.vellum` block and silently
 * loses all of it. The prose BELOW the frontmatter stays verbatim.
 */
export function isSkillFrontmatter(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  const ws = `${USER_WORKSPACE_DIR}/`;
  if (!norm.startsWith(ws)) return false;
  return /^skills\/[^/]+\/SKILL\.md$/.test(norm.slice(ws.length));
}

/**
 * Frontmatter-only rewrite: inside the leading `---` block, the `vellum:`
 * key nested directly under `metadata:` becomes `cadet:`. Everything else —
 * prose, other keys, deeper nesting — is untouched.
 */
export function rewriteSkillFrontmatter(content: string): { text: string; changed: number } {
  if (!content.startsWith("---\n")) return { text: content, changed: 0 };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { text: content, changed: 0 };
  const head = content.slice(4, end);
  const tail = content.slice(end);
  let changed = 0;
  let topKey = "";
  const rewritten = head
    .split("\n")
    .map((line) => {
      if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) topKey = line.slice(0, line.indexOf(":"));
      if (topKey === "metadata" && /^[ ]{2}vellum:\s*$/.test(line)) {
        changed++;
        return `${line.slice(0, 2)}cadet:`;
      }
      return line;
    })
    .join("\n");
  if (changed === 0) return { text: content, changed: 0 };
  return { text: `---\n${rewritten}${tail}`, changed };
}

/**
 * Agent conversation logs (`workspace/conversations/**`). The runtime reads
 * them back to answer questions about shared history — vellum-era attachment
 * links (`vellum://workspace/...`) would render broken, and legacy channel
 * values would read as foreign. JSONL + JSON + tool-result text.
 */
export function isConversationLog(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return norm.startsWith(`${USER_WORKSPACE_DIR}/conversations/`);
}

/**
 * Runtime log files (`workspace/data/logs/**`). The assistant writes daily
 * `assistant-YYYY-MM-DD.log` files (same names in cadet) that embed the
 * same links, channel values, paths, and env names as the machine files.
 */
export function isRuntimeLog(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return norm.startsWith(`${USER_WORKSPACE_DIR}/data/logs/`);
}

/** The workspace prompt files (persona/persona-adjacent, machine-seeded names). */
export const WORKSPACE_PROMPT_FILES: ReadonlyArray<string> = [
  "SOUL.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "VOICE.md",
  "NOW.md",
];

/**
 * Workspace prompt files (`workspace/SOUL.md` and friends). These are
 * persona prose — but the persona must not tell cadet it runs on vellum.
 * Vargas's call: flip brand references in these files (and only these).
 */
export function isPersonaPrompt(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  const ws = `${USER_WORKSPACE_DIR}/`;
  if (!norm.startsWith(ws) || norm.slice(ws.length).includes("/")) return false;
  return WORKSPACE_PROMPT_FILES.includes(norm.slice(ws.length));
}


/**
 * JSON-value rewrites for machine-owned workspace files: any string value
 * exactly equal to "vellum" becomes "cadet" (provider ids, skill origins).
 * JSON-aware on purpose — a textual vellum→cadet sweep would mangle user
 * prose and URLs. Malformed JSON is left untouched. Values that merely
 * CONTAIN "vellum" (URLs, ids like "vellum:assistant_api_key") are not
 * touched here: the managed connection rows live in the assistant DB
 * (handled by the assistant-db step) and URLs are machine-refreshed.
 */
export function rewriteWorkspaceJsonValues(content: string): {
  text: string;
  changed: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { text: content, changed: 0 };
  }
  let changed = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    if (node === "vellum") {
      changed++;
      return "cadet";
    }
    return node;
  };
  const rewritten = walk(parsed);
  if (changed === 0) return { text: content, changed: 0 };
  return { text: JSON.stringify(rewritten, null, 2) + "\n", changed };
}

/** The managed-service ids cadet retired (vellum-era spelling + renamed). */
const MANAGED_SERVICE_IDS = new Set(["vellum", "cadet"]);

/**
 * Cadet retired its managed speech providers — speech now runs exclusively on
 * real, user-keyed providers. A vellum-era config pointing
 * `services.stt.provider` / `services.tts.provider` at the managed id would
 * boot with a provider the daemon's schema rejects, so the rewrite swaps in
 * real defaults: Deepgram for STT, ElevenLabs for TTS. The managed service's
 * per-provider settings blocks (`services.*.providers."vellum"/"cadet"`) and
 * any per-role managed overrides (`services.stt.roles.<role>.provider`) go
 * with it. Accepts BOTH spellings: the generic token sweep runs before the
 * JSON passes and rewrites the ids textually, and roots already migrated by
 * older migrator releases carry the renamed spelling. The swapped-in
 * providers were never keyed by the user (the managed service billed
 * credits), so the runner surfaces "add your API key" next steps when this
 * fired — see cutoverNextSteps. Idempotent: with the managed ids gone
 * there is nothing to cut over. Returns the rewritten text, or null when
 * there was nothing to do (unparseable content, no services block, or no
 * managed speech config).
 */
export function cutOverManagedSpeechProviders(content: string): {
  text: string;
  changes: number;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const services = root.services;
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    return null;
  }
  const servicesRecord = services as Record<string, unknown>;

  let changed = 0;

  const stt = servicesRecord.stt;
  if (stt !== null && typeof stt === "object" && !Array.isArray(stt)) {
    const sttRecord = stt as Record<string, unknown>;
    if (typeof sttRecord.provider === "string" && MANAGED_SERVICE_IDS.has(sttRecord.provider)) {
      sttRecord.provider = "deepgram";
      changed++;
    }
    const roles = sttRecord.roles;
    if (roles !== null && typeof roles === "object" && !Array.isArray(roles)) {
      for (const role of Object.values(roles)) {
        if (role === null || typeof role !== "object" || Array.isArray(role)) continue;
        const roleRecord = role as Record<string, unknown>;
        if (typeof roleRecord.provider === "string" && MANAGED_SERVICE_IDS.has(roleRecord.provider)) {
          roleRecord.provider = "deepgram";
          changed++;
        }
      }
    }
    changed += deleteManagedProviderBlocks(sttRecord);
  }

  const tts = servicesRecord.tts;
  if (tts !== null && typeof tts === "object" && !Array.isArray(tts)) {
    const ttsRecord = tts as Record<string, unknown>;
    if (typeof ttsRecord.provider === "string" && MANAGED_SERVICE_IDS.has(ttsRecord.provider)) {
      ttsRecord.provider = "elevenlabs";
      changed++;
    }
    changed += deleteManagedProviderBlocks(ttsRecord);
  }

  if (changed === 0) return null;
  return { text: JSON.stringify(root, null, 2) + "\n", changes: changed };
}

/** Drop the retired managed provider's settings blocks from a services.* record. */
function deleteManagedProviderBlocks(section: Record<string, unknown>): number {
  const providers = section.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    return 0;
  }
  const providersRecord = providers as Record<string, unknown>;
  let removed = 0;
  for (const dead of ["vellum", "cadet"]) {
    if (dead in providersRecord) {
      delete providersRecord[dead];
      removed++;
    }
  }
  return removed;
}

/**
 * Cadet retired its managed web-search provider alongside the managed speech
 * service — search now runs exclusively on real providers, with
 * `inference-provider-native` (the inference provider's own hosted search) as
 * the only zero-key default. A vellum-era config pointing
 * `services.web-search.provider` at the managed id would boot with a provider
 * the daemon's schema rejects, so the rewrite swaps in that default and drops
 * the managed service's dead per-provider settings blocks
 * (`services.web-search.providers."vellum"/"cadet"`); real providers' blocks
 * (e.g. perplexity) ride untouched. Unlike speech there are no per-role
 * overrides — web search is a single `provider` pick. Accepts BOTH spellings
 * for the same reason as the speech cutover: the generic token sweep runs
 * before the JSON passes and rewrites the ids textually, and roots already
 * migrated by older migrator releases carry the renamed spelling. The
 * swapped-in default needs no key (BYOK providers like Perplexity or Brave
 * can be added for stronger results — the runner surfaces that as a next
 * step, see cutoverNextSteps). Idempotent: with the managed ids gone there
 * is nothing to cut over. Returns the rewritten text, or null when there was
 * nothing to do (unparseable content, no services block, or no managed
 * web-search config).
 */
export function cutOverManagedWebSearchProvider(content: string): {
  text: string;
  changes: number;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const services = root.services;
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    return null;
  }
  const servicesRecord = services as Record<string, unknown>;

  const webSearch = servicesRecord["web-search"];
  if (webSearch === null || typeof webSearch !== "object" || Array.isArray(webSearch)) {
    return null;
  }
  const webSearchRecord = webSearch as Record<string, unknown>;
  let changed = 0;
  if (
    typeof webSearchRecord.provider === "string" &&
    MANAGED_SERVICE_IDS.has(webSearchRecord.provider)
  ) {
    webSearchRecord.provider = "inference-provider-native";
    changed++;
  }
  changed += deleteManagedProviderBlocks(webSearchRecord);

  if (changed === 0) return null;
  return { text: JSON.stringify(root, null, 2) + "\n", changes: changed };
}

/**
 * The default-provider selection consolidates into the `llm.default` blob:
 * cadet's runtime reads the blob's `provider` (clamped to a matrix column)
 * plus its `provider_connection` pin, and the retired `llm.defaultProvider`
 * key is dead weight the runtime ensure pass would re-stamp on first boot.
 * Mirror of that pass's key-wins rule: the key is newer intent, so it stamps
 * the blob — preserving the blob's other fields, carrying an explicit
 * `connectionName` as the pin, and dropping a pin that named the OLD
 * provider when the provider changes (it would mis-pin the new column) —
 * and the key is deleted. Idempotent: with the key gone there is nothing to
 * consolidate. Returns the rewritten text, or null when there was nothing
 * to do (unparseable content, no key, or a key with no usable provider).
 */
export function consolidateDefaultProvider(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const llm = root.llm;
  if (llm === null || typeof llm !== "object" || Array.isArray(llm)) {
    return null;
  }
  const llmRecord = llm as Record<string, unknown>;
  const key = llmRecord.defaultProvider;
  if (key === null || typeof key !== "object" || Array.isArray(key)) {
    return null;
  }
  const provider = (key as Record<string, unknown>).provider;
  if (typeof provider !== "string" || provider === "") {
    return null;
  }
  const connectionName = (key as Record<string, unknown>).connectionName;

  const blob = llmRecord.default;
  const existing =
    blob !== null && typeof blob === "object" && !Array.isArray(blob)
      ? { ...(blob as Record<string, unknown>) }
      : {};
  const previousProvider = existing.provider;
  existing.provider = provider;
  const hasPin = typeof connectionName === "string" && connectionName !== "";
  if (hasPin) {
    existing.provider_connection = connectionName;
  } else if (previousProvider !== provider) {
    delete existing.provider_connection;
  }

  llmRecord.default = existing;
  delete llmRecord.defaultProvider;
  return JSON.stringify(root, null, 2) + "\n";
}

/**
 * Cadet renamed the config's `platform` section to `cloud` (typed section
 * writes and the /v1/config/cloud wire rename). Vellum-era and pre-rename
 * cadet configs on disk still carry the old section key; move it so the
 * renamed loader reads the connection settings instead of silently dropping
 * them — the config schema is strip-mode, so an unknown section never
 * round-trips. JSON-aware and TOP-LEVEL only: the section's
 * `baseUrl`/`subdomain` fields ride unchanged, key order is preserved
 * (cloud lands where platform was), and nested keys elsewhere are
 * untouched. When both spellings exist the newer `cloud` section wins and
 * `platform` is dropped — the same key-wins rule as
 * consolidateDefaultProvider. Idempotent: with `platform` gone from the
 * root there is nothing to rename. Returns the rewritten text, or null
 * when there was nothing to do (unparseable content, or no top-level
 * `platform` key).
 */
export function renamePlatformConfigSection(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const hasPlatform = root.platform !== undefined;
  const hasCloud =
    root.cloud !== null &&
    typeof root.cloud === "object" &&
    !Array.isArray(root.cloud) &&
    typeof (root.cloud as Record<string, unknown>).baseUrl === "string";
  if (!hasPlatform && !hasCloud) {
    return null;
  }
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key === "platform") {
      if (renamed.cloud === undefined) {
        renamed.cloud = value;
      }
      continue;
    }
    if (key === "cloud") {
      // An existing cloud section is the newer intent — it wins over the
      // value an earlier platform slot may have stashed here.
      renamed.cloud = value;
      continue;
    }
    renamed[key] = value;
  }
  // A vellum-branded (or path-mangled) cloud baseUrl — the legacy platform
  // host, or the garbage the raw path substitutions used to make of it —
  // lands on the product cloud. Self-hosted non-vellum URLs pass through.
  let touched = hasPlatform;
  const cloud = renamed.cloud;
  if (
    cloud !== null &&
    typeof cloud === "object" &&
    !Array.isArray(cloud) &&
    typeof (cloud as Record<string, unknown>).baseUrl === "string"
  ) {
    const section = cloud as Record<string, unknown>;
    const baseUrl = normalizeCloudBaseUrl(section.baseUrl as string);
    if (baseUrl !== section.baseUrl) {
      section.baseUrl = baseUrl;
      touched = true;
    }
  }
  if (!touched) {
    return null;
  }
  return JSON.stringify(renamed, null, 2) + "\n";
}

/**
 * The cloud base URL a migrated assistant lands on. Legacy values — the
 * vellum platform host, empty strings, or URLs the path substitutions
 * mangled (`https://platform.vellum.ai` reads as the legacy root token and
 * became `https://platform.local/share/cadet/assistants/vellum.ai` in the
 * wild) — are replaced with the product cloud. Self-hosted non-vellum URLs
 * pass through untouched.
 */
export function normalizeCloudBaseUrl(url: string): string {
  if (!url || /vellum/i.test(url)) return CADET_CLOUD_BASE_URL;
  return url;
}

/** Database artifacts are copied verbatim and recorded for later inspection. */
export const DB_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".wal", ".shm"]);

/**
 * File extensions eligible for text substitution (outside the verbatim dirs).
 * Everything else is copied byte-for-byte.
 */
export const REWRITE_EXTENSIONS = new Set([
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".plist",
  ".service",
  ".md",
  ".mjs",
  ".cjs",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".txt",
]);

/** Files whose *name* is exactly this are treated as rewrite-eligible. */
export const REWRITE_EXACT_NAMES = new Set([".env", ".env.local", ".env.production"]);

// ---------------------------------------------------------------------------
// Process names spawned by the vellum assistant (0.12.x). The stop step
// terminates these before touching anything.
// ---------------------------------------------------------------------------

export const VELLUM_PROCESS_PATTERNS: ReadonlyArray<string> = [
  "vellum-assistant",
  "vellum-daemon",
  "vellum-gateway",
  "vellum-mac-helper",
  "credential-executor",
];

/** The same component signatures after the rebrand (repair mode's targets). */
export const CADET_PROCESS_PATTERNS: ReadonlyArray<string> = [
  "cadet-assistant",
  "cadet-daemon",
  "cadet-gateway",
  "cadet-mac-helper",
  "credential-executor",
];

/** Marker present in every invocation of our own CLI (npx bin name). */
export const MIGRATION_CLI_MARKER = "migrate-vellum";
