import { describe, test } from "node:test";

import { expect } from "../helpers/expect.js";
import { cadetLoginStep, installCadetCli, wakeAssistants } from "../../src/steps/wake.js";
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
    async cadetBinAvailable() {
      return true;
    },
    async npmGlobalRoot() {
      return null;
    },
    ...overrides,
  } as ProcessOps;
}

/**
 * Post-migration setup steps: install the cadet CLI and wake the migrated
 * assistants — but only when the migrated lockfile tracked any, and never
 * failing the migration over a convenience step.
 */
describe("wake steps: install-cadet / wake-assistants", () => {
  test("zero assistants: both steps skip and no commands run", async () => {
    let installed = 0;
    let woken = 0;
    const ops = baseOps({
      async installCadet() {
        installed++;
      },
      async cadetWakeAll() {
        woken++;
      },
    });

    const install = await installCadetCli(ops, 0);
    expect(install.status).toBe("skipped");
    const wake = await wakeAssistants(ops, 0, true);
    expect(wake.status).toBe("skipped");
    expect(installed).toBe(0);
    expect(woken).toBe(0);
  });

  test("assistants present: install then wake --all", async () => {
    let woken = 0;
    const ops = baseOps({
      async cadetWakeAll() {
        woken++;
      },
    });

    const install = await installCadetCli(ops, 2);
    expect(install.status).toBe("completed");
    expect(install.summary).toContain("cadet CLI installed globally");
    expect(install.data?.["binAvailable"]).toBe(true);
    const wake = await wakeAssistants(ops, 2, install.data?.["binAvailable"] === true);
    expect(wake.status).toBe("completed");
    expect(wake.summary).toContain("woke 2 assistant(s)");
    expect(woken).toBe(1);
  });

  test("installed but no cadet binary on PATH: honest warning, wake skipped", async () => {
    let woken = 0;
    const ops = baseOps({
      async cadetBinAvailable() {
        return false;
      },
      async cadetWakeAll() {
        woken++;
      },
    });

    const install = await installCadetCli(ops, 1);
    expect(install.status).toBe("completed");
    expect(install.data?.["installed"]).toBe(true);
    expect(install.data?.["binAvailable"]).toBe(false);
    expect(install.summary).toContain("no `cadet` binary on PATH");
    expect(install.issues?.[0]?.severity).toBe("warning");
    expect(install.issues?.[0]?.message).toContain("ships no `cadet` bin yet");
    const wake = await wakeAssistants(ops, 1, install.data?.["binAvailable"] === true);
    expect(wake.status).toBe("skipped");
    expect(wake.summary).toContain("no `cadet` binary on PATH");
    expect(woken).toBe(0);
  });

  test("a failed install warns, never fails, and the wake is skipped", async () => {
    let woken = 0;
    const ops = baseOps({
      async installCadet() {
        throw new Error("npm registry unreachable");
      },
      async cadetWakeAll() {
        woken++;
      },
    });

    const install = await installCadetCli(ops, 1);
    expect(install.status).toBe("completed");
    expect(install.data?.["installed"]).toBe(false);
    expect(install.issues?.[0]?.severity).toBe("warning");
    expect(install.issues?.[0]?.message).toContain("npm install -g mycadet failed");
    expect(install.issues?.[0]?.message).toContain("npm registry unreachable");
    const wake = await wakeAssistants(ops, 1, install.data?.["binAvailable"] === true);
    expect(wake.status).toBe("skipped");
    expect(wake.summary).toContain("no `cadet` binary on PATH");
    expect(woken).toBe(0);
  });

  test("a failed wake warns and points at the manual command", async () => {
    const ops = baseOps({
      async cadetWakeAll() {
        throw new Error("no cadet on PATH");
      },
    });

    const wake = await wakeAssistants(ops, 1, true);
    expect(wake.status).toBe("completed");
    expect(wake.issues?.[0]?.severity).toBe("warning");
    expect(wake.summary).toContain("`cadet wake --all` manually");
  });
});

describe("cadet-login step", () => {
  test("skips when nothing was detected", async () => {
    let logins = 0;
    const result = await cadetLoginStep(baseOps({ cadetLogin: () => { logins++; return Promise.resolve(); } }), {
      binAvailable: true,
      detected: false,
    });
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("not needed");
    expect(logins).toBe(0);
  });

  test("skips when the cadet binary is missing", async () => {
    let logins = 0;
    const result = await cadetLoginStep(baseOps({ cadetLogin: () => { logins++; return Promise.resolve(); } }), {
      binAvailable: false,
      detected: true,
    });
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("no `cadet` binary");
    expect(logins).toBe(0);
  });

  test("runs the login and reports completion", async () => {
    let logins = 0;
    const result = await cadetLoginStep(baseOps({ cadetLogin: () => { logins++; return Promise.resolve(); } }), {
      binAvailable: true,
      detected: true,
    });
    expect(result.status).toBe("completed");
    expect(logins).toBe(1);
  });

  test("a failed login warns but never fails the migration", async () => {
    const result = await cadetLoginStep(
      baseOps({ cadetLogin: () => Promise.reject(new Error("no browser")) }),
      { binAvailable: true, detected: true },
    );
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("`cadet login` manually");
    expect(result.issues?.[0]?.severity).toBe("warning");
  });
});
