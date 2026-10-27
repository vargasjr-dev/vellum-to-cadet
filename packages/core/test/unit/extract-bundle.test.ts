import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect } from "../helpers/expect.js";
import { buildExportTar, buildVBundleArchive } from "../helpers/vbundle-fixture.js";
import { extractBundleStep, sanitizeAssistantDirName } from "../../src/steps/extract-bundle.js";
import { discoverVellumRoots } from "../../src/discover.js";
import type { MigrateOptions } from "../../src/types.js";

function opts(over: Partial<MigrateOptions> = {}): MigrateOptions {
  return { ...over };
}

describe("extract-bundle: input validation", () => {
  test("refuses a missing bundle file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const result = await extractBundleStep(opts({ vellumRoot: home, bundlePath: path.join(home, "nope.vbundle") }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("no such file");
  });

  test("refuses encrypted .enc bundles", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const bundle = path.join(home, "backup.vbundle.enc");
    await fs.writeFile(bundle, Buffer.from("sealed"));
    const result = await extractBundleStep(opts({ vellumRoot: home, bundlePath: bundle }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain(".enc");
  });

  test("refuses when the vellum root does not exist — a restore never creates a root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(bundle, Buffer.from("gzip-later"));
    const result = await extractBundleStep(opts({ vellumRoot: path.join(home, "absent"), bundlePath: bundle }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("no vellum root");
  });
});

describe("extract-bundle: dry run", () => {
  test("plans the restore and writes nothing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants", "velly", ".vellum", ".vellum-assistant"), { recursive: true });
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(
      bundle,
      buildVBundleArchive({
        entries: [
          { path: "workspace/config.json", data: Buffer.from("{}") },
          { path: "credentials/anthropic", data: Buffer.from("sk-x") },
        ],
      }),
    );

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle, dryRun: true }));

    expect(result.status).toBe("planned");
    expect(result.summary).toContain("would restore");
    expect(result.summary).toContain("test-bundle");
    // The root is untouched: no new assistant dir, no staging dir.
    const after = await fs.readdir(path.join(root, "assistants"));
    expect(after).toEqual(["velly"]);
    // The credentials note is surfaced even in the plan.
    expect(result.issues?.some((i) => i.message.includes("credential"))).toBe(true);
  });
});

describe("extract-bundle: restore", () => {
  test("lands the assistant with discovery markers, into a modern root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants", "velly", ".vellum", ".vellum-assistant"), { recursive: true });
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(
      bundle,
      buildVBundleArchive({
        entries: [
          { path: "workspace/config.json", data: Buffer.from('{"name":"old"}') },
          { path: "workspace/skills/greet/SKILL.md", data: Buffer.from("---\nname: greet\n---\n") },
          { path: "credentials/anthropic", data: Buffer.from("sk-secret") },
        ],
      }),
    );

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("restored");
    const restored = path.join(root, "assistants", "test-bundle");
    // Modern roots nest the workspace under .vellum/ — the layout step dissolves it.
    expect(await fs.readFile(path.join(restored, ".vellum/workspace/config.json"), "utf8")).toBe('{"name":"old"}');
    // Discovery markers: the version file detect reads, and the strong marker
    // discovery trusts.
    expect(await fs.readFile(path.join(restored, ".vellum", ".vellum-assistant", "version"), "utf8")).toContain("0.12.6");
    // The discovery gate now trusts the root even in isolation.
    const roots = await discoverVellumRoots();
    void roots; // discovery reads the real HOME — asserted via markers below instead.
    expect(await fs.stat(path.join(restored, ".vellum", ".vellum-assistant"))).toBeTruthy();
    // Credentials were NOT written — the warning names them.
    expect(result.issues?.some((i) => i.severity === "warning" && i.message.includes("anthropic"))).toBe(true);
    // No staging dir left behind.
    const after = await fs.readdir(path.join(root, "assistants"));
    expect(after.sort()).toEqual(["test-bundle", "velly"]);
  });

  test("re-running the same bundle is a skipped no-op; a different bundle with the same name refuses", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants"), { recursive: true });
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(bundle, buildVBundleArchive({ entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }] }));

    const first = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(first.status).toBe("completed");

    const second = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(second.status).toBe("skipped");
    expect(second.summary).toContain("already restored");

    // A DIFFERENT bundle (different bundle_id) with the same assistant name
    // must never overwrite the restored one.
    const other = path.join(home, "other.vbundle");
    await fs.writeFile(
      other,
      buildVBundleArchive({
        entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }],
        manifestOverrides: { bundle_id: "99999999-2222-3333-4444-555555555555" },
      }),
    );
    const third = await extractBundleStep(opts({ vellumRoot: root, bundlePath: other }));
    expect(third.status).toBe("failed");
    expect(third.summary).toContain("already exists");
  });

  test("refuses to restore over an existing real assistant (no restore marker)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants", "test-bundle", ".vellum", ".vellum-assistant"), { recursive: true });
    await fs.writeFile(path.join(root, "assistants", "test-bundle", "config.json"), "{}");
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(bundle, buildVBundleArchive({ entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }] }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("already exists");
  });

  test("legacy roots take the workspace at the root itself", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".vellum");
    await fs.mkdir(root, { recursive: true });
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(bundle, buildVBundleArchive({ entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }] }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(result.status).toBe("completed");
    expect(await fs.readFile(path.join(root, "workspace/config.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(path.join(root, ".vellum-assistant", "version"), "utf8")).toContain("0.12.6");

    // A second restore refuses: the root already carries an assistant.
    const again = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(again.status).toBe("skipped"); // same bundle id → already restored
  });

  test("sweeps stale staging dirs left by dead runs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants", ".vtc-extract-deadbeef"), { recursive: true });
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(bundle, buildVBundleArchive({ entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }] }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(result.status).toBe("completed");
    expect(result.issues?.some((i) => i.message.includes("leftover extraction staging"))).toBe(true);
    const after = await fs.readdir(path.join(root, "assistants"));
    expect(after).toEqual(["test-bundle"]);
  });
});

describe("extract-bundle: vellum.ai/export tars", () => {
  const EXPORT_ENTRIES = [
    { path: "vellum-velly-workspace/config.json", data: Buffer.from('{"name":"velly"}') },
    { path: "vellum-velly-workspace/data/db/assistant.db", data: Buffer.from("sqlite") },
    { path: "vellum-velly-gateway-sec/gateway.sqlite", data: Buffer.from("gateway") },
    { path: "vellum-velly-ces-sec/keys.bin", data: Buffer.from("keys") },
  ];

  test("names the assistant from the volume instance id and lands all three volumes in a modern root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    // A DIFFERENT assistant already in the root (fixture name ≠ the export's
    // derived "velly") — a restore never touches existing assistants.
    await fs.mkdir(path.join(root, "assistants", "existing", ".vellum", ".vellum-assistant"), { recursive: true });
    await fs.writeFile(path.join(root, "assistants", "existing", ".vellum", ".vellum-assistant", "version"), "0.12.6\n");
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(bundle, buildExportTar({ entries: EXPORT_ENTRIES }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));

    expect(result.status).toBe("completed");
    // The instance id `vellum-velly` strips its brand prefix — the dir is
    // named for the handle alone, same rule the layout step applies.
    const restored = path.join(root, "assistants", "velly");
    expect(await fs.readFile(path.join(restored, ".vellum/workspace/config.json"), "utf8")).toBe('{"name":"velly"}');
    expect(await fs.readFile(path.join(restored, ".vellum/gateway-security/gateway.sqlite"), "utf8")).toBe("gateway");
    expect(await fs.readFile(path.join(restored, ".vellum/ces-security/keys.bin"), "utf8")).toBe("keys");
    // Discovery markers landed; the version file mirrors the root's own
    // version (the export tar carries no runtime version of its own).
    expect(await fs.stat(path.join(restored, ".vellum", ".vellum-assistant", "vtc-bundle-restore.json"))).toBeTruthy();
    expect(await fs.readFile(path.join(restored, ".vellum", ".vellum-assistant", "version"), "utf8")).toContain("0.12.6");
    const after = await fs.readdir(path.join(root, "assistants"));
    expect(after.sort()).toEqual(["existing", "velly"]);
  });

  test("re-running the same export is a skipped no-op; a changed export refuses", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants"), { recursive: true });
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(bundle, buildExportTar({ entries: EXPORT_ENTRIES }));

    const first = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(first.status).toBe("completed");

    const second = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));
    expect(second.status).toBe("skipped");
    expect(second.summary).toContain("already restored");

    // A DIFFERENT export (different content fingerprint) with the same
    // derived name must never overwrite the restored one.
    const changed = path.join(home, "changed.tar");
    await fs.writeFile(
      changed,
      buildExportTar({
        entries: [...EXPORT_ENTRIES.slice(0, 1), { path: "vellum-velly-workspace/extra.txt", data: Buffer.from("x") }],
      }),
    );
    const third = await extractBundleStep(opts({ vellumRoot: root, bundlePath: changed }));
    expect(third.status).toBe("failed");
    expect(third.summary).toContain("already exists");
  });

  test("legacy roots take the three volumes at the root itself", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, "vellum-root");
    await fs.mkdir(path.join(root, ".vellum-assistant"), { recursive: true });
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(
      bundle,
      buildExportTar({
        entries: [
          { path: "workspace/config.json", data: Buffer.from("{}") },
          { path: "gateway-security/gateway.sqlite", data: Buffer.from("db") },
        ],
      }),
    );

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));

    expect(result.status).toBe("completed");
    expect(await fs.readFile(path.join(root, "workspace/config.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(path.join(root, "gateway-security/gateway.sqlite"), "utf8")).toBe("db");
    expect(await fs.stat(path.join(root, ".vellum-assistant", "vtc-bundle-restore.json"))).toBeTruthy();
  });

  test("dry run plans the volume restore and writes nothing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants"), { recursive: true });
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(bundle, buildExportTar({ entries: EXPORT_ENTRIES }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle, dryRun: true }));

    expect(result.status).toBe("planned");
    expect(result.summary).toContain("dry run");
    expect(result.summary).toContain("velly");
    expect(result.issues?.some((i) => i.message.includes("not in any vellum lockfile"))).toBe(true);
    const after = await fs.readdir(path.join(root, "assistants"));
    expect(after).toEqual([]);
  });

  test("missing security volumes restore with a loud warning; unexpected top-level entries are reported", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants"), { recursive: true });
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(
      bundle,
      buildExportTar({
        entries: [
          { path: "workspace/config.json", data: Buffer.from("{}") },
          { path: "stray-dir/file.txt", data: Buffer.from("x") },
        ],
      }),
    );

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));

    expect(result.status).toBe("completed");
    expect(result.issues?.some((i) => i.message.includes("no gateway-security volume"))).toBe(true);
    expect(result.issues?.some((i) => i.message.includes("no ces-security volume"))).toBe(true);
    expect(result.issues?.some((i) => i.message.includes('"stray-dir"'))).toBe(true);
    // The stray top-level dir was NOT restored anywhere.
    const restored = path.join(root, "assistants", "export");
    expect(await fs.stat(path.join(restored, ".vellum/workspace/config.json"))).toBeTruthy();
    expect(await pathExistsIn(path.join(restored, ".vellum/stray-dir"))).toBe(false);
  });

  test("a non-tar --bundle fails with a format message", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".local", "share", "vellum");
    await fs.mkdir(root, { recursive: true });
    const bundle = path.join(home, "garbage.bin");
    await fs.writeFile(bundle, Buffer.from("definitely not a tar"));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle }));

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("unrecognized archive");
  });
});

async function pathExistsIn(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("extract-bundle: fresh-root bootstrap (--bundle with no installation)", () => {
  const EXPORT_ENTRIES = [
    { path: "vellum-velly-workspace/config.json", data: Buffer.from('{"name":"velly"}') },
    { path: "vellum-velly-workspace/data/db/assistant.db", data: Buffer.from("sqlite") },
    { path: "vellum-velly-gateway-sec/gateway.sqlite", data: Buffer.from("gateway") },
    { path: "vellum-velly-ces-sec/keys.bin", data: Buffer.from("keys") },
  ];

  test("a missing root is created modern: the volumes land under assistants/<name>/.vellum/", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".vellum"); // does not exist
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(bundle, buildExportTar({ entries: EXPORT_ENTRIES }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle, freshRoot: true }));

    expect(result.status).toBe("completed");
    expect(String(result.data?.["layout"])).toBe("modern");
    const restored = path.join(root, "assistants", "velly");
    expect(await fs.readFile(path.join(restored, ".vellum/workspace/config.json"), "utf8")).toBe('{"name":"velly"}');
    expect(await fs.readFile(path.join(restored, ".vellum/gateway-security/gateway.sqlite"), "utf8")).toBe("gateway");
    expect(await fs.readFile(path.join(restored, ".vellum/ces-security/keys.bin"), "utf8")).toBe("keys");
    expect(await fs.stat(path.join(restored, ".vellum", ".vellum-assistant", "vtc-bundle-restore.json"))).toBeTruthy();
  });

  test("an existing-but-markerless root (a vellum dir with no assistants) is populated modern, not legacy", async () => {
    // The user run that motivated bootstrap: ~/.vellum exists EMPTY, so
    // discovery finds nothing — the legacy-layout read of it would make the
    // root itself the assistant. freshRoot forces the modern shape instead.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".vellum");
    await fs.mkdir(root, { recursive: true });
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(bundle, buildExportTar({ entries: EXPORT_ENTRIES }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle, freshRoot: true }));

    expect(result.status).toBe("completed");
    expect(String(result.data?.["layout"])).toBe("modern");
    expect(
      await fs.readFile(path.join(root, "assistants", "velly", ".vellum/workspace/config.json"), "utf8"),
    ).toBe('{"name":"velly"}');
  });

  test("dry run plans the modern landing and creates nothing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".vellum");
    const bundle = path.join(home, "export.tar");
    await fs.writeFile(bundle, buildExportTar({ entries: EXPORT_ENTRIES }));

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle, freshRoot: true, dryRun: true }));

    expect(result.status).toBe("planned");
    expect(result.summary).toContain(path.join(root, "assistants/velly"));
    // Nothing created: the fresh root only appears on a real run.
    expect((await fs.readdir(home)).sort()).toEqual(["export.tar"]);
  });

  test("a .vbundle bootstraps modern too", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-extract-"));
    const root = path.join(home, ".vellum");
    const bundle = path.join(home, "backup.vbundle");
    await fs.writeFile(
      bundle,
      buildVBundleArchive({ entries: [{ path: "workspace/config.json", data: Buffer.from("{}") }] }),
    );

    const result = await extractBundleStep(opts({ vellumRoot: root, bundlePath: bundle, freshRoot: true }));

    expect(result.status).toBe("completed");
    expect(String(result.data?.["layout"])).toBe("modern");
    const landed = await fs.readdir(path.join(root, "assistants"));
    expect(landed.length).toBe(1);
    expect(
      await fs.stat(path.join(root, "assistants", landed[0]!, ".vellum", ".vellum-assistant", "vtc-bundle-restore.json")),
    ).toBeTruthy();
  });
});

describe("extract-bundle: assistant name sanitization", () => {
  test("strips path-hostile characters and falls back when empty", () => {
    expect(sanitizeAssistantDirName("fresh-eel-8di6pa")).toBe("fresh-eel-8di6pa");
    expect(sanitizeAssistantDirName("vellum/../../etc")).toBe("vellum....etc");
    expect(sanitizeAssistantDirName("..hidden")).toBe("hidden");
    expect(sanitizeAssistantDirName("   ")).toBe("restored-assistant");
    expect(sanitizeAssistantDirName("../..")).toBe("restored-assistant");
  });
});
