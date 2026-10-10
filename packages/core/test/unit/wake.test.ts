import { describe, test } from "node:test";

import { expect } from "../helpers/expect.js";
import { installCadetCli, wakeAssistants } from "../../src/steps/wake.js";
import type { ProcessOps } from "../../src/types.js";

/**
 * Post-migration setup steps: install the cadet CLI and wake the migrated
 * assistants — but only when the migrated lockfile tracked any, and never
 * failing the migration over a convenience step.
 */
describe("wake steps: install-cadet / wake-assistants", () => {
  test("zero assistants: both steps skip and no commands run", async () => {
    let installed = 0;
    let woken = 0;
    const ops: ProcessOps = {
      async find() {
        return [];
      },
      async vellumVersion() {
        return null;
      },
      async vellumSleep() {},
      async cadetSleep() {},
      async installCadet() {
        installed++;
      },
      async cadetWakeAll() {
        woken++;
      },
    };

    const install = await installCadetCli(ops, 0);
    expect(install.status).toBe("skipped");
    const wake = await wakeAssistants(ops, 0, true);
    expect(wake.status).toBe("skipped");
    expect(installed).toBe(0);
    expect(woken).toBe(0);
  });

  test("assistants present: install then wake --all", async () => {
    let woken = 0;
    const ops: ProcessOps = {
      async find() {
        return [];
      },
      async vellumVersion() {
        return null;
      },
      async vellumSleep() {},
      async cadetSleep() {},
      async installCadet() {},
      async cadetWakeAll() {
        woken++;
      },
    };

    const install = await installCadetCli(ops, 2);
    expect(install.status).toBe("completed");
    expect(install.summary).toContain("cadet CLI installed globally");
    const wake = await wakeAssistants(ops, 2, install.data?.["installed"] === true);
    expect(wake.status).toBe("completed");
    expect(wake.summary).toContain("woke 2 assistant(s)");
    expect(woken).toBe(1);
  });

  test("a failed install warns, never fails, and the wake is skipped", async () => {
    let woken = 0;
    const ops: ProcessOps = {
      async find() {
        return [];
      },
      async vellumVersion() {
        return null;
      },
      async vellumSleep() {},
      async cadetSleep() {},
      async installCadet() {
        throw new Error("npm registry unreachable");
      },
      async cadetWakeAll() {
        woken++;
      },
    };

    const install = await installCadetCli(ops, 1);
    expect(install.status).toBe("completed");
    expect(install.data?.["installed"]).toBe(false);
    expect(install.issues?.[0]?.severity).toBe("warning");
    expect(install.issues?.[0]?.message).toContain("npm registry unreachable");
    const wake = await wakeAssistants(ops, 1, install.data?.["installed"] === true);
    expect(wake.status).toBe("skipped");
    expect(wake.summary).toContain("cadet CLI is not installed");
    expect(woken).toBe(0);
  });

  test("a failed wake warns and points at the manual command", async () => {
    const ops: ProcessOps = {
      async find() {
        return [];
      },
      async vellumVersion() {
        return null;
      },
      async vellumSleep() {},
      async cadetSleep() {},
      async installCadet() {},
      async cadetWakeAll() {
        throw new Error("no cadet on PATH");
      },
    };

    const wake = await wakeAssistants(ops, 1, true);
    expect(wake.status).toBe("completed");
    expect(wake.issues?.[0]?.severity).toBe("warning");
    expect(wake.summary).toContain("`cadet wake --all` manually");
  });
});
