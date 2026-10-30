import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { computeManifestChecksum, type VBundleManifest } from "../../src/vbundle.js";

/**
 * Synthetic `.vbundle` archives for the tests — a test-side mirror of the
 * upstream vbundle-builder (ustar headers, PAX for >100-byte names, symlink
 * typeflag-2 records, manifest-first, two zero blocks, gzipped). The REAL
 * format's ground truth lives in src/vbundle.ts's docblock; these fixtures
 * exist so the parser is tested against byte-faithful archives.
 */

const BLOCK = 512;

const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  buf[offset + length - 1] = 0;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20;
      continue;
    }
    const byte = header[i];
    sum += byte ?? 0;
  }
  return sum;
}

function paxPathEntry(name: string): Buffer {
  const record = `path=${name}\n`;
  let prefix = `${record.length + 2} `;
  let full = `${prefix}${record}`;
  while (Buffer.byteLength(full) !== Number.parseInt(prefix)) {
    prefix = `${Buffer.byteLength(full)} `;
    full = `${prefix}${record}`;
  }
  const paxData = Buffer.from(full, "utf8");
  const header = Buffer.alloc(BLOCK);
  header.write("PaxHeader/entry", 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 124, 12, paxData.length);
  header[156] = "x".charCodeAt(0);
  header.write("ustar\0", 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);
  writeOctal(header, 148, 7, headerChecksum(header));
  header[155] = 0x20;
  const padded = Buffer.concat([paxData, Buffer.alloc((BLOCK - (paxData.length % BLOCK)) % BLOCK)]);
  return Buffer.concat([header, padded]);
}

function tarEntry(name: string, data: Buffer, linkTarget?: string): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const isSymlink = linkTarget !== undefined;
  const header = Buffer.alloc(BLOCK);
  nameBytes.subarray(0, 100).copy(header, 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 124, 12, isSymlink ? 0 : data.length);
  header[156] = isSymlink ? "2".charCodeAt(0) : "0".charCodeAt(0);
  if (isSymlink) Buffer.from(linkTarget, "utf8").subarray(0, 100).copy(header, 157);
  header.write("ustar\0", 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);
  writeOctal(header, 148, 7, headerChecksum(header));
  header[155] = 0x20;
  if (isSymlink) {
    if (nameBytes.length > 100) throw new Error("test helper: symlink name needs PAX");
    return header;
  }
  const paddedData = Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
  const entry = Buffer.concat([header, paddedData]);
  return nameBytes.length > 100 ? Buffer.concat([paxPathEntry(name), entry]) : entry;
}

export interface FixtureBundleFile {
  path: string;
  data?: Buffer;
  linkTarget?: string;
}

export interface FixtureBundleOptions {
  entries: FixtureBundleFile[];
  /** Raw manifest overrides (applied before the checksum is computed). */
  manifestOverrides?: Partial<VBundleManifest>;
  /** Override the final checksum string (tamper tests). */
  checksum?: string;
  /** Leave the manifest's schema_version malformed. */
  schemaVersion?: unknown;
}

/** Build a full .vbundle (gzipped tar bytes) from workspace/credentials entries. */
export function buildVBundleArchive(options: FixtureBundleOptions): Buffer {
  const contents = options.entries.map((f) =>
    f.linkTarget !== undefined
      ? { path: f.path, sha256: sha256Hex(f.linkTarget), size_bytes: 0, link_target: f.linkTarget }
      : {
          path: f.path,
          sha256: sha256Hex(f.data ?? Buffer.alloc(0)),
          size_bytes: (f.data ?? Buffer.alloc(0)).length,
        },
  );
  const manifest: VBundleManifest = {
    schema_version: 1,
    bundle_id: "11111111-2222-3333-4444-555555555555",
    created_at: "2026-01-01T00:00:00.000Z",
    assistant: { id: "vellum-test-bundle", name: "test-bundle", runtime_version: "0.12.6" },
    origin: { mode: "self-hosted-local", hostname: "old-machine" },
    compatibility: { min_runtime_version: "0.12.0", max_runtime_version: null },
    contents,
    checksum: "",
    secrets_redacted: false,
    export_options: { include_logs: true, include_browser_state: false, include_memory_vectors: false },
    ...options.manifestOverrides,
  };
  if (options.schemaVersion !== undefined) {
    (manifest as unknown as Record<string, unknown>).schema_version = options.schemaVersion;
  }
  manifest.checksum = options.checksum ?? computeManifestChecksum(manifest);
  const tar = Buffer.concat([
    tarEntry("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8")),
    ...options.entries.map((f) => tarEntry(f.path, f.data ?? Buffer.alloc(0), f.linkTarget)),
    Buffer.alloc(BLOCK * 2),
  ]);
  return gzipSync(tar);
}

/** Build a raw tar with the given entries (no manifest, no gzip) — parser misuse tests. */
export function buildRawTar(entries: FixtureBundleFile[]): Buffer {
  return Buffer.concat([
    ...entries.map((f) => tarEntry(f.path, f.data ?? Buffer.alloc(0), f.linkTarget)),
    Buffer.alloc(BLOCK * 2),
  ]);
}

/** A manifest-shaped object with a real checksum, for hand-built tars. */
export function fixtureManifest(contents: VBundleManifest["contents"]): VBundleManifest {
  const manifest: VBundleManifest = {
    schema_version: 1,
    bundle_id: "11111111-2222-3333-4444-555555555555",
    created_at: "2026-01-01T00:00:00.000Z",
    assistant: { id: "vellum-test-bundle", name: "test-bundle", runtime_version: "0.12.6" },
    origin: { mode: "self-hosted-local", hostname: "old-machine" },
    compatibility: { min_runtime_version: "0.12.0", max_runtime_version: null },
    contents,
    checksum: "",
    secrets_redacted: false,
    export_options: { include_logs: true, include_browser_state: false, include_memory_vectors: false },
  };
  manifest.checksum = computeManifestChecksum(manifest);
  return manifest;
}

export function tarEntryBytes(name: string, data: Buffer, linkTarget?: string): Buffer {
  return tarEntry(name, data, linkTarget);
}

/** ustar's octal size field tops out at 8^11 - 1 bytes (~8 GiB - 1). */
const USTAR_MAX_SIZE = 8 ** 11 - 1;

/** Write the 12-byte size field: ustar octal when it fits, GNU base-256 when
 * it doesn't (real tars carry multi-GiB entries — a 12 GB assistant.db —
 * exclusively as base-256). */
function writeSizeField(header: Buffer, size: number): void {
  if (size <= USTAR_MAX_SIZE) {
    writeOctal(header, 124, 12, size);
    return;
  }
  for (let i = 124; i < 136; i++) header[i] = 0;
  header[124] = 0x80; // base-256 positive flag
  let remaining = size;
  for (let i = 135; i >= 125 && remaining > 0; i--) {
    header[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
}

/**
 * A raw 512-byte ustar file header claiming `size` body bytes — for test
 * entries too large to materialize (the caller streams the body itself).
 */
export function rawTarHeader(name: string, size: number, typeflag = "0"): Buffer {
  const header = Buffer.alloc(BLOCK);
  Buffer.from(name, "utf8").subarray(0, 100).copy(header, 0);
  writeOctal(header, 100, 8, 0o644);
  writeSizeField(header, size);
  header[156] = typeflag.charCodeAt(0);
  header.write("ustar\0", 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);
  writeOctal(header, 148, 7, headerChecksum(header));
  header[155] = 0x20;
  return header;
}

export interface ExportTarEntry {
  path: string;
  data?: Buffer;
  linkTarget?: string;
}

/**
 * Build a `vellum.ai/export` archive from top-level volume entries — no
 * manifest, optionally gzipped (the real endpoint serves plain tars; the
 * reader sniffs either). Dir entries materialize implicitly via parents.
 */
export function buildExportTar(options: {
  entries: ExportTarEntry[];
  gzip?: boolean;
}): Buffer {
  const tar = Buffer.concat([
    ...options.entries.map((f) => tarEntry(f.path, f.data ?? Buffer.alloc(0), f.linkTarget)),
    Buffer.alloc(BLOCK * 2),
  ]);
  return options.gzip ? gzipSync(tar) : tar;
}
