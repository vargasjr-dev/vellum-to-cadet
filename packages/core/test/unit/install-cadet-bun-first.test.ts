/**
 * install-cadet bun-first — the step prefers the bun arm when bun resolves
 * (its global dir is user-owned, so bun-managed machines never reach npm's
 * permission wall, where the sudo retry is useless: root's profile has no
 * bun), and falls back to the npm arm — which keeps the EACCES classify +
 * sudo retry — when bun is absent or the bun install fails. Field report:
 * a bun-managed user's `sudo npm install -g mycadet` landed in root's
 * prefix; `bun install -g mycadet` was the path that actually worked.
 */

import { describe, test } from "node:test";

import { expect } from "../helpers/expect.js";
import { installCadetCli } from "../../src/steps/wake.js";
import type { ProcessOps } from "../../src/types.js";

/** Shared no-op members; tests override the ones they exercise. */
function baseOps(overrides: Partial<ProcessOps> = {}): ProcessOps {
  return {
    async find() {
      return [];
    },
    async vellumVersion() {
      return null;
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
    async cadetBinAvailable() {
      return true;
    },
    async npmGlobalRoot() {
      return null;
    },
    ...overrides,
  } as ProcessOps;
}

describe("install-cadet bun-first", () => {
  test("bun on PATH: the bun arm installs and npm never runs", async () => {
    let bunInstalls = 0;
    let npmInstalls = 0;
    const ops = baseOps({
      async bunAvailable() {
        return true;
      },
      async bunInstallCadet() {
        bunInstalls++;
      },
      async installCadet() {
        npmInstalls++;
      },
    });

    const result = await installCadetCli(ops, 1);
    expect(result.status).toBe("completed");
    expect(bunInstalls).toBe(1);
    expect(npmInstalls).toBe(0);
  });

  test("no bun: the npm arm installs exactly as before", async () => {
    let bunProbed = 0;
    let npmInstalls = 0;
    const ops = baseOps({
      async bunAvailable() {
        bunProbed++;
        return false;
      },
      async bunInstallCadet() {
        throw new Error("the bun arm must not run");
      },
      async installCadet() {
        npmInstalls++;
      },
    });

    const result = await installCadetCli(ops, 1);
    expect(result.status).toBe("completed");
    expect(bunProbed).toBe(1);
    expect(npmInstalls).toBe(1);
  });

  test("a failed bun install falls back to the npm arm", async () => {
    let bunInstalls = 0;
    let npmInstalls = 0;
    const ops = baseOps({
      async bunAvailable() {
        return true;
      },
      async bunInstallCadet() {
        bunInstalls++;
        throw new Error("bun panicked");
      },
      async installCadet() {
        npmInstalls++;
      },
    });

    const result = await installCadetCli(ops, 1);
    expect(result.status).toBe("completed");
    expect(bunInstalls).toBe(1);
    expect(npmInstalls).toBe(1);
  });

  test("ops without the bun seam keep the npm-only behavior", async () => {
    let npmInstalls = 0;
    const ops = baseOps({
      async installCadet() {
        npmInstalls++;
      },
    });

    const result = await installCadetCli(ops, 1);
    expect(result.status).toBe("completed");
    expect(npmInstalls).toBe(1);
  });

  test("a bun failure falls through to npm, where the EACCES classify + sudo retry still engage", async () => {
    let asked = 0;
    const ops = baseOps({
      async bunAvailable() {
        return true;
      },
      async bunInstallCadet() {
        throw new Error("bun install failed: EACCES");
      },
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & {
          stderr?: string;
          code?: string;
        };
        err.stderr = "npm ERR! Error: EACCES: permission denied";
        throw err;
      },
      async npmGlobalRoot() {
        return "/usr/lib/node_modules";
      },
    });

    const result = await installCadetCli(ops, 1, {
      retryAsSudo: async () => {
        asked++;
        return { ok: false, detail: "you declined the sudo retry" };
      },
    });
    expect(asked).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.issues?.[0]?.message).toContain("sudo npm install -g mycadet");
  });
});
