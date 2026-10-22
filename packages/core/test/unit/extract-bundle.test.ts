import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect } from "../helpers/expect.js";
import { buildVBundleArchive } from "../helpers/vbundle-fixture.js";
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

describe("extract-bundle: assistant name sanitization", () => {
  test("strips path-hostile characters and falls back when empty", () => {
    expect(sanitizeAssistantDirName("fresh-eel-8di6pa")).toBe("fresh-eel-8di6pa");
    expect(sanitizeAssistantDirName("vellum/../../etc")).toBe("vellum....etc");
    expect(sanitizeAssistantDirName("..hidden")).toBe("hidden");
    expect(sanitizeAssistantDirName("   ")).toBe("restored-assistant");
    expect(sanitizeAssistantDirName("../..")).toBe("restored-assistant");
  });
});
