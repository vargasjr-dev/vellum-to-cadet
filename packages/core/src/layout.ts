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
    // prefix of a longer name (those were already consumed above).
    "\\.vellum(-[A-Za-z0-9-]+)?(?![A-Za-z-])",
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
