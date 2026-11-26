import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { migrate } from "../../src/runner.js";
import { probeDesktopInstall, readDesktopMigrationState } from "../../src/desktop.js";
import type { ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { buildModernVellum, cleanupFixtures } from "../helpers/build-fixture.js";

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

describe("e2e: the desktop state file", () => {
  test("a completed migration books the vellum-side migrated state", async () => {
    const { root, home } = await buildModernVellum();
    const prevHome = process.env.HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "velly");

    try {
      const report = await migrate({ vellumRoot: root, cadetRoot, processOps: noopOps });
      expect(report.ok).toBe(true);

      // The state file: migrated, on the vellum root itself (modern layout),
      // naming the cadet root it landed in.
      const state = await readDesktopMigrationState(root);
      expect(state?.status).toBe("migrated");
      expect(state?.cadetRoot).toBe(cadetRoot);
      expect(state?.vellumRoot).toBe(root);

      // The probe goes quiet on the migrated machine — the desktop
      // prompt never comes back.
      const probe = await probeDesktopInstall({ vellumRoot: root });
      expect(probe).toEqual({ status: "quiet", reason: "already-migrated" });
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      else delete process.env.XDG_CONFIG_HOME;
      if (prevXdgDataHome !== undefined) process.env.XDG_DATA_HOME = prevXdgDataHome;
      else delete process.env.XDG_DATA_HOME;
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});
