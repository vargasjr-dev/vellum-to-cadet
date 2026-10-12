import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import {
  migrateFromExport,
  packVellumRoot,
  stageExportedRoot,
  validateStagedRoot,
} from "../../src/export-contract.js";
import type { ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { buildFullVellum0126, cleanupFixtures } from "../helpers/build-fixture.js";

/** No-op ops: fixtures have no real processes to find or stop. */
const noopOps: ProcessOps = {
  async vellumVersion() {
    return null;
  },
  async find() {
    return [];
  },
  async vellumSleep() {},
  async cadetSleep() {},
  async installCadet() {},
  async cadetWakeAll() {},
  async cadetVersion() {
    return { version: null };
  },
  async dockerVolumeToDir() {},
  async dockerDirToVolume() {},
  async dockerAvailable() {
    return false;
  },
  async cadetLogin() {},
  async cadetBinAvailable() {
    return true;
  },
  async npmGlobalRoot() {
    return null;
  },
};

after(cleanupFixtures);

describe("export contract (Option B root tarball)", () => {
  test("round-trips a vellum root through pack → stage → validate → migrate", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const tarballPath = path.join(home, "vellum-root.tar");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");

    const packed = await packVellumRoot(root, tarballPath);
    expect(packed.path).toBe(tarballPath);
    expect(packed.bytes).toBeGreaterThan(0);

    // The staged copy is a vellum root in its own right.
    const staged = await stageExportedRoot(tarballPath);
    const verdict = await validateStagedRoot(staged);
    expect(verdict.ok).toBe(true);
    expect(verdict.markers).toContain(".vellum-assistant");
    await fs.rm(staged, { recursive: true, force: true });

    // Snapshot tmpdir scratch entries before migrating — the cleanup pin
    // must not be fooled by foreign or older scratch trees.
    const before = new Set(
      (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("vtc-export-")),
    );

    const report = await migrateFromExport(tarballPath, {
      cadetRoot,
      processOps: noopOps,
    });
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);

    // The stop step reports the skip honestly.
    const stop = report.steps.find((s) => s.step === "stop-assistant");
    expect(stop?.status).toBe("skipped");
    expect(stop?.summary).toContain("asleep by construction");

    // The engine's internal staging scratch is cleaned up after the run.
    const leftovers = (await fs.readdir(os.tmpdir())).filter(
      (d) => d.startsWith("vtc-export-") && !before.has(d),
    );
    expect(leftovers.length).toBe(0);

    // And the migration is real: the cadet root carries the user data.
    const note = await fs.readFile(
      path.join(cadetRoot, "workspace/notes/vellum-history.md"),
      "utf8",
    );
    expect(note).toContain("I used vellum before it was cadet");
  });

  test("a directory with no vellum markers fails validation", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-empty-"));
    const verdict = await validateStagedRoot(empty);
    expect(verdict.ok).toBe(false);
    await fs.rm(empty, { recursive: true, force: true });
  });

  test("a garbage tarball fails loudly and leaves no scratch", async () => {
    // Deliberately NOT named with the staging prefix — the scratch-cleanup
    // pin below scans for it, and this file must not count itself.
    const bad = path.join(os.tmpdir(), `garbage-${Date.now()}.tar`);
    await fs.writeFile(bad, "this is not a tarball");
    let threw = false;
    try {
      await migrateFromExport(bad, { processOps: noopOps });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await fs.rm(bad, { force: true });
    const leftovers = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("vtc-export-"));
    expect(leftovers.length).toBe(0);
  });
});
