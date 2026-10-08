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
 * Text substitutions applied inside machine-owned files (never inside the
 * user-facing workspace). Order matters: the path-name alternation is
 * longest-first so `.vellum-assistant` is never mangled by a bare `.vellum`.
 */
export const TEXT_SUBSTITUTIONS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  replace: string | ((match: string) => string);
}> = [
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
      return `.local${sep}share${sep}cadet${suffix ? suffix[1] : ""}`;
    },
  },
  {
    name: "env-prefix",
    // VELLUM_DAEMON_NOAUTH → CADET_DAEMON_NOAUTH, etc.
    pattern: /\bVELLUM_/g,
    replace: "CADET_",
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
    replace: replacePathToken,
  },
];

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

function replacePathToken(match: string): string {
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
  return `.local/share/cadet${envSuffix}/assistants/${LEGACY_INSTANCE_NAME}`;
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

/** Marker present in every invocation of our own CLI (npx bin name). */
export const MIGRATION_CLI_MARKER = "migrate-vellum";
