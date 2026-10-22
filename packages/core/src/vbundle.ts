/**
 * The legacy `.vbundle` assistant-backup format: a gzip-compressed ustar tar
 * whose FIRST entry is `manifest.json`, followed by the producing assistant's
 * entire workspace tree under a `workspace/` prefix (db, config, skills,
 * prompts, attachments — the exporter skipped only regenerable dirs) and
 * optional `credentials/<account>` entries holding plaintext values.
 *
 * Format ground truth comes from the vellum-era runtime export stack (the
 * `vbundle-builder`/`vbundle-validator`/`vbundle-streaming-importer` modules
 * the upstream repo later removed): manifest entries carry sha256 + size for
 * every archived file, symlinks are tar typeflag-2 records whose manifest
 * entry hashes the link-target STRING, paths longer than 100 bytes ride PAX
 * extended headers (typeflag 'x'), and the manifest self-checksum is the
 * sha256 of the canonicalized (recursively key-sorted) manifest with the
 * `checksum` field emptied.
 *
 * The importer validated every entry against the manifest and restored the
 * `workspace/` tree into a staging dir that atomically swapped into place.
 * This module restores the same discipline for the migrator: nothing is
 * written before the manifest validates, every byte is hash-verified while
 * it lands, and the whole extraction goes to a staging dir the caller
 * renames into place only on success.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { createGunzip } from "node:zlib";

const BLOCK = 512;
export const MANIFEST_ENTRY = "manifest.json";
export const WORKSPACE_PREFIX = "workspace/";
export const CREDENTIALS_PREFIX = "credentials/";

/** Caps ported from the upstream validator — a hostile manifest can't force unbounded work. */
export const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
export const MANIFEST_MAX_ENTRIES = 200_000;
/** Plaintext credential values are small (api keys); anything larger is not one. */
export const MAX_CREDENTIAL_BYTES = 1024 * 1024;

/** v1 manifest `assistant` block. */
export interface VBundleAssistantInfo {
  id: string;
  name: string;
  runtime_version: string;
}

/** v1 manifest `origin` block — informational (managed | self-hosted-remote | self-hosted-local). */
export interface VBundleOriginInfo {
  mode: string;
  platform_version?: string;
  hostname?: string;
}

/** v1 manifest `compatibility` block. */
export interface VBundleCompatibility {
  min_runtime_version: string;
  max_runtime_version: string | null;
}

/** v1 manifest `export_options` block. */
export interface VBundleExportOptions {
  include_logs: boolean;
  include_browser_state: boolean;
  include_memory_vectors: boolean;
  /** True on staff debug-profile bundles — never on migration exports. */
  include_gateway?: boolean;
}

export interface VBundleContentEntry {
  path: string;
  sha256: string;
  size_bytes: number;
  link_target?: string;
}

export interface VBundleManifest {
  schema_version: 1;
  bundle_id: string;
  created_at: string;
  assistant: VBundleAssistantInfo;
  origin: VBundleOriginInfo;
  compatibility: VBundleCompatibility;
  contents: VBundleContentEntry[];
  checksum: string;
  secrets_redacted: boolean;
  export_options: VBundleExportOptions;
}

export interface ExtractVBundleResult {
  manifest: VBundleManifest;
  /** Number of workspace files written (symlinks included). */
  fileCount: number;
  /** Workspace bytes written, straight from the (verified) manifest sizes. */
  totalBytes: number;
  /** Plaintext credential values carried by the bundle — the caller decides their fate. */
  credentials: Array<{ account: string; value: string }>;
  symlinkCount: number;
}

// ---------------------------------------------------------------------------
// Canonicalization + checksums (ported byte-for-byte from the validator)
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON.stringify with keys sorted recursively — the upstream wire form. */
export function canonicalizeJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

/** The self-checksum: sha256 over the canonicalized manifest with `checksum` emptied. */
export function computeManifestChecksum(manifest: VBundleManifest): string {
  return sha256Hex(canonicalizeJson({ ...manifest, checksum: "" }));
}

// ---------------------------------------------------------------------------
// Manifest parsing (hand-narrowed — this package stays dependency-free)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export class VBundleError extends Error {}

/**
 * Parse + validate a manifest's raw JSON: v1 schema shape, the entry-count
 * and size caps, and the self-checksum. Throws VBundleError with the reason.
 */
export function parseVBundleManifest(raw: string): VBundleManifest {
  if (Buffer.byteLength(raw, "utf8") > MANIFEST_MAX_BYTES) {
    throw new VBundleError(`manifest exceeds the ${MANIFEST_MAX_BYTES}-byte cap`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new VBundleError(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new VBundleError("manifest.json is not a JSON object");
  if (parsed.schema_version !== 1) {
    throw new VBundleError(
      `unsupported manifest schema_version ${JSON.stringify(parsed.schema_version)} — only v1 bundles are supported`,
    );
  }
  const assistant = isRecord(parsed.assistant) ? parsed.assistant : null;
  const id = assistant ? str(assistant.id) : null;
  const name = assistant ? str(assistant.name) : null;
  const runtimeVersion = assistant ? str(assistant.runtime_version) : null;
  if (!id || !name || !runtimeVersion) {
    throw new VBundleError("manifest.assistant must carry non-empty id, name, and runtime_version strings");
  }
  const origin = isRecord(parsed.origin) ? parsed.origin : null;
  const mode = origin ? str(origin.mode) : null;
  if (origin === null || mode === null) {
    throw new VBundleError("manifest.origin.mode must be a non-empty string");
  }
  const compatibility = isRecord(parsed.compatibility) ? parsed.compatibility : null;
  const minRuntime = compatibility ? str(compatibility.min_runtime_version) : null;
  if (compatibility === null || minRuntime === null) {
    throw new VBundleError("manifest.compatibility.min_runtime_version must be a non-empty string");
  }
  if (!isRecord(parsed.export_options)) throw new VBundleError("manifest.export_options must be an object");
  if (!Array.isArray(parsed.contents)) throw new VBundleError("manifest.contents must be an array");
  if (parsed.contents.length > MANIFEST_MAX_ENTRIES) {
    throw new VBundleError(`manifest carries ${parsed.contents.length} entries, over the ${MANIFEST_MAX_ENTRIES} cap`);
  }
  const contents: VBundleContentEntry[] = [];
  for (const entry of parsed.contents) {
    if (!isRecord(entry)) throw new VBundleError("manifest.contents entries must be objects");
    const entryPath = str(entry.path);
    if (!entryPath) throw new VBundleError("manifest.contents entry.path must be a non-empty string");
    const sha = entry.sha256;
    const size = entry.size_bytes;
    if (!isSha256(sha)) throw new VBundleError(`content entry '${entryPath}' carries no sha256 hex digest`);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      throw new VBundleError(`content entry '${entryPath}' carries no non-negative size_bytes`);
    }
    const linkTarget = str(entry.link_target);
    if (linkTarget !== null && size !== 0) {
      throw new VBundleError(`symlink entry '${entryPath}' must declare size_bytes 0`);
    }
    contents.push(linkTarget !== null ? { path: entryPath, sha256: sha, size_bytes: size, link_target: linkTarget } : { path: entryPath, sha256: sha, size_bytes: size });
  }
  const checksum = parsed.checksum;
  if (!isSha256(checksum)) throw new VBundleError("manifest.checksum must be a sha256 hex digest");
  const manifest: VBundleManifest = {
    schema_version: 1,
    bundle_id: str(parsed.bundle_id) ?? "",
    created_at: str(parsed.created_at) ?? "",
    assistant: { id, name, runtime_version: runtimeVersion },
    origin: {
      mode,
      ...(str(origin.platform_version) ? { platform_version: origin.platform_version as string } : {}),
      ...(str(origin.hostname) ? { hostname: origin.hostname as string } : {}),
    },
    compatibility: { min_runtime_version: minRuntime, max_runtime_version: str(compatibility.max_runtime_version) },
    contents,
    checksum,
    secrets_redacted: parsed.secrets_redacted === true,
    export_options: {
      include_logs: parsed.export_options.include_logs === true,
      include_browser_state: parsed.export_options.include_browser_state === true,
      include_memory_vectors: parsed.export_options.include_memory_vectors === true,
      ...(parsed.export_options.include_gateway !== undefined ? { include_gateway: parsed.export_options.include_gateway === true } : {}),
    },
  };
  if (computeManifestChecksum(manifest) !== checksum) {
    throw new VBundleError("manifest checksum mismatch — the bundle's manifest was modified or corrupted");
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Streaming extraction
// ---------------------------------------------------------------------------

interface TarHeader {
  name: string;
  size: number;
  type: "file" | "symlink" | "dir" | "pax";
  linkname: string;
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8").trimEnd();
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const raw = readString(block, offset, length);
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new VBundleError(`malformed tar header: non-octal size field ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 8);
}

function parseTarHeader(block: Buffer): TarHeader | null {
  let allZero = true;
  for (let i = 0; i < BLOCK; i++) {
    if (block[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return null;
  const typeflag = block[156] ?? 0;
  const type =
    typeflag === 0 || typeflag === 0x30
      ? "file"
      : typeflag === 0x32
        ? "symlink"
        : typeflag === 0x35
          ? "dir"
          : typeflag === 0x78
            ? "pax"
            : null;
  if (type === null) {
    throw new VBundleError(`unsupported tar entry type '${JSON.stringify(String.fromCharCode(typeflag))}' — not a migration vbundle`);
  }
  return { name: readString(block, 0, 100), size: readOctal(block, 124, 12), type, linkname: readString(block, 157, 100) };
}

/** Reject traversal/absolute/hidden-escape paths before anything is written. */
function safeRelativePath(entryPath: string): string {
  if (entryPath.startsWith("/") || entryPath.includes("\\")) {
    throw new VBundleError(`unsafe archive path ${JSON.stringify(entryPath)}`);
  }
  const parts = entryPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0 || parts.some((p) => p === ".." || p === ".")) {
    throw new VBundleError(`unsafe archive path ${JSON.stringify(entryPath)}`);
  }
  return parts.join("/");
}

/** A symlink's target must stay inside the extracted workspace. */
function validateLinkTarget(linkPath: string, linkTarget: string, workspaceRoot: string): void {
  if (path.isAbsolute(linkTarget)) {
    throw new VBundleError(`symlink '${linkPath}' carries an absolute target ${JSON.stringify(linkTarget)}`);
  }
  const resolved = path.resolve(path.dirname(linkPath), linkTarget);
  const workspaceAbs = path.resolve(workspaceRoot);
  if (resolved !== workspaceAbs && !resolved.startsWith(workspaceAbs + path.sep)) {
    throw new VBundleError(`symlink '${linkPath}' escapes the workspace via target ${JSON.stringify(linkTarget)}`);
  }
}

/**
 * Read ONLY the manifest — the bundle's first entry — validating its shape
 * and self-checksum. Nothing is extracted; used for dry runs and pre-checks.
 */
export async function readVBundleManifest(bundlePath: string): Promise<VBundleManifest> {
  let manifest: VBundleManifest | null = null;
  const source = createReadStream(bundlePath);
  const gunzip = createGunzip();
  let buf = Buffer.alloc(0);
  let needed = Number.POSITIVE_INFINITY;
  try {
    for await (const chunk of source.pipe(gunzip)) {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      if (needed === Number.POSITIVE_INFINITY) {
        if (buf.length < BLOCK) continue;
        const header = parseTarHeader(buf.subarray(0, BLOCK));
        if (header === null) throw new VBundleError("the archive is empty — no manifest.json entry");
        if (header.type !== "file" || header.name !== MANIFEST_ENTRY) {
          throw new VBundleError(
            `manifest.json must be the bundle's first entry — saw '${header.name}' first`,
          );
        }
        if (header.size > MANIFEST_MAX_BYTES) {
          throw new VBundleError(`manifest exceeds the ${MANIFEST_MAX_BYTES}-byte cap`);
        }
        needed = BLOCK + header.size;
      }
      if (buf.length >= needed) {
        manifest = parseVBundleManifest(buf.subarray(BLOCK, needed).toString("utf8"));
        break;
      }
    }
  } catch (err) {
    if (err instanceof VBundleError) throw err;
    throw new VBundleError(`not a readable .vbundle archive (expected gzipped tar): ${(err as Error).message}`);
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (manifest === null) throw new VBundleError("no manifest.json in the bundle");
  return manifest;
}

/**
 * Extract a `.vbundle` into `stagingDir`: the manifest validates first
 * (nothing is written before it does), then every `workspace/` entry is
 * hash-verified WHILE it is written to `stagingDir/workspace/`, every
 * `credentials/` entry is buffered in memory (never written to disk), and
 * symlinks are recreated at the end against the complete tree so their
 * safety can be judged. Throws VBundleError on any mismatch — the caller
 * owns discarding the staging dir.
 */
export async function extractVBundle(
  bundlePath: string,
  stagingDir: string,
  opts: { /** Where the bundle's workspace/ tree lands INSIDE the staging dir — modern roots nest all state under .vellum/. */ workspaceDir?: string } = {},
): Promise<ExtractVBundleResult> {
  const workspaceDir = opts.workspaceDir ?? ".";
  // The bundle's workspace/ prefix maps to <staging>/<workspaceDir>/workspace/.
  const workspaceRoot = path.join(stagingDir, workspaceDir, "workspace");
  // The manifest parses inside closeEntry (a closure) — a plain `let` would
  // keep its initializer's narrowing at the post-loop reads, so it lives in
  // a state object whose property reads reset at every await.
  const state: { manifest: VBundleManifest | null } = { manifest: null };
  const expected = new Map<string, VBundleContentEntry>();
  const seen = new Set<string>();
  const symlinks: Array<{ archivePath: string; linkPath: string; linkTarget: string }> = [];
  const credentials: Array<{ account: string; value: string }> = [];
  let fileCount = 0;
  let totalBytes = 0;
  let symlinkCount = 0;
  let pendingPaxPath: string | null = null;
  let manifestRaw: Buffer | null = null;

  // Per-entry streaming state: exactly one entry is "open" at a time.
  let openName: string | null = null;
  let openKind: "manifest" | "file" | "credential" | "symlink" | "pax" | "other" = "other";
  let openRemaining = 0;
  let openHasher = createHash("sha256");
  let openHandle: fs.FileHandle | null = null;
  let openBuffer: Buffer | null = null;
  let openExpectedSize = 0;
  /** Zero bytes padding the entry's body out to the 512-byte block boundary. */
  let openPadding = 0;

  const closeEntry = async (): Promise<void> => {
    if (openName === null) return;
    const entryPath = openName;
    if (openHandle) {
      await openHandle.close();
      openHandle = null;
    }
    if (openKind === "pax") {
      // A PAX extended header's body is "<length> key=value\n" records for
      // the NEXT entry — the length prefix counts the whole record.
      const text = (openBuffer ?? Buffer.alloc(0)).toString("utf8");
      for (const line of text.split("\n")) {
        const record = line.match(/^\d+ ([^=]+)=(.*)$/);
        const value = record?.[2];
        if (record && record[1] === "path" && value !== undefined) pendingPaxPath = value;
      }
      openName = null;
      openKind = "other";
      openHasher = createHash("sha256");
      openBuffer = null;
      return;
    }
    const digest = openHasher.digest("hex");
    const expectedEntry = expected.get(entryPath);
    if (openKind === "manifest") {
      const parsedManifest = parseVBundleManifest((manifestRaw ?? Buffer.alloc(0)).toString("utf8"));
      state.manifest = parsedManifest;
      for (const entry of parsedManifest.contents) expected.set(entry.path, entry);
      if (expected.has(MANIFEST_ENTRY)) {
        throw new VBundleError("manifest lists itself as a content entry");
      }
    } else if (!expectedEntry) {
      throw new VBundleError(`archive entry '${entryPath}' is not listed in manifest.json`);
    } else if (openKind === "symlink") {
      // Symlink entries carry no body — the manifest hashes the link-target STRING.
      const linkTarget = symlinks.find((l) => l.archivePath === entryPath)?.linkTarget ?? "";
      if (sha256Hex(linkTarget) !== expectedEntry.sha256) {
        throw new VBundleError(`symlink entry '${entryPath}' failed its sha256 verification`);
      }
      seen.add(entryPath);
      openName = null;
      openKind = "other";
      openHasher = createHash("sha256");
      return;
    } else if (digest !== expectedEntry.sha256) {
      throw new VBundleError(`archive entry '${entryPath}' failed its sha256 verification (manifest says ${expectedEntry.sha256}, archive carried ${digest})`);
    } else if (openKind === "credential") {
      const account = entryPath.slice(CREDENTIALS_PREFIX.length);
      credentials.push({ account, value: (openBuffer ?? Buffer.alloc(0)).toString("utf8") });
    } else if (openKind === "file") {
      fileCount++;
      totalBytes += openExpectedSize;
    }
    seen.add(entryPath);
    openName = null;
    openKind = "other";
    openHasher = createHash("sha256");
    openBuffer = null;
    openPadding = 0;
  };

  const startEntry = async (headerName: string, header: TarHeader): Promise<void> => {
    const name = safeRelativePath(headerName);
    if (state.manifest === null) {
      if (name !== MANIFEST_ENTRY) {
        throw new VBundleError(`manifest.json must be the bundle's first entry — saw '${name}' first`);
      }
      if (header.size > MANIFEST_MAX_BYTES) {
        throw new VBundleError(`manifest exceeds the ${MANIFEST_MAX_BYTES}-byte cap`);
      }
      openName = name;
      openKind = "manifest";
      openRemaining = header.size;
      openExpectedSize = header.size;
      openPadding = (BLOCK - (header.size % BLOCK)) % BLOCK;
      openBuffer = Buffer.alloc(0);
      return;
    }
    if (name === MANIFEST_ENTRY) throw new VBundleError("duplicate manifest.json entry");
    if (name.startsWith(WORKSPACE_PREFIX)) {
      const rest = name.slice(WORKSPACE_PREFIX.length);
      if (header.type === "dir") {
        await fs.mkdir(path.join(workspaceRoot, rest), { recursive: true });
        openName = null;
        return;
      }
      if (header.type === "symlink") {
        symlinks.push({ archivePath: name, linkPath: path.join(workspaceRoot, rest), linkTarget: header.linkname });
        openName = name;
        openKind = "symlink";
        openRemaining = 0;
        return;
      }
      const expectedEntry = expected.get(name);
      if (!expectedEntry) {
        throw new VBundleError(`archive entry '${name}' is not listed in manifest.json`);
      }
      if (header.size !== expectedEntry.size_bytes) {
        throw new VBundleError(`archive entry '${name}' declares ${header.size} bytes, manifest says ${expectedEntry.size_bytes}`);
      }
      const dest = path.join(workspaceRoot, rest);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      openName = name;
      openKind = "file";
      openRemaining = header.size;
      openExpectedSize = header.size;
      openPadding = (BLOCK - (header.size % BLOCK)) % BLOCK;
      openHandle = await fs.open(dest, "w", 0o644);
      return;
    }
    if (name.startsWith(CREDENTIALS_PREFIX)) {
      const account = name.slice(CREDENTIALS_PREFIX.length);
      if (account.length === 0 || account.includes("/")) {
        throw new VBundleError(`malformed credential entry '${name}'`);
      }
      if (header.size > MAX_CREDENTIAL_BYTES) {
        throw new VBundleError(`credential '${account}' exceeds the ${MAX_CREDENTIAL_BYTES}-byte buffer cap`);
      }
      openName = name;
      openKind = "credential";
      openRemaining = header.size;
      openExpectedSize = header.size;
      openPadding = (BLOCK - (header.size % BLOCK)) % BLOCK;
      openBuffer = Buffer.alloc(0);
      return;
    }
    throw new VBundleError(`archive entry '${name}' is outside workspace/ and credentials/ — not a migration vbundle`);
  };

  const consumeData = async (data: Buffer): Promise<void> => {
    openHasher.update(data);
    if (openKind === "manifest" || openKind === "pax" || openKind === "credential") {
      openBuffer = openBuffer ? Buffer.concat([openBuffer, data]) : Buffer.from(data);
      if (openKind === "manifest") manifestRaw = openBuffer;
      return;
    }
    if (openKind === "file" && openHandle) {
      await openHandle.write(data);
    }
  };

  const source = createReadStream(bundlePath);
  const gunzip = createGunzip();
  let buf = Buffer.alloc(0);
  let sawEnd = false;
  try {
    for await (const chunk of source.pipe(gunzip)) {
      if (sawEnd) continue; // trailing padding after the end marker
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      for (;;) {
        if (openName !== null && (openRemaining > 0 || openPadding > 0)) {
          if (openRemaining > 0) {
            const take = Math.min(openRemaining, buf.length);
            if (take > 0) {
              await consumeData(buf.subarray(0, take));
              openRemaining -= take;
              buf = buf.subarray(take);
            }
            if (openRemaining > 0) break;
          }
          // Block-alignment padding between the body and the next header.
          if (openPadding > 0) {
            const take = Math.min(openPadding, buf.length);
            buf = buf.subarray(take);
            openPadding -= take;
            if (openPadding > 0) break;
          }
          await closeEntry();
          continue;
        }
        if (openName !== null) {
          // Zero-body entry (symlink) — still close for hash bookkeeping.
          await closeEntry();
          continue;
        }
        if (buf.length < BLOCK) break;
        const block = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        const header = parseTarHeader(block);
        if (header === null) {
          sawEnd = true;
          break;
        }
        const name = pendingPaxPath ?? header.name;
        pendingPaxPath = null;
        if (header.type === "pax") {
          if (header.size > MANIFEST_MAX_BYTES) {
            throw new VBundleError("PAX extended header exceeds the size cap");
          }
          openName = name;
          openKind = "pax";
          openRemaining = header.size;
          openExpectedSize = header.size;
          openPadding = (BLOCK - (header.size % BLOCK)) % BLOCK;
          openBuffer = Buffer.alloc(0);
          continue;
        }
        await startEntry(name, header);
      }
    }
    if (openName !== null) await closeEntry();
  } catch (err) {
    if (err instanceof VBundleError) throw err;
    throw new VBundleError(`not a readable .vbundle archive (expected gzipped tar): ${(err as Error).message}`);
  } finally {
    if (openHandle) await openHandle.close().catch(() => undefined);
    source.destroy();
    gunzip.destroy();
  }
  if (!sawEnd && buf.length > 0) {
    throw new VBundleError("truncated archive — the tar end marker never arrived");
  }
  const manifest = state.manifest;
  if (manifest === null) throw new VBundleError("no manifest.json in the bundle");
  for (const entry of manifest.contents) {
    if (!seen.has(entry.path)) {
      throw new VBundleError(`manifest lists '${entry.path}' but the archive never carried it`);
    }
  }

  // Symlinks last, against the complete tree.
  const workspaceAbs = path.resolve(workspaceRoot);
  for (const link of symlinks) {
    validateLinkTarget(link.linkPath, link.linkTarget, workspaceAbs);
    await fs.mkdir(path.dirname(link.linkPath), { recursive: true });
    await fs.symlink(link.linkTarget, link.linkPath);
    symlinkCount++;
  }

  return {
    manifest,
    fileCount,
    totalBytes,
    credentials,
    symlinkCount,
  };
}
