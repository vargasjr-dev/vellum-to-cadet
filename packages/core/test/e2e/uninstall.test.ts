import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { runUninstall, type UninstallReport } from "../../src/uninstall.js";
import type { ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { buildFullVellum0126, buildModernVellum } from "../helpers/build-fixture.js";

/** No-op ops: fixtures have no real processes to find or stop. */
const noopOps: ProcessOps = {
  async find() {
    return [];
  },
  async vellumVersion() {
    return "0.12.6";
  },
  async vellumSleep() {},
  async cadetSleep() {},
};

/**
 * Uninstall reads the machine's HOME and the XDG/legacy env overrides.
 * Tests pin all of them to the fixture home and scrub the harness's own
 * overrides — the ONLY safe order: without the scrub, discovery would
 * qualify the real VELLUM_DATA_DIR of whatever machine runs the suite.
 */
function pinHome(home: string): () => void {
  const saved = {
    HOME: process.env.HOME,
    VELLUM_DATA_DIR: process.env.VELLUM_DATA_DIR,
    VELLUM_WORKSPACE_DIR: process.env.VELLUM_WORKSPACE_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.HOME = home;
  delete process.env.VELLUM_DATA_DIR;
  delete process.env.VELLUM_WORKSPACE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  return () => {
    for (const key of ["HOME", "VELLUM_DATA_DIR", "VELLUM_WORKSPACE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A legacy install plus every peripheral location uninstall should sweep. */
async function buildLegacyScenario(): Promise<{ home: string; root: string; config: string; sibling: string; locks: string[] }> {
  const { home, root } = await buildFullVellum0126();
  const config = path.join(home, ".config", "vellum");
  await fs.mkdir(path.join(config, "logs"), { recursive: true });
  await fs.writeFile(path.join(config, "config.json"), "{}\n");
  const sibling = path.join(home, ".local", "share", "vellum-dev");
  await fs.mkdir(path.join(sibling, "assistants", "velly", ".vellum"), { recursive: true });
  await fs.writeFile(path.join(sibling, "assistants", "velly", ".vellum", ".vellum-assistant"), "{}\n");
  const locks = [".vellum.lock.json", ".vellum.lockfile.json"].map((n) => path.join(home, n));
  await fs.writeFile(locks[0]!, "{}\n");
  await fs.writeFile(locks[1]!, "{}\n");
  return { home, root, config, sibling, locks };
}

/** The cadet-side things uninstall must NEVER touch. */
async function buildCadetSide(home: string): Promise<{ cadetRoot: string; backups: string }> {
  const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");
  await fs.mkdir(cadetRoot, { recursive: true });
  await fs.writeFile(path.join(cadetRoot, ".cadet-migration-manifest.json"), "{}\n");
  const backups = path.join(home, ".cadet-migration-backups");
  await fs.mkdir(path.join(backups, "20260101T000000"), { recursive: true });
  await fs.writeFile(path.join(backups, "20260101T000000", "manifest.json"), "{}\n");
  return { cadetRoot, backups };
}

describe("uninstall", () => {
  test("deletes every vellum location and keeps the cadet side intact", async () => {
    const s = await buildLegacyScenario();
    const { cadetRoot, backups } = await buildCadetSide(s.home);
    const restore = pinHome(s.home);
    try {
      const report = await runUninstall({ yes: true, processOps: noopOps });
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(0);
      // Every vellum location is gone.
      expect(await exists(s.root)).toBe(false);
      expect(await exists(s.config)).toBe(false);
      expect(await exists(s.sibling)).toBe(false);
      for (const lock of s.locks) expect(await exists(lock)).toBe(false);
      // The cadet side is untouched.
      expect(await exists(cadetRoot)).toBe(true);
      expect(await exists(backups)).toBe(true);
      expect(report.backupsKept).toBe(backups);
      // The report lists what went.
      const deleted = report.targets.filter((t) => t.deleted).map((t) => t.path);
      expect(deleted).toContain(s.root);
      expect(deleted).toContain(s.config);
      expect(deleted).toContain(s.sibling);
    } finally {
      restore();
    }
  });

  test("--dry-run lists everything and deletes nothing", async () => {
    const s = await buildLegacyScenario();
    const restore = pinHome(s.home);
    try {
      const report = await runUninstall({ dryRun: true, yes: true, processOps: noopOps });
      expect(report.ok).toBe(true);
      expect(report.dryRun).toBe(true);
      expect(report.targets.length).toBeGreaterThan(0);
      expect(report.targets.every((t) => !t.deleted)).toBe(true);
      expect(await exists(s.root)).toBe(true);
      expect(await exists(s.config)).toBe(true);
      for (const lock of s.locks) expect(await exists(lock)).toBe(true);
    } finally {
      restore();
    }
  });

  test("without --yes and a non-TTY stdin, nothing is deleted (declined)", async () => {
    const s = await buildLegacyScenario();
    const restore = pinHome(s.home);
    try {
      const report = await runUninstall({ processOps: noopOps });
      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(10);
      expect(await exists(s.root)).toBe(true);
      expect(await exists(s.config)).toBe(true);
    } finally {
      restore();
    }
  });

  test("assistants that refuse to sleep abort the run before any deletion", async () => {
    const s = await buildLegacyScenario();
    const restore = pinHome(s.home);
    try {
      const stubborn: ProcessOps = {
        async find() {
          return [{ pid: 4242, command: "vellum-assistant --stubborn" }];
        },
        async vellumVersion() {
          return "0.12.6";
        },
        async vellumSleep() {},
        async cadetSleep() {},
      };
      const report = await runUninstall({ yes: true, processOps: stubborn });
      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(4);
      expect(report.targets.length).toBe(0);
      expect(await exists(s.root)).toBe(true);
    } finally {
      restore();
    }
  });

  test("successfully stopped assistants are reported, then the run proceeds", async () => {
    const s = await buildLegacyScenario();
    const restore = pinHome(s.home);
    try {
      let called = 0;
      const sleepy: ProcessOps = {
        async find() {
          return called++ === 0 ? [{ pid: 4242, command: "vellum-assistant --sleepy" }] : [];
        },
        async vellumVersion() {
          return "0.12.6";
        },
        async vellumSleep() {},
        async cadetSleep() {},
      };
      const report = await runUninstall({ yes: true, processOps: sleepy });
      expect(report.ok).toBe(true);
      expect(report.stopped.length).toBe(1);
      expect(report.stopped[0]!.pid).toBe(4242);
      expect(await exists(s.root)).toBe(false);
    } finally {
      restore();
    }
  });

  test("an env-override dir without vellum markers is never a target", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-"));
    const junk = path.join(home, "not-vellum");
    await fs.mkdir(junk, { recursive: true });
    await fs.writeFile(path.join(junk, "important.txt"), "keep me\n");
    const savedDataDir = process.env.VELLUM_DATA_DIR;
    process.env.VELLUM_DATA_DIR = junk;
    const restore = pinHome(home);
    try {
      const report = await runUninstall({ yes: true, processOps: noopOps });
      expect(report.ok).toBe(true);
      expect(await exists(junk)).toBe(true);
      expect(report.targets.map((t) => t.path)).not.toContain(junk);
    } finally {
      restore();
      if (savedDataDir !== undefined) process.env.VELLUM_DATA_DIR = savedDataDir;
    }
  });

  test("modern XDG layout: the production root and env sibling both go", async () => {
    const modern = await buildModernVellum();
    const sibling = await buildModernVellum(modern.home, "vellum-staging");
    const restore = pinHome(modern.home);
    try {
      const report = await runUninstall({ yes: true, processOps: noopOps });
      expect(report.ok).toBe(true);
      expect(await exists(modern.root)).toBe(false);
      expect(await exists(sibling.root)).toBe(false);
    } finally {
      restore();
    }
  });

  test("a machine with no vellum installation is a clean no-op", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-empty-"));
    const restore = pinHome(home);
    try {
      const report: UninstallReport = await runUninstall({ yes: true, processOps: noopOps });
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(0);
      expect(report.targets.length).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("uninstall cli surface", () => {
  // Spawned-CLI tests can't inject processOps, and this machine (like any
  // machine with vellum on it) has live processes pgrep will find — so the
  // spawned surface is only probed where discovery is never reached.
  test("--help documents the uninstall subcommand", async () => {
    const { spawnSync } = await import("node:child_process");
    const url = await import("node:url");
    const cliPath = path.join(
      url.fileURLToPath(new URL(".", import.meta.url)),
      "../../../dist/cli.js",
    );
    const proc = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("uninstall");
    expect(proc.stdout).toContain("DELETE");
  });

  test("uninstall rejects a --cadet-root argument", async () => {
    const { spawnSync } = await import("node:child_process");
    const url = await import("node:url");
    const cliPath = path.join(
      url.fileURLToPath(new URL(".", import.meta.url)),
      "../../../dist/cli.js",
    );
    const proc = spawnSync(process.execPath, [cliPath, "uninstall", "--cadet-root", "/tmp/x"], {
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("uninstall takes no root");
  });
});
