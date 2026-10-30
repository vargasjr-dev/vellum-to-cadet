import { describe, test } from "node:test";
import { promises as fs, createWriteStream } from "node:fs";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { expect } from "../helpers/expect.js";
import {
  buildExportTar,
  buildVBundleArchive,
  rawTarHeader,
  tarEntryBytes,
} from "../helpers/vbundle-fixture.js";
import {
  extractExportTar,
  inspectExportTar,
  sniffBundleKind,
  ExportTarError,
} from "../../src/export-tar.js";

async function staging(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vtc-export-"));
}

async function writeTar(
  dir: string,
  bytes: Buffer,
  name = "export.tar",
): Promise<string> {
  const tarPath = path.join(dir, name);
  await fs.writeFile(tarPath, bytes);
  return tarPath;
}

const VOLUMES = [
  {
    path: "velly-workspace/config.json",
    data: Buffer.from('{"name":"velly"}'),
  },
  { path: "velly-workspace/skills/greet/SKILL.md", data: Buffer.from("hi") },
  {
    path: "velly-gateway-sec/gateway.sqlite",
    data: Buffer.from("gateway-bytes"),
  },
  { path: "velly-ces-sec/keys.bin", data: Buffer.from("keys") },
];

describe("sniffBundleKind", () => {
  test("classifies a .vbundle by its manifest-first layout", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildVBundleArchive({
        entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }],
      }),
    );
    expect(await sniffBundleKind(bundle)).toBe("vbundle");
  });

  test("classifies an export tar by its volume-first layout", async () => {
    const dir = await staging();
    const bundle = await writeTar(dir, buildExportTar({ entries: VOLUMES }));
    expect(await sniffBundleKind(bundle)).toBe("export-tar");
  });

  test("classifies a gzipped export tar", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({ entries: VOLUMES, gzip: true }),
    );
    expect(await sniffBundleKind(bundle)).toBe("export-tar");
  });

  test("returns unknown for a non-tar file", async () => {
    const dir = await staging();
    const file = await writeTar(
      dir,
      Buffer.from("not a tar at all"),
      "junk.bin",
    );
    expect(await sniffBundleKind(file)).toBe("unknown");
  });
});

describe("inspectExportTar: volume mapping", () => {
  test("maps docker-style suffixed volume names and derives the instance id", async () => {
    const dir = await staging();
    const bundle = await writeTar(dir, buildExportTar({ entries: VOLUMES }));
    const info = await inspectExportTar(bundle);
    expect(info.volumes.workspace).toBe("velly-workspace");
    expect(info.volumes.gatewaySecurity).toBe("velly-gateway-sec");
    expect(info.volumes.cesSecurity).toBe("velly-ces-sec");
    expect(info.instanceId).toBe("velly");
    expect(info.unexpected).toEqual([]);
  });

  test("maps exact state-dir names without an instance id", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          { path: "workspace/config.json", data: Buffer.from("{}") },
          { path: "gateway-security/gateway.sqlite", data: Buffer.from("db") },
        ],
      }),
    );
    const info = await inspectExportTar(bundle);
    expect(info.volumes.workspace).toBe("workspace");
    expect(info.volumes.gatewaySecurity).toBe("gateway-security");
    expect(info.volumes.cesSecurity).toBeUndefined();
    expect(info.instanceId).toBe(null);
  });

  test("reports unexpected top-level entries without failing", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          { path: "velly-workspace/config.json", data: Buffer.from("{}") },
          { path: "README.txt", data: Buffer.from("hello") },
          { path: "extra-dir/nested/file.txt", data: Buffer.from("x") },
        ],
      }),
    );
    const info = await inspectExportTar(bundle);
    expect(info.unexpected.map((u) => u.name).sort()).toEqual([
      "README.txt",
      "extra-dir",
    ]);
  });

  test("fails loudly when no workspace volume is present", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          { path: "velly-gateway-sec/gateway.sqlite", data: Buffer.from("db") },
        ],
      }),
    );
    let message = "";
    try {
      await inspectExportTar(bundle);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("doesn't look like a vellum.ai/export bundle");
  });

  test("fails when two top-level entries map to the same volume", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          { path: "a-workspace/config.json", data: Buffer.from("{}") },
          { path: "b-workspace/config.json", data: Buffer.from("{}") },
        ],
      }),
    );
    let message = "";
    try {
      await inspectExportTar(bundle);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("two top-level entries");
  });

  test("fails when suffixed volumes mix instance prefixes", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          { path: "velly-workspace/config.json", data: Buffer.from("{}") },
          { path: "other-gateway-sec/gateway.sqlite", data: Buffer.from("db") },
        ],
      }),
    );
    let message = "";
    try {
      await inspectExportTar(bundle);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("different instances");
  });
});

describe("extractExportTar", () => {
  test("remaps volume dirs into the state dir and restores the trees", async () => {
    const dir = await staging();
    const bundle = await writeTar(dir, buildExportTar({ entries: VOLUMES }));
    const out = await staging();

    const result = await extractExportTar(bundle, out, {
      stateDir: ".vellum",
      volumes: (await inspectExportTar(bundle)).volumes,
    });

    expect(result.fileCount).toBe(4);
    expect(result.symlinkCount).toBe(0);
    expect(
      await fs.readFile(
        path.join(out, ".vellum/workspace/config.json"),
        "utf8",
      ),
    ).toBe('{"name":"velly"}');
    expect(
      await fs.readFile(
        path.join(out, ".vellum/workspace/skills/greet/SKILL.md"),
        "utf8",
      ),
    ).toBe("hi");
    expect(
      await fs.readFile(
        path.join(out, ".vellum/gateway-security/gateway.sqlite"),
        "utf8",
      ),
    ).toBe("gateway-bytes");
    expect(
      await fs.readFile(
        path.join(out, ".vellum/ces-security/keys.bin"),
        "utf8",
      ),
    ).toBe("keys");
  });

  test("restores a gzipped archive identically", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({ entries: VOLUMES, gzip: true }),
    );
    const out = await staging();
    const result = await extractExportTar(bundle, out, {
      stateDir: ".",
      volumes: (await inspectExportTar(bundle)).volumes,
    });
    expect(result.fileCount).toBe(4);
    expect(
      await fs.readFile(path.join(out, "workspace/config.json"), "utf8"),
    ).toBe('{"name":"velly"}');
  });

  test("restores a PAX long-path entry", async () => {
    const dir = await staging();
    const longPath = `velly-workspace/${"deep/".repeat(30)}leaf.bin`;
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [{ path: longPath, data: Buffer.from("long") }],
      }),
    );
    const out = await staging();
    await extractExportTar(bundle, out, {
      stateDir: ".",
      volumes: (await inspectExportTar(bundle)).volumes,
    });
    const restored = path.join(
      out,
      "workspace",
      longPath.slice("velly-workspace/".length),
    );
    expect(await fs.readFile(restored, "utf8")).toBe("long");
  });

  test("keeps in-root symlinks and skips escaping ones", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          {
            path: "velly-workspace/skills/real/SKILL.md",
            data: Buffer.from("real"),
          },
          {
            path: "velly-workspace/skills/alias/SKILL.md",
            linkTarget: "../real/SKILL.md",
          },
          {
            path: "velly-workspace/escape",
            linkTarget: "../../../../../etc/passwd",
          },
        ],
      }),
    );
    const out = await staging();
    const result = await extractExportTar(bundle, out, {
      stateDir: ".",
      volumes: (await inspectExportTar(bundle)).volumes,
    });
    expect(result.symlinkCount).toBe(1);
    expect(
      await fs.readlink(path.join(out, "workspace/skills/alias/SKILL.md")),
    ).toBe("../real/SKILL.md");
    expect(result.skipped).toEqual([
      {
        path: "velly-workspace/escape",
        reason: "symlink escapes the archive (../../../../../etc/passwd)",
      },
    ]);
    expect(await pathExists(path.join(out, "workspace/escape"))).toBe(false);
  });

  test("refuses traversal entries fatally and skips non-volume top levels", async () => {
    const dir = await staging();
    const bundle = await writeTar(
      dir,
      buildExportTar({
        entries: [
          { path: "velly-workspace/config.json", data: Buffer.from("{}") },
          { path: "velly-workspace/../../evil.txt", data: Buffer.from("boom") },
        ],
      }),
    );
    const out = await staging();
    let message = "";
    try {
      await extractExportTar(bundle, out, {
        stateDir: ".",
        volumes: (await inspectExportTar(bundle)).volumes,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("escapes the staging tree");
    expect(await pathExists(path.join(out, "evil.txt"))).toBe(false);
  });

  test("fingerprints content identically across gzip and name differences", async () => {
    const dir = await staging();
    const plain = buildExportTar({ entries: VOLUMES });
    const gz = buildExportTar({ entries: VOLUMES, gzip: true });
    const infoPlain = await inspectExportTar(
      await writeTar(dir, plain, "a.tar"),
    );
    const infoGz = await inspectExportTar(await writeTar(dir, gz, "b.tar"));
    expect(infoPlain.fingerprint).toBe(infoGz.fingerprint);
    expect(infoGz.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Stream a gzipped export tar carrying one entry of `size` body bytes —
 * without ever materializing the body in memory (zeros compress to ~nothing,
 * so the FILE stays small while the DECOMPRESSED stream is huge). */
async function writeGiantGzipTar(
  tarPath: string,
  entryPath: string,
  size: number,
): Promise<void> {
  async function* source(): AsyncGenerator<Buffer> {
    yield rawTarHeader(entryPath, size);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let left = size;
    while (left > 0) {
      const take = Math.min(left, chunk.length);
      yield take === chunk.length ? chunk : chunk.subarray(0, take);
      left -= take;
    }
    yield Buffer.alloc(512 * 2); // end-of-archive
  }
  await pipeline(Readable.from(source()), createGzip(), createWriteStream(tarPath));
}

// Real-export scale — a field regression: a real vellum.ai/export tar
// measured 83.5 GB / 442,091 entries with a 12.04 GB assistant.db, and the
// old reader died on it ("bad header magic", exit 6). Multi-GiB entries can
// ONLY be expressed in GNU base-256 (ustar's octal field tops out at
// 8 GiB - 1), and their bodies must be skipped in bounded chunks — never
// buffered whole.
describe("real-export scale", () => {
  const GIANT_SIZE = 8 * 1024 ** 3 + 1024 * 1024; // just over ustar's octal ceiling

  test("inspects an archive whose entry exceeds ustar's octal size field (GNU base-256)", { timeout: 300_000 }, async () => {
    const dir = await staging();
    const tarPath = path.join(dir, "export.tar.gz");
    await writeGiantGzipTar(tarPath, "velly-workspace/assistant.db", GIANT_SIZE);

    const info = await inspectExportTar(tarPath);
    expect(info.volumes.workspace).toBe("velly-workspace");
    expect(info.entries).toBe(1);
    expect(info.totalBytes).toBe(GIANT_SIZE);
  });

  test("rejects an oversized long-name record with a cap error, not a magic failure", async () => {
    const dir = await staging();
    const tarPath = await writeTar(
      dir,
      Buffer.concat([
        rawTarHeader("L", 1024 * 1024 * 1024, "L"), // a 1 GiB "long name"
        Buffer.alloc(512 * 2),
      ]),
      "huge-longname.tar",
    );
    await assert.rejects(
      async () => inspectExportTar(tarPath),
      /extended-name record .* byte cap/,
    );
  });

  test("names the byte offset when a header fails the magic check", async () => {
    const dir = await staging();
    const tarPath = await writeTar(
      dir,
      Buffer.concat([
        tarEntryBytes("velly-workspace/a.txt", Buffer.from("hi")),
        Buffer.alloc(512, 0x41), // garbage where a header belongs
      ]),
      "desynced.tar",
    );
    await assert.rejects(
      async () => inspectExportTar(tarPath),
      /bad header magic at decompressed byte offset 1024/,
    );
  });
});

// ExportTarError is part of the public surface — a touch here keeps the
// import honest when tests above change shape.
void ExportTarError;
