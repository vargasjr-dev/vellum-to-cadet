/**
 * The `vellum.ai/export` archive format: a tar (optionally gzip-compressed —
 * the extension doesn't decide, the magic bytes do) of one assistant's three
 * data volumes, each volume present as a TOP-LEVEL directory of the archive.
 *
 * The volumes are the docker deployment's data volumes (`<instance>-workspace`,
 * `<instance>-gateway-sec`, `<instance>-ces-sec`), so a top-level entry is
 * either the state-dir name itself (`workspace/`, `gateway-security/`,
 * `ces-security/`) or a docker volume name ending in the volume suffix
 * (`velly-workspace/`, …). The mapping is tolerant: exact state names map
 * directly, volume-style names map by suffix (all three must agree on the
 * instance prefix), and anything else at the top level is reported, not
 * restored.
 *
 * There is NO manifest: the archive carries no hashes, no assistant identity,
 * no runtime version. The restore discipline therefore leans on the tar
 * itself and the filesystem: entries are streamed (capped), paths are
 * sanitized against traversal and absolute rewrites, symlinks and hardlinks
 * only materialize when their targets stay inside the staging tree, and
 * extraction lands in a staging dir the caller renames into place
 * atomically. The archive's identity is the sha256 of its decompressed byte
 * stream — computed during the inspect pass — which doubles as the restore
 * marker's bundle id so a re-run of the same export skips instead of
 * colliding.
 */

import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

/**
 * Caps — a hostile archive can't force unbounded work. Sized for REAL
 * exports: a real vellum.ai/export tar measured 83.5 GB across 442,091
 * entries with a 12.04 GB assistant.db (field report, AEGIS review), so the
 * caps must sit far above one assistant's honest data while still bounding
 * a hostile archive.
 */
export const EXPORT_TAR_MAX_ENTRIES = 2_000_000;
export const EXPORT_TAR_MAX_ENTRY_BYTES = 64 * 1024 * 1024 * 1024;
export const EXPORT_TAR_MAX_TOTAL_BYTES = 1024 * 1024 * 1024 * 1024;
/** Long-name records (PAX `x`, GNU `L`) — real long paths are < 1 KiB. */
export const EXPORT_TAR_MAX_LONG_NAME_BYTES = 64 * 1024;
/** Body/pad bytes consumed per pull when skipping an entry's body. */
const SKIP_CHUNK_BYTES = 1024 * 1024;

/** The state dirs one assistant's volumes restore into. */
export type VolumeKind = "workspace" | "gateway-security" | "ces-security";
export const VOLUME_STATE_DIRS: readonly VolumeKind[] = [
  "workspace",
  "gateway-security",
  "ces-security",
];

export class ExportTarError extends Error {}

/** One top-level archive entry that is not one of the three volumes. */
export interface UnexpectedTopLevelEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

export interface ExportTarVolumes {
  workspace: string;
  gatewaySecurity?: string;
  cesSecurity?: string;
}

export interface ExportTarInfo {
  volumes: ExportTarVolumes;
  /** Raw instance id when volume names carry one (`vellum-velly`), else null. */
  instanceId: string | null;
  entries: number;
  totalBytes: number;
  fingerprint: string;
  unexpected: UnexpectedTopLevelEntry[];
}

export type BundleFormat = "vbundle" | "export-tar" | "unknown";

/**
 * Content sniffing for `--bundle` dispatch: read the first tar header (past
 * gzip magic if present) and tell a `.vbundle` (manifest first) from a
 * `vellum.ai/export` archive (volumes first) from garbage.
 */
export async function sniffBundleKind(
  bundlePath: string,
): Promise<BundleFormat> {
  const reader = await TarReader.open(bundlePath);
  try {
    const header = await reader.next();
    if (header === null) return "unknown";
    return header.path === "manifest.json" ? "vbundle" : "export-tar";
  } catch {
    return "unknown";
  } finally {
    await reader.close();
  }
}

interface TarHeader {
  path: string;
  typeflag: string;
  size: number;
  linkname: string | null;
}

/**
 * A streaming ustar reader over the (optionally gzipped) archive. Entries
 * are consumed strictly in order: `next()` parses the header (resolving PAX
 * `x` and GNU `L` long-name records), then the body is consumed with
 * `readBody` (repeatedly, until it returns 0) or `skipBody` before the next
 * `next()`. Block padding after each body is consumed internally.
 */
class TarReader {
  private source: ByteSource | null = null;
  /** Body bytes left in the currently-open entry. */
  private pendingBody = 0;
  /** Padding bytes that follow the body, consumed before the next header. */
  private pendingPad = 0;
  private paxPath: string | null = null;
  /** Decompressed bytes consumed so far — header diagnostics read by offset. */
  private readBytes = 0;

  private constructor() {}

  static async open(bundlePath: string): Promise<TarReader> {
    const reader = new TarReader();
    reader.source = await ByteSource.open(bundlePath);
    return reader;
  }

  async next(): Promise<TarHeader | null> {
    if (!this.source) throw new ExportTarError("tar reader already closed");
    if (this.pendingBody > 0 || this.pendingPad > 0)
      await this.discard(this.pendingBody + this.pendingPad);
    this.pendingBody = 0;
    this.pendingPad = 0;
    const block = await this.source.pull(BLOCK);
    if (block === null || block.length === 0) return null;
    if (block.length < BLOCK) return null; // truncated tail — treat as end
    if (isZeroBlock(block)) return null;
    const headerOffset = this.readBytes;
    this.readBytes += BLOCK;
    if (!isUstarHeader(block))
      throw new ExportTarError(
        `not a tar archive (bad header magic at decompressed byte offset ${headerOffset})`,
      );
    const typeflag = String.fromCharCode(block[156]!);
    const size = readHeaderSize(block);
    this.pendingBody = size;
    this.pendingPad = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    let name = headerName(block);
    const linkname =
      typeflag === "2" || typeflag === "1"
        ? nulTrim(block.subarray(157, 257))
        : null;
    if (typeflag === "x" || typeflag === "L") {
      // A long-name record's size comes straight from the header — an
      // archive must not allocate through it (real records are < 1 KiB).
      if (size > EXPORT_TAR_MAX_LONG_NAME_BYTES) {
        throw new ExportTarError(
          `extended-name record near byte offset ${this.readBytes} is ${size} bytes, over the ${EXPORT_TAR_MAX_LONG_NAME_BYTES} byte cap`,
        );
      }
      const data = Buffer.alloc(size);
      await this.readBodyInto(data);
      if (typeflag === "L") {
        name = data.toString("utf8").replace(/\0+$/, "");
      } else {
        this.paxPath = paxRecordValue(data, "path") ?? this.paxPath;
      }
      return this.next();
    }
    if (this.paxPath) {
      name = this.paxPath;
      this.paxPath = null;
    }
    return { path: name, typeflag, size, linkname };
  }

  /** Consume up to `buf.length` body bytes; 0 once the entry is drained. */
  async readBody(buf: Buffer): Promise<number> {
    if (!this.source) throw new ExportTarError("tar reader already closed");
    if (this.pendingBody === 0) return 0;
    const take = Math.min(buf.length, this.pendingBody);
    await this.readBodyInto(buf.subarray(0, take));
    return take;
  }

  async skipBody(): Promise<void> {
    if (!this.source) throw new ExportTarError("tar reader already closed");
    await this.discard(this.pendingBody + this.pendingPad);
    this.pendingBody = 0;
    this.pendingPad = 0;
  }

  async close(): Promise<void> {
    if (this.source) {
      await this.source.close();
      this.source = null;
    }
  }

  /** Copy exactly `buf.length` bytes of the entry into `buf` (body first, then padding). */
  private async readBodyInto(buf: Buffer): Promise<void> {
    if (!this.source) throw new ExportTarError("tar reader already closed");
    let filled = 0;
    while (filled < buf.length) {
      if (this.pendingPad > 0 && this.pendingBody === 0) {
        // The entry's real body is exhausted; padding pads the READ, not the write.
        throw new ExportTarError("body over-read past entry size");
      }
      const need = buf.length - filled;
      const chunk = await this.source.pull(need);
      if (chunk === null || chunk.length === 0)
        throw new ExportTarError("archive truncated mid-entry");
      chunk.copy(buf, filled);
      filled += chunk.length;
      this.account(chunk.length);
    }
    // When the body ends mid-block, its padding rides the same block — but
    // when the body ended exactly on a block boundary, the padding blocks
    // still need consuming before the next header.
    if (this.pendingBody === 0 && this.pendingPad > 0) {
      await this.discard(this.pendingPad);
      this.pendingPad = 0;
    }
  }

  /** Read and throw away exactly n bytes of the open entry — in bounded
   * chunks. Pulling the full remainder at once made the ByteSource
   * accumulate an entire multi-GiB entry in memory (and the repeated
   * re-concat turned the skip quadratic): a real 12 GB assistant.db entry
   * desynced/oomed the inspect pass. */
  private async discard(n: number): Promise<void> {
    if (!this.source) throw new ExportTarError("tar reader already closed");
    let left = n;
    while (left > 0) {
      const chunk = await this.source.pull(Math.min(left, SKIP_CHUNK_BYTES));
      if (chunk === null || chunk.length === 0)
        throw new ExportTarError("archive truncated mid-entry");
      this.account(chunk.length);
      left -= chunk.length;
    }
  }

  /** Book-keep how many consumed bytes were body vs padding. */
  private account(consumed: number): void {
    this.readBytes += consumed;
    const fromBody = Math.min(consumed, this.pendingBody);
    this.pendingBody -= fromBody;
    this.pendingPad -= consumed - fromBody;
  }
}

/**
 * A buffered byte source over the archive file: gzip-compressed input is
 * decompressed transparently (magic-byte sniffed, not extension-trusted).
 * `pull(n)` returns exactly n bytes unless the stream ends first.
 */
class ByteSource {
  private stream: AsyncIterable<Buffer>;
  private iterator: AsyncIterator<Buffer> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;
  private closed = false;

  private constructor(stream: AsyncIterable<Buffer>) {
    this.stream = stream;
  }

  static async open(bundlePath: string): Promise<ByteSource> {
    const gz = await isGzipped(bundlePath);
    const raw = createReadStream(bundlePath, { highWaterMark: 256 * 1024 });
    const stream: AsyncIterable<Buffer> = gz
      ? (raw.pipe(createGunzip()) as AsyncIterable<Buffer>)
      : raw;
    const source = new ByteSource(stream);
    source.iterator = stream[Symbol.asyncIterator]();
    return source;
  }

  async pull(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.iterator!.next();
      if (next.done) {
        this.done = true;
        break;
      }
      this.buffer =
        this.buffer.length === 0
          ? next.value
          : Buffer.concat([this.buffer, next.value]);
    }
    if (this.buffer.length === 0) return null;
    const take = Math.min(n, this.buffer.length);
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.iterator?.return?.(undefined).catch(() => undefined);
  }
}

async function isGzipped(bundlePath: string): Promise<boolean> {
  const handle = await fs.open(bundlePath, "r");
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((b) => b === 0);
}

function isUstarHeader(block: Buffer): boolean {
  const magic = block.subarray(257, 262).toString("binary");
  if (magic !== "ustar") return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20;
      continue;
    }
    sum += block[i]!;
  }
  let recorded = 0;
  let sawDigit = false;
  for (const b of block.subarray(148, 156)) {
    if (b! >= 0x30 && b! <= 0x37) {
      recorded = recorded * 8 + (b! - 0x30);
      sawDigit = true;
      continue;
    }
    if (sawDigit) break;
  }
  return recorded === sum;
}

function headerName(header: Buffer): string {
  // A ustar prefix field extends the name (prefix + "/" + name) when present.
  const name = nulTrim(header.subarray(0, 100));
  const prefix = nulTrim(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function readHeaderSize(header: Buffer): number {
  const sizeField = header.subarray(124, 136);
  // GNU base-256: the high bit of the first byte flags a big-endian binary
  // number — the ONLY way a real tar expresses an entry larger than ustar's
  // 11-octal-digit field (8 GiB - 1). A real 12 GB assistant.db arrives
  // exactly this way; parsing it as octal yields a garbage size, desyncs the
  // body/pad bookkeeping, and surfaces downstream as "bad header magic".
  if (sizeField[0] !== undefined && sizeField[0] & 0x80) {
    let size = sizeField[0] & 0x7f;
    for (let i = 1; i < sizeField.length; i++) size = size * 256 + sizeField[i]!;
    return size;
  }
  let size = 0;
  for (const b of sizeField) {
    if (b === 0 || b === 0x20) continue;
    size = size * 8 + (b! - 0x30);
  }
  return size;
}

function nulTrim(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf
    .subarray(0, end === -1 ? buf.length : end)
    .toString("utf8")
    .trim();
}

/** PAX record format: "%d %s=%s\n" — value of the named record, if present. */
function paxRecordValue(data: Buffer, key: string): string | null {
  for (const record of data.toString("utf8").split("\n")) {
    if (!record) continue;
    const eq = record.indexOf("=");
    if (eq === -1) continue;
    if (record.slice(0, eq).replace(/^\d+\s/, "") === key)
      return record.slice(eq + 1);
  }
  return null;
}

/** sha256 of the DECOMPRESSED archive bytes — the export's stable identity. */
async function archiveFingerprint(bundlePath: string): Promise<string> {
  const reader = await TarReader.open(bundlePath);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const header = await reader.next();
      if (header === null) break;
      const chunk = Buffer.alloc(
        Math.min(1024 * 1024, Math.max(1, header.size)),
      );
      for (;;) {
        const read = await reader.readBody(chunk);
        if (read === 0) break;
        hash.update(chunk.subarray(0, read));
      }
    }
  } finally {
    await reader.close();
  }
  return hash.digest("hex");
}

/**
 * Inspect an export archive: map the top-level volumes, count the entries,
 * fingerprint the content. Throws `ExportTarError` when the workspace volume
 * is missing, volume names are ambiguous, or the top level is something else
 * entirely.
 */
export async function inspectExportTar(
  bundlePath: string,
): Promise<ExportTarInfo> {
  const fingerprint = await archiveFingerprint(bundlePath);
  const reader = await TarReader.open(bundlePath);
  const topLevel = new Map<
    string,
    { dirRecord: boolean; directFile: boolean; hasContent: boolean }
  >();
  let entries = 0;
  let totalBytes = 0;
  try {
    for (;;) {
      const header = await reader.next();
      if (header === null) break;
      entries++;
      if (entries > EXPORT_TAR_MAX_ENTRIES) {
        throw new ExportTarError(
          `archive carries more than ${EXPORT_TAR_MAX_ENTRIES} entries`,
        );
      }
      if (header.size > EXPORT_TAR_MAX_ENTRY_BYTES) {
        throw new ExportTarError(
          `entry ${JSON.stringify(header.path)} is larger than the ${EXPORT_TAR_MAX_ENTRY_BYTES} byte cap`,
        );
      }
      totalBytes += header.size;
      if (totalBytes > EXPORT_TAR_MAX_TOTAL_BYTES) {
        throw new ExportTarError(
          `archive expands past the ${EXPORT_TAR_MAX_TOTAL_BYTES} byte cap`,
        );
      }
      const cleanedPath = header.path.replace(/^(?:\.\/)+/, "");
      const sep = cleanedPath.indexOf("/");
      const top = sep === -1 ? cleanedPath : cleanedPath.slice(0, sep);
      const nested = sep !== -1;
      const typeflag = header.typeflag;
      if (top && top !== "." && top !== "..") {
        const seen = topLevel.get(top) ?? {
          dirRecord: false,
          directFile: false,
          hasContent: false,
        };
        if (typeflag === "5") seen.dirRecord = true;
        if (!nested && (typeflag === "0" || typeflag === "\0"))
          seen.directFile = true;
        if (nested) seen.hasContent = true;
        topLevel.set(top, seen);
      }
      await reader.skipBody();
    }
  } finally {
    await reader.close();
  }

  const unexpected: UnexpectedTopLevelEntry[] = [];
  const volumes: Partial<Record<VolumeKind, string>> = {};
  const instancePrefixes = new Set<string>();
  for (const [name, seen] of topLevel) {
    const kind: "file" | "dir" | "other" =
      seen.hasContent || seen.dirRecord
        ? "dir"
        : seen.directFile
          ? "file"
          : "other";
    const direct = VOLUME_STATE_DIRS.find((dir) => dir === name);
    const suffixed = volumeSuffixKind(name);
    if ((direct || suffixed) && kind === "file") {
      throw new ExportTarError(
        `the archive has a top-level FILE named ${JSON.stringify(name)} where a volume directory belongs`,
      );
    }
    if (direct) {
      assignVolume(volumes, direct, name);
      continue;
    }
    if (suffixed) {
      assignVolume(volumes, suffixed, name);
      instancePrefixes.add(
        name
          .slice(0, name.length - suffixFor(suffixed).length)
          .replace(/-$/, ""),
      );
      continue;
    }
    unexpected.push({ name, kind });
  }
  if (instancePrefixes.size > 1) {
    throw new ExportTarError(
      `the archive mixes volumes of different instances: ${[...instancePrefixes].sort().join(", ")}`,
    );
  }
  if (!volumes.workspace) {
    throw new ExportTarError(
      "this archive doesn't look like a vellum.ai/export bundle — no top-level workspace volume " +
        "(expected `workspace/` or a docker volume dir ending in `-workspace`)",
    );
  }
  return {
    volumes: {
      workspace: volumes.workspace!,
      gatewaySecurity: volumes["gateway-security"],
      cesSecurity: volumes["ces-security"],
    },
    instanceId: instancePrefixes.size === 1 ? [...instancePrefixes][0]! : null,
    entries,
    totalBytes,
    fingerprint,
    unexpected,
  };
}

function volumeSuffixKind(name: string): VolumeKind | null {
  if (name.endsWith("-workspace")) return "workspace";
  if (name.endsWith("-gateway-sec")) return "gateway-security";
  if (name.endsWith("-ces-sec")) return "ces-security";
  return null;
}

function suffixFor(kind: VolumeKind): string {
  return kind === "workspace"
    ? "-workspace"
    : kind === "gateway-security"
      ? "-gateway-sec"
      : "-ces-sec";
}

function assignVolume(
  volumes: Partial<Record<VolumeKind, string>>,
  kind: VolumeKind,
  name: string,
): void {
  const existing = volumes[kind];
  if (existing) {
    throw new ExportTarError(
      `two top-level entries map to the ${kind} volume: ${existing} and ${name}`,
    );
  }
  volumes[kind] = name;
}

export interface ExportTarExtractResult {
  fileCount: number;
  totalBytes: number;
  symlinkCount: number;
  hardlinkCount: number;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Restore an export archive's volumes into `stagingDir`, remapped by
 * `stateDir`: a volume's top-level dir dissolves into
 * `<stagingDir>/<stateDir>/<stateName>/…`. Path-traversal and absolute paths
 * are fatal; symlinks and hardlinks only materialize when their resolved
 * target stays inside the staging tree (otherwise they're skipped with a
 * reason); char/block/fifo devices are never created.
 */
export async function extractExportTar(
  bundlePath: string,
  stagingDir: string,
  opts: { stateDir: string; volumes: ExportTarVolumes },
): Promise<ExportTarExtractResult> {
  const reader = await TarReader.open(bundlePath);
  const resolvedStaging = path.resolve(stagingDir);
  let fileCount = 0;
  let totalBytes = 0;
  let symlinkCount = 0;
  let hardlinkCount = 0;
  const skipped: Array<{ path: string; reason: string }> = [];
  try {
    for (;;) {
      const header = await reader.next();
      if (header === null) break;
      const rel = remapArchivePath(header.path, opts.volumes, opts.stateDir);
      if (rel === null) {
        await reader.skipBody();
        continue;
      }
      const abs = path.join(resolvedStaging, rel);
      if (header.typeflag === "5") {
        await reader.skipBody();
        await fs.mkdir(abs, { recursive: true });
        continue;
      }
      if (header.typeflag === "0" || header.typeflag === "\0") {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const out = await fs.open(abs, "w");
        try {
          const chunk = Buffer.alloc(
            Math.min(1024 * 1024, Math.max(1, header.size)),
          );
          for (;;) {
            const read = await reader.readBody(chunk);
            if (read === 0) break;
            await out.write(chunk.subarray(0, read));
          }
        } finally {
          await out.close();
        }
        fileCount++;
        totalBytes += header.size;
        continue;
      }
      if (header.typeflag === "2") {
        await reader.skipBody();
        const target = header.linkname ?? "";
        const resolved = path.resolve(path.dirname(abs), target);
        if (
          resolved !== resolvedStaging &&
          !resolved.startsWith(resolvedStaging + path.sep)
        ) {
          skipped.push({
            path: header.path,
            reason: `symlink escapes the archive (${target})`,
          });
          continue;
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.symlink(target, abs);
        symlinkCount++;
        continue;
      }
      if (header.typeflag === "1") {
        await reader.skipBody();
        const target = header.linkname ?? "";
        const remapped = remapArchivePath(target, opts.volumes, opts.stateDir);
        const targetAbs =
          remapped === null ? null : path.join(resolvedStaging, remapped);
        if (!targetAbs || !(await pathExists(targetAbs))) {
          skipped.push({
            path: header.path,
            reason: `hardlink target missing from the archive (${target})`,
          });
          continue;
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.link(targetAbs, abs);
        hardlinkCount++;
        continue;
      }
      // 3/4/6: char device, block device, fifo — nothing in an assistant's
      // volumes legitimately is one.
      skipped.push({
        path: header.path,
        reason: `unsupported entry type (${JSON.stringify(header.typeflag)})`,
      });
      await reader.skipBody();
    }
  } finally {
    await reader.close();
  }
  return { fileCount, totalBytes, symlinkCount, hardlinkCount, skipped };
}

/**
 * `<topLevel>/<rest>` → `<stateDir>/<stateName>/<rest>` for archive entries
 * inside a mapped volume; null for everything else (the inspect pass's
 * `unexpected` report covers those). Traversal and absolute paths are fatal:
 * an archive entry never writes outside the staging tree.
 */
function remapArchivePath(
  archivePath: string,
  volumes: ExportTarVolumes,
  stateDir: string,
): string | null {
  const cleaned = archivePath
    .replace(/^(?:\.\/)+/, "")
    .split("\\")
    .join("/");
  if (
    cleaned.startsWith("../") ||
    cleaned === ".." ||
    path.isAbsolute(cleaned)
  ) {
    throw new ExportTarError(
      `archive entry escapes the archive: ${JSON.stringify(archivePath)}`,
    );
  }
  const sep = cleaned.indexOf("/");
  const top = sep === -1 ? cleaned : cleaned.slice(0, sep);
  const rest = sep === -1 ? "" : cleaned.slice(sep + 1);
  const stateName =
    volumes.workspace === top
      ? "workspace"
      : volumes.gatewaySecurity === top
        ? "gateway-security"
        : volumes.cesSecurity === top
          ? "ces-security"
          : null;
  if (stateName === null) return null;
  const normalized = path.normalize(
    `${stateDir}/${stateName}${rest ? `/${rest}` : ""}`,
  );
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized)
  ) {
    throw new ExportTarError(
      `archive entry escapes the staging tree: ${JSON.stringify(archivePath)}`,
    );
  }
  return normalized;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
