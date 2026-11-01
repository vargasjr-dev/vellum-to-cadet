import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  DB_EXTENSIONS,
  DEFAULT_TARGET_CTX,
  PATH_MOVES,
  PATH_RENAMES,
  REWRITE_EXACT_NAMES,
  REWRITE_EXTENSIONS,
  USER_WORKSPACE_DIR,
  VERBATIM_DIRS,
  WORKSPACE_RUNTIME_DIR,
  dissolveProtectedDir,
  handleToInstanceName,
  isCesCredentialMetadata,
  isConversationLog,
  isPersonaPrompt,
  consolidateDefaultProvider,
  isInstanceStateConfig,
  isPluginSource,
  isRuntimeLog,
  isSkillFrontmatter,
  isSkillInstallMeta,
  isWorkspaceConfigContract,
  isWorkspaceScript,
  cutOverManagedSpeechProviders,
  cutOverManagedWebSearchProvider,
  renamePlatformConfigSection,
  rewriteTunnelIngressUrls,
  rewriteSkillFrontmatter,
  rewriteWorkspaceJsonValues,
  textSubstitutions,
  type MigrationTargetCtx,
} from "./layout.js";
import type { FileAction } from "./types.js";

/** Rename a single path segment (file or directory name). */
export function renameSegment(name: string): string {
  let out = name;
  for (const r of PATH_RENAMES) {
    if (out === r.from) {
      out = r.to;
      break;
    }
  }
  return out;
}

/**
 * The modern multi-instance layout keeps each assistant's state at
 * `assistants/<name>/.vellum/...`. Cadet flattens state into the instance
 * dir (`assistants/<name>/workspace`, …), so the `.vellum` level dissolves
 * in the destination path. A no-op for legacy single-root trees, which
 * never had this shape.
 */
export function dissolveInstanceState(relPath: string): string {
  const m = relPath.match(/^(assistants\/[^/]+)\/\.vellum(\/|$)/);
  if (!m) return relPath;
  // The instance dir drops the vellum- brand prefix (vellum-grand-ram →
  // grand-ram) — cadet assistants are named for their handle alone, same
  // rule as handleToInstanceName.
  const name = handleToInstanceName((m[1] ?? "assistants/").slice("assistants/".length));
  return `assistants/${name}${m[2] ?? "/"}${relPath.slice(m[0].length)}`;
}

/**
 * Path relative to the assistant state root — for layout-agnostic rules
 * (verbatim dirs, workspace runtime, db artifacts). Legacy paths are their
 * own state-relative form.
 */
export function stateRelativePath(relPath: string): string {
  const m = relPath.match(/^assistants\/[^/]+\/\.vellum(\/|$)/);
  return m ? relPath.slice(m[0].length) : relPath;
}

/**
 * Whole-path remap for state-root gateway state (see PATH_MOVES). Matched
 * against the state-relative form (instance prefix stripped) so the modern
 * per-instance layout (`assistants/<name>/.vellum/data/gateway.sqlite`)
 * maps the same as the legacy single-root one, with the prefix re-applied.
 */
export function applyPathMoves(stateRel: string): string | null {
  const norm = stateRel.split("\\").join("/");
  const m = norm.match(/^(assistants\/[^/]+\/)(.+)$/);
  const rel = m ? m[2] : norm;
  for (const move of PATH_MOVES) {
    if (rel === move.from) return (m ? m[1] : "") + move.to;
  }
  return null;
}

/** Apply the full rename map to a relative path, segment by segment. */
export function renameRelativePath(relPath: string): string {
  // The bare instance dir (no .vellum level — e.g. a recorded instanceDir)
  // strips the brand prefix too. dissolveInstanceState covers the nested
  // form; this covers the dir itself.
  const prefixStripped = relPath.replace(
    /^(assistants\/)vellum-(?=[^/\\])/,
    "$1",
  );
  const stateRel = dissolveInstanceState(prefixStripped);
  const moved = applyPathMoves(stateRel);
  if (moved) return moved;
  return dissolveProtectedDir(
    stateRel
      .split("/")
      .map(renameSegment)
      .join("/"),
  );
}

export function extensionOf(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isRewriteEligible(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  // Never rewrite the user-facing workspace or protected keys — except the
  // explicit machine-owned targets inside it (the config contract, skill
  // install metadata, skill frontmatter, plugin sources, conversation logs,
  // runtime logs, persona prompts), each its own reported substep, plus the
  // single-token workspace env sweep for assistant-authored scripts.
  if (norm === USER_WORKSPACE_DIR || norm.startsWith(`${USER_WORKSPACE_DIR}/`)) {
    if (isDbArtifact(norm)) return false;
    return (
      isWorkspaceConfigContract(norm) ||
      isSkillInstallMeta(norm) ||
      isSkillFrontmatter(norm) ||
      isPluginSource(norm) ||
      isConversationLog(norm) ||
      isRuntimeLog(norm) ||
      isPersonaPrompt(norm) ||
      isWorkspaceScript(norm)
    );
  }
  // The CES credential metadata index may live under protected/ (verbatim
  // by default) — it opts into exactly one structural transform: dropping
  // legacy product-service placeholder entries.
  if (isCesCredentialMetadata(norm)) return true;
  for (const dir of VERBATIM_DIRS) {
    if (norm === dir || norm.startsWith(`${dir}/`)) return false;
  }
  const base = path.basename(norm);
  if (REWRITE_EXACT_NAMES.has(base)) return true;
  return REWRITE_EXTENSIONS.has(extensionOf(base));
}

export function isVerbatimDir(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return VERBATIM_DIRS.some((d) => norm === d || norm.startsWith(`${d}/`));
}

export function isDbArtifact(relPath: string): boolean {
  return DB_EXTENSIONS.has(extensionOf(relPath));
}

export function isUnderWorkspaceRuntime(relPath: string): boolean {
  const norm = relPath.split("\\").join("/");
  return norm.startsWith(`${USER_WORKSPACE_DIR}/${WORKSPACE_RUNTIME_DIR}/`);
}

/** Apply every text substitution, returning the new content and per-name counts. */
export function applySubstitutions(
  content: string,
  ctx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let text = content;
  for (const sub of textSubstitutions(ctx)) {
    text = text.replace(sub.pattern, (...args) => {
      counts[sub.name] = (counts[sub.name] ?? 0) + 1;
      const matched = args[0] as string;
      if (typeof sub.replace === "function") {
        return (sub.replace as (m: string) => string)(matched);
      }
      return sub.replace;
    });
  }
  return { text, counts };
}

export interface WalkEntry {
  absPath: string;
  relPath: string;
  isDirectory: boolean;
}

/**
 * Glob match for `--exclude`: `*`/`?` stay within one path segment, `**`
 * crosses segments. A pattern matches the file's source-relative path, its
 * basename, or any ancestor DIRECTORY matched segment-aligned from the
 * right — so `cache` (or `cache/`) prunes every directory named `cache`
 * and everything under it, `a.b` prunes a dir named `a.b`, and
 * `assistant-logs.db` catches the file by name at any depth. Everything
 * else matches literally.
 */
export function matchesExclude(relPath: string, patterns: string[]): boolean {
  const posix = relPath.split(path.sep).join("/");
  const parts = posix.split("/");
  const base = parts[parts.length - 1]!;
  const compiled = patterns
    .map((raw) => raw.replace(/\/+$/, ""))
    .filter((pat) => pat !== "")
    .map((pat) => ({ re: excludeGlobToRegExp(pat), segCount: pat.split("/").length }));
  if (compiled.length === 0) return false;
  // The file itself: full source-relative path or bare basename.
  if (compiled.some(({ re }) => re.test(posix) || re.test(base))) return true;
  // Any ancestor directory, matched against the directory's own trailing
  // segments (pattern depth-bounded — `**` inside a pattern still spans
  // segments within that tail).
  for (let i = 1; i < parts.length; i++) {
    const segs = parts.slice(0, i);
    for (const { re, segCount } of compiled) {
      const k = Math.min(segCount, segs.length);
      if (re.test(segs.slice(segs.length - k).join("/"))) return true;
    }
  }
  return false;
}

/** `*`/`?` stay in-segment, `**` crosses segments, everything else literal. */
function excludeGlobToRegExp(glob: string): RegExp {
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        src += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        src += "[^/]*";
      }
    } else if (c === "?") {
      src += "[^/]";
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${src}$`);
}

/** Depth-first walk of a tree, directories before their contents. */
export async function walkTree(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  async function visit(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ absPath: childAbs, relPath: childRel, isDirectory: true });
        await visit(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push({ absPath: childAbs, relPath: childRel, isDirectory: false });
      }
      // Symlinks: preserved by copy below via link(); skipped in the walk.
    }
  }
  await visit(root, "");
  return out;
}

/** Recursively size a tree in bytes (files only). */
export async function treeSize(root: string): Promise<number> {
  let total = 0;
  const entries = await walkTree(root);
  for (const e of entries) {
    if (!e.isDirectory) {
      total += (await fs.stat(e.absPath)).size;
    }
  }
  return total;
}

export async function sha256File(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Execute a planned migration: create the cadet root, copy every planned file
 * (verbatim or rewritten), recreate symlinks, and preserve executable bits.
 */
export async function executeCopyPlan(
  vellumRoot: string,
  cadetRoot: string,
  plan: FileAction[],
  log: (msg: string) => void = () => {},
  targetCtx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): Promise<void> {
  await fs.mkdir(cadetRoot, { recursive: true });

  // Directories first (plan includes every directory entry).
  const dirs = new Set<string>();
  for (const f of plan) {
    const destAbs = path.join(cadetRoot, f.dest);
    dirs.add(path.dirname(destAbs));
  }
  for (const d of [...dirs].sort()) {
    await fs.mkdir(d, { recursive: true });
  }

  for (const f of plan) {
    const srcAbs = path.join(vellumRoot, f.src);
    const destAbs = path.join(cadetRoot, f.dest);

    if (f.action === "rewrite") {
      const raw = await fs.readFile(srcAbs, "utf8");
      const { text, counts } = applySubstitutions(raw, targetCtx);
      await fs.writeFile(destAbs, text, "utf8");
      f.substitutions = counts;
    } else {
      await fs.copyFile(srcAbs, destAbs);
    }

    // Preserve mode (executable bits on hook scripts etc.).
    const srcStat = await fs.stat(srcAbs);
    await fs.chmod(destAbs, srcStat.mode);
  }

  // Symlinks inside the tree (not part of the walk): recreate by name.
  const symlinks = await collectSymlinks(vellumRoot);
  for (const s of symlinks) {
    const destAbs = path.join(cadetRoot, renameRelativePath(s.relPath));
    try {
      const target = await fs.readlink(s.absPath);
      await fs.symlink(target, destAbs);
      log(`symlink ${s.relPath} → ${target}`);
    } catch (err) {
      log(`symlink ${s.relPath}: ${(err as Error).message}`);
    }
  }
}

async function collectSymlinks(root: string): Promise<Array<{ absPath: string; relPath: string }>> {
  const out: Array<{ absPath: string; relPath: string }> = [];
  async function visit(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(childAbs, childRel);
      } else if (entry.isSymbolicLink()) {
        out.push({ absPath: childAbs, relPath: childRel });
      }
    }
  }
  await visit(root, "");
  return out;
}

/**
 * Human-readable byte size. Decimal units (1 GB = 1000 MB) to match the
 * `du`-style numbers users see elsewhere; 10.8 GB reads better than
 * 10800.6 MB. GB carries TWO decimals (v0.0.15 field feedback: at
 * multi-GB transfer totals, one decimal is a 100MB granularity the user
 * can't watch move); MB/KB keep one.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * Byte progress for a long transfer: `1.20GB/4.00GB (30%)` when the total
 * is known, bytes-so-far when it is not (the size pre-pass failed).
 */
export function formatProgress(bytes: number, totalBytes?: number): string {
  if (totalBytes !== undefined && totalBytes > 0) {
    const pct = Math.min(100, Math.floor((bytes / totalBytes) * 100));
    return `${formatBytes(bytes)}/${formatBytes(totalBytes)} (${pct}%)`;
  }
  return formatBytes(bytes);
}
/**
 * Precise legacy-token rewrites for machine-ish text that embeds history:
 * links, channel values, moved paths, env names, npm scope. A quoted
 * `"vellum"` JSON token is the channel-value shape (same rule the db
 * metadata rewrite uses) — single-quoted or bare prose `vellum` is left
 * alone so quoted user messages and this migration's own history survive
 * verbatim.
 */
export function rewriteLegacyTokens(
  content: string,
  ctx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let text = content;
  const run = (name: string, pattern: RegExp, replace: string): void => {
    const before = text;
    text = text.replace(pattern, replace);
    if (text !== before) counts[name] = (counts[name] ?? 0) + countMatches(before, pattern);
  };
  // Links/attachments first (vellum:// would otherwise be partly consumed
  // by the path rules' `.vellum` alternation… it isn't, but order is cheap
  // insurance and keeps the counts meaningful).
  run("attachment-links", /vellum:\/\//g, "cadet://");
  // Channel values as JSON string tokens (compact or spaced; the lookahead
  // also admits end-of-string so a trailing quoted value still flips).
  run("channel-values", /"(vellum)"(?=[\s,:\]}]|$)/g, '"cadet"');
  // Moved state paths, env names, npm scope — the same rules machine files get.
  const applied = applySubstitutions(text, ctx);
  text = applied.text;
  for (const [k, v] of Object.entries(applied.counts)) counts[k] = (counts[k] ?? 0) + v;
  return { text, counts };
}

/**
 * Persona prompt flip: everything {@link rewriteLegacyTokens} does, plus
 * brand words — remaining `Vellum`/`vellum` occurrences are prose-only by
 * then (paths, links, and scope were already consumed), and that is exactly
 * what should flip ("comes with the Vellum harness" → Cadet).
 */
export function rewritePersonaPrompt(
  content: string,
  ctx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): { text: string; counts: Record<string, number> } {
  const base = rewriteLegacyTokens(content, ctx);
  let text = base.text;
  const counts = { ...base.counts };
  const brandBefore = text;
  // Brand words LAST: by now paths, links, and scope were consumed, so the
  // remaining occurrences are prose ("comes with the Vellum harness"). The
  // lookbehind keeps path-embedded names intact — the migrated instance is
  // legitimately NAMED vellum (~/.vellum → .local/share/cadet/assistants/
  // vellum), and a bare word-flip after the path rules would corrupt it to
  // …/assistants/cadet.
  text = text.replace(/(?<![.\w/\\])Vellum\b/g, "Cadet").replace(/(?<![.\w/\\])vellum\b/g, "cadet");
  if (text !== brandBefore) {
    counts["brand-words"] =
      (brandBefore.match(/(?<![.\w/\\])Vellum\b/g)?.length ?? 0) +
      (brandBefore.match(/(?<![.\w/\\])vellum\b/g)?.length ?? 0);
  }
  return { text, counts };
}

function countMatches(before: string, pattern: RegExp): number {
  // pattern is global — count what the replace is about to change.
  return (before.match(pattern) ?? []).length;
}

/**
 * The ONE dispatch for content rewrites, shared by migrate-layout (during
 * copy), repair (post-migration re-run), and verify (semantic comparison).
 * Every case is a named substep; anything unmapped returns null (verbatim).
 * A case can carry ADDITIONAL named substeps (side-channel semantic passes
 * riding the same file — the speech cutover inside the config.json rewrite);
 * callers bump each on its own line so the semantic migration is visible and
 * reportable separately.
 */
export function sanctionedContentTransform(
  stateRel: string,
  raw: string,
  ctx: MigrationTargetCtx = DEFAULT_TARGET_CTX,
): {
  substep: string;
  text: string;
  counts: Record<string, number>;
  substeps?: Record<string, number>;
} | null {
  if (isWorkspaceConfigContract(stateRel)) {
    const applied = applySubstitutions(raw, ctx);
    const cutovers: Record<string, number> = {};
    // Managed (vellum/cadet) speech and web-search provider ids are retired —
    // cut them over BEFORE the generic value sweep so each swap counts once,
    // here, and the sweep never re-counts (or re-spells) the provider fields.
    const speech = cutOverManagedSpeechProviders(applied.text);
    const webSearch = cutOverManagedWebSearchProvider(
      speech !== null ? speech.text : applied.text,
    );
    const values = rewriteWorkspaceJsonValues(
      webSearch !== null ? webSearch.text : speech !== null ? speech.text : applied.text,
    );
    const counts = { ...applied.counts };
    if (values.changed > 0) counts["json-values"] = values.changed;
    let text = values.text;
    // The retired `llm.defaultProvider` key stamps the `llm.default` blob
    // and is deleted (see consolidateDefaultProvider) — same conversion the
    // runtime's ensure pass would perform on first boot.
    const consolidated = consolidateDefaultProvider(text);
    if (consolidated !== null) {
      text = consolidated;
      counts["default-provider consolidation"] = 1;
    }
    // Cadet renamed the `platform` config section to `cloud` (typed section
    // writes + the /v1/config/cloud wire rename); vellum-era and pre-rename
    // cadet configs on disk still carry the old key.
    const cloudRenamed = renamePlatformConfigSection(text);
    if (cloudRenamed !== null) {
      text = cloudRenamed;
      counts["platform-section-key"] = 1;
    }
    // The managed tunnel host convention changed (tunnel-{env} →
    // {env}-tunnel): migrated configs recording an old-shape tunnel ingress
    // URL get it rewritten so the gateway's next webhook reconcile
    // re-registers the providers (Telegram, Twilio, …) on the new path.
    const ingressUrls = rewriteTunnelIngressUrls(text);
    if (ingressUrls !== null) {
      text = ingressUrls.text;
      counts["tunnel ingress urls"] = ingressUrls.changes;
      cutovers["tunnel ingress urls"] = ingressUrls.changes;
    }
    return {
      substep: "config.json rewrite",
      text,
      counts,
      substeps: (() => {
        if (speech !== null) cutovers["speech provider cutover"] = speech.changes;
        if (webSearch !== null) cutovers["web search provider cutover"] = webSearch.changes;
        return Object.keys(cutovers).length > 0 ? cutovers : undefined;
      })(),
    };
  }
  if (isInstanceStateConfig(stateRel)) {
    // The instance (daemon/gateway) config rides the generic machine-file
    // substitutions PLUS the JSON-aware value passes that target it: today
    // the tunnel ingress URL convention (tunnel-{env} → {env}-tunnel) —
    // the gateway derives every provider webhook address from this value
    // and re-registers the webhooks on its next reconcile.
    const applied = applySubstitutions(raw, ctx);
    const ingressUrls = rewriteTunnelIngressUrls(applied.text);
    const counts = { ...applied.counts };
    const substeps: Record<string, number> | undefined =
      ingressUrls !== null ? { "tunnel ingress urls": ingressUrls.changes } : undefined;
    if (ingressUrls !== null) counts["tunnel ingress urls"] = ingressUrls.changes;
    return {
      substep: "instance config rewrite",
      text: ingressUrls !== null ? ingressUrls.text : applied.text,
      counts,
      substeps,
    };
  }
  if (isSkillInstallMeta(stateRel)) {
    const values = rewriteWorkspaceJsonValues(raw);
    const counts: Record<string, number> = values.changed > 0 ? { "json-values": values.changed } : {};
    return { substep: "skills renames", text: values.text, counts };
  }
  if (isSkillFrontmatter(stateRel)) {
    const values = rewriteSkillFrontmatter(raw);
    const counts: Record<string, number> =
      values.changed > 0 ? { "frontmatter-metadata-key": values.changed } : {};
    return { substep: "skill frontmatter rewrites", text: values.text, counts };
  }
  if (isPluginSource(stateRel)) {
    const before = raw;
    const text = raw.replace(/@vellumai\//g, "@mycadet/");
    return {
      substep: "plugin import rewrites",
      text,
      counts: text !== before ? { "npm-scope": 1 } : {},
    };
  }
  if (isConversationLog(stateRel)) {
    const { text, counts } = rewriteLegacyTokens(raw, ctx);
    return { substep: "conversation log rewrites", text, counts };
  }
  if (isRuntimeLog(stateRel)) {
    const { text, counts } = rewriteLegacyTokens(raw, ctx);
    return { substep: "runtime log rewrites", text, counts };
  }
  if (isPersonaPrompt(stateRel)) {
    const { text, counts } = rewritePersonaPrompt(raw, ctx);
    return { substep: "persona prompt rewrites", text, counts };
  }
  if (isCesCredentialMetadata(stateRel)) {
    const { text, removed } = sanitizeCesCredentialMetadata(raw);
    return {
      substep: "credential placeholder cleanup",
      text,
      counts: removed > 0 ? { "ces-placeholder-drop": removed } : {},
    };
  }
  if (isWorkspaceScript(stateRel)) {
    // The ONE rewrite an assistant-authored file may receive: the legacy
    // workspace env var token, so migrated scripts keep working against the
    // renamed harness. Everything else — prose, other VELLUM_* vars, paths —
    // stays exactly as the user wrote it.
    const hits = raw.match(/\bVELLUM_WORKSPACE_DIR\b/g)?.length ?? 0;
    const text = raw.replace(/\bVELLUM_WORKSPACE_DIR\b/g, "CADET_WORKSPACE_DIR");
    return {
      substep: "workspace env sweep",
      text,
      counts: hits > 0 ? { "workspace-env-sweep": hits } : {},
    };
  }
  return null;
}

/**
 * Drop legacy product-service credential entries from the CES metadata
 * index. Secret values live only in the secure-key backend — the index
 * cannot tell an empty placeholder from a valued entry — but entries whose
 * service is the legacy product name have no cadet meaning: the cadet
 * platform provisions its own service credentials on first connect. Custom
 * user services (anything not the legacy product name) are always kept.
 * Unparseable or unexpected-shape files pass through untouched.
 */
export function sanitizeCesCredentialMetadata(raw: string): {
  text: string;
  removed: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, removed: 0 };
  }
  const doc = parsed as { credentials?: unknown } | null;
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.credentials)) {
    return { text: raw, removed: 0 };
  }
  const kept = doc.credentials.filter(
    (c) =>
      !(
        typeof c === "object" &&
        c !== null &&
        (c as { service?: unknown }).service === "vellum"
      ),
  );
  const removed = doc.credentials.length - kept.length;
  if (removed === 0) return { text: raw, removed: 0 };
  return {
    text: JSON.stringify({ ...doc, credentials: kept }, null, 2) + "\n",
    removed,
  };
}

/**
 * Leftover legacy tokens in a rewritten machine file. The `.vellum` path
 * token carries the same URL-authority guard as the substitution itself: a
 * PRESERVED hostname like `api.vellum.example` is not a leftover — it is
 * the substitution working as intended (URLs must survive text passes).
 */
export function findLegacyTokens(text: string): string[] {
  return text.match(/VELLUM_|@vellumai\/|(?<!:\/\/[^\s/]*)\.vellum(?![A-Za-z-])/g) ?? [];
}