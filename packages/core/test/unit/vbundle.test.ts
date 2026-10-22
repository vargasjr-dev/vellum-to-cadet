import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect } from "../helpers/expect.js";
import { buildRawTar, buildVBundleArchive, fixtureManifest, tarEntryBytes } from "../helpers/vbundle-fixture.js";
import {
  extractVBundle,
  parseVBundleManifest,
  readVBundleManifest,
  VBundleError,
} from "../../src/vbundle.js";

async function staging(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vtc-vbundle-"));
}

async function writeBundle(dir: string, bytes: Buffer): Promise<string> {
  const bundlePath = path.join(dir, "backup.vbundle");
  await fs.writeFile(bundlePath, bytes);
  return bundlePath;
}

async function readStaged(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), "utf8");
}

describe("vbundle: extraction", () => {
  test("restores the workspace tree with every hash verified", async () => {
    const dir = await staging();
    const bundlePath = await writeBundle(
      dir,
      buildVBundleArchive({
        entries: [
          { path: "workspace/config.json", data: Buffer.from('{"name":"old"}') },
          { path: "workspace/data/db/assistant.db", data: Buffer.from("sqlite-bytes") },
          { path: "workspace/skills/greet/SKILL.md", data: Buffer.from("---\nname: greet\n---\nhi") },
        ],
      }),
    );
    const out = await staging();

    const result = await extractVBundle(bundlePath, out);

    const configBytes = Buffer.from('{"name":"old"}').length;
    const dbBytes = Buffer.from("sqlite-bytes").length;
    const skillBytes = Buffer.from("---\nname: greet\n---\nhi").length;
    expect(result.fileCount).toBe(3);
    expect(result.totalBytes).toBe(configBytes + dbBytes + skillBytes);
    expect(result.credentials).toEqual([]);
    expect(await readStaged(out, "workspace/config.json")).toBe('{"name":"old"}');
    expect(await readStaged(out, "workspace/data/db/assistant.db")).toBe("sqlite-bytes");
    expect(await readStaged(out, "workspace/skills/greet/SKILL.md")).toContain("name: greet");
    expect(result.manifest.assistant.name).toBe("test-bundle");
  });

  test("recreates safe relative symlinks and buffers credentials without writing them", async () => {
    const dir = await staging();
    const bundlePath = await writeBundle(
      dir,
      buildVBundleArchive({
        entries: [
          { path: "workspace/data/db/assistant.db", data: Buffer.from("db") },
          { path: "workspace/skills/real/SKILL.md", data: Buffer.from("real") },
          { path: "workspace/skills/alias/SKILL.md", linkTarget: "../real/SKILL.md" },
          { path: "credentials/anthropic", data: Buffer.from("sk-secret-value") },
        ],
      }),
    );
    const out = await staging();

    const result = await extractVBundle(bundlePath, out);

    expect(result.symlinkCount).toBe(1);
    const linkTarget = await fs.readlink(path.join(out, "workspace/skills/alias/SKILL.md"));
    expect(linkTarget).toBe("../real/SKILL.md");
    const resolved = path.resolve(
      path.dirname(path.join(out, "workspace/skills/alias/SKILL.md")),
      linkTarget,
    );
    expect(resolved.startsWith(path.resolve(path.join(out, "workspace")))).toBe(true);
    expect(result.credentials).toEqual([{ account: "anthropic", value: "sk-secret-value" }]);
    let credentialsOnDisk = false;
    for (const entry of await fs.readdir(path.join(out, "workspace"), { recursive: true })) {
      if (entry.includes("anthropic") || entry.includes("credentials")) credentialsOnDisk = true;
    }
    expect(credentialsOnDisk).toBe(false);
  });

  test("handles PAX extended headers for paths longer than 100 bytes", async () => {
    const longName = `workspace/skills/${"a-very-long-skill-name-".repeat(5)}tail/SKILL.md`;
    if (Buffer.byteLength(longName) <= 100) throw new Error("fixture name is not long enough");
    const dir = await staging();
    const bundlePath = await writeBundle(
      dir,
      buildVBundleArchive({
        entries: [
          { path: "workspace/data/db/assistant.db", data: Buffer.from("db") },
          { path: longName, data: Buffer.from("long") },
        ],
      }),
    );
    const out = await staging();

    const result = await extractVBundle(bundlePath, out);

    expect(result.fileCount).toBe(2);
    expect(await readStaged(out, longName)).toBe("long");
  });

  test("refuses an archive entry whose bytes do not match the manifest sha256", async () => {
    const dir = await staging();
    const bundlePath = await writeBundle(
      dir,
      buildVBundleArchive({
        entries: [{ path: "workspace/config.json", data: Buffer.from('{"name":"old"}') }],
      }),
    );
    // Rewrite the archive so the entry's bytes differ from the manifest's
    // recorded sha — same length, so the size check passes first.
    const manifest = fixtureManifest([
      { path: "workspace/config.json", sha256: "0".repeat(64), size_bytes: 14 },
    ]);
    const rawTar = Buffer.concat([
      tarEntryBytes("manifest.json", Buffer.from(JSON.stringify(manifest))),
      tarEntryBytes("workspace/config.json", Buffer.from('{"name":"n3w"}')),
      Buffer.alloc(1024),
    ]);
    const { gzipSync } = await import("node:zlib");
    await fs.writeFile(bundlePath, gzipSync(rawTar));

    await assert.rejects(
      async () => extractVBundle(bundlePath, await staging()),
      (err: unknown) => err instanceof VBundleError && /sha256 verification/.test(err.message),
    );
  });

  test("refuses an archive entry that is not listed in the manifest", async () => {
    const dir = await staging();
    const manifest = fixtureManifest([]);
    const { gzipSync } = await import("node:zlib");
    const bundlePath = await writeBundle(
      dir,
      gzipSync(
        buildRawTar([]).length >= 0
          ? Buffer.concat([
              tarEntryBytes("manifest.json", Buffer.from(JSON.stringify(manifest))),
              tarEntryBytes("workspace/extra.json", Buffer.from("unlisted")),
              Buffer.alloc(1024),
            ])
          : buildRawTar([]),
      ),
    );

    await assert.rejects(async () => extractVBundle(bundlePath, await staging()), /not listed in manifest/);
  });

  test("refuses a manifest-listed file the archive never carried", async () => {
    const dir = await staging();
    const manifest = fixtureManifest([
      { path: "workspace/missing.json", sha256: "a".repeat(64), size_bytes: 1 },
    ]);
    const { gzipSync } = await import("node:zlib");
    const bundlePath = await writeBundle(
      dir,
      gzipSync(
        Buffer.concat([
          tarEntryBytes("manifest.json", Buffer.from(JSON.stringify(manifest))),
          Buffer.alloc(1024),
        ]),
      ),
    );

    await assert.rejects(async () => extractVBundle(bundlePath, await staging()), /never carried/);
  });

  test("refuses traversal and absolute archive paths", async () => {
    for (const evil of ["workspace/../../escape.txt", "/etc/passwd", "workspace/data/../../../out.txt"]) {
      const dir = await staging();
      const manifest = fixtureManifest([
        { path: evil, sha256: "a".repeat(64), size_bytes: 1 },
      ]);
      const { gzipSync } = await import("node:zlib");
      const bundlePath = await writeBundle(
        dir,
        gzipSync(
          Buffer.concat([
            tarEntryBytes("manifest.json", Buffer.from(JSON.stringify(manifest))),
            tarEntryBytes(evil, Buffer.from("x")),
            Buffer.alloc(1024),
          ]),
        ),
      );
      await assert.rejects(async () => extractVBundle(bundlePath, await staging()), VBundleError);
    }
  });

  test("refuses symlinks whose target escapes the workspace", async () => {
    const dir = await staging();
    const { createHash } = await import("node:crypto");
    const linkSha = createHash("sha256").update("../../../etc/passwd").digest("hex");
    const manifest = fixtureManifest([
      { path: "workspace/evil", sha256: linkSha, size_bytes: 0, link_target: "../../../etc/passwd" },
    ]);
    const { gzipSync } = await import("node:zlib");
    const bundlePath = await writeBundle(
      dir,
      gzipSync(
        Buffer.concat([
          tarEntryBytes("manifest.json", Buffer.from(JSON.stringify(manifest))),
          tarEntryBytes("workspace/evil", Buffer.alloc(0), "../../../etc/passwd"),
          Buffer.alloc(1024),
        ]),
      ),
    );

    await assert.rejects(async () => extractVBundle(bundlePath, await staging()), /escapes the workspace/);
  });

  test("refuses an archive whose first entry is not the manifest", async () => {
    const dir = await staging();
    const { gzipSync } = await import("node:zlib");
    const bundlePath = await writeBundle(dir, gzipSync(buildRawTar([{ path: "workspace/config.json", data: Buffer.from("{}") }])));

    await assert.rejects(() => readVBundleManifest(bundlePath), /first entry/);
  });

  test("refuses bytes that are not a gzipped tar", async () => {
    const dir = await staging();
    const bundlePath = await writeBundle(dir, Buffer.from("plainly not a bundle"));
    await assert.rejects(() => readVBundleManifest(bundlePath), /not a readable .vbundle/);
  });
});

describe("vbundle: manifest validation", () => {
  test("accepts a valid manifest and verifies its self-checksum", () => {
    const manifest = fixtureManifest([
      { path: "workspace/data/db/assistant.db", sha256: "a".repeat(64), size_bytes: 2 },
    ]);
    const parsed = parseVBundleManifest(JSON.stringify(manifest));
    expect(parsed.assistant.id).toBe("vellum-test-bundle");
    expect(parsed.compatibility.min_runtime_version).toBe("0.12.0");
  });

  test("rejects a tampered checksum", () => {
    const manifest = fixtureManifest([]);
    manifest.checksum = "0".repeat(64);
    assert.throws(() => parseVBundleManifest(JSON.stringify(manifest)), /checksum mismatch/);
  });

  test("rejects unsupported schema versions", () => {
    const parsed: unknown = JSON.parse(
      JSON.stringify({
        schema_version: "1.0",
        bundle_id: "x",
        created_at: "2026-01-01T00:00:00.000Z",
        assistant: { id: "a", name: "n", runtime_version: "0.12.6" },
        origin: { mode: "self-hosted-local" },
        compatibility: { min_runtime_version: "0.12.0", max_runtime_version: null },
        contents: [],
        checksum: "0".repeat(64),
        secrets_redacted: false,
        export_options: { include_logs: true, include_browser_state: false, include_memory_vectors: false },
      }),
    );
    assert.throws(() => parseVBundleManifest(JSON.stringify(parsed)), /schema_version/);
  });

  test("rejects malformed contents entries", () => {
    const manifest = fixtureManifest([{ path: "workspace/x", sha256: "nothex", size_bytes: 1 }]);
    assert.throws(() => parseVBundleManifest(JSON.stringify(manifest)), /sha256/);
  });
});
