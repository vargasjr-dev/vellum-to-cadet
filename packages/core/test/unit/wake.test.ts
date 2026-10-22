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
    expect(install.summary).toContain("cadet installed globally");
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

  test("an EACCES from a root-owned npm prefix warns with the sudo fix, not the command echo", async () => {
    // Field report (Ubuntu): `npm install -g mycadet` failed writing the
    // root-owned /usr/local/lib/node_modules; the old catch printed
    // "npm install -g mycadet failed: Command failed: npm install -g
    // mycadet" — no reason, no next step.
    const ops = baseOps({
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & { stderr?: string };
        err.stderr = [
          "npm error code EACCES",
          "npm error syscall mkdir",
          "npm error path /usr/local/lib/node_modules",
          "npm error errno -13",
          "npm error",
          "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
        ].join("\n");
        throw err;
      },
      async npmGlobalRoot() {
        return "/usr/local/lib/node_modules";
      },
    });

    const install = await installCadetCli(ops, 2);
    expect(install.status).toBe("completed");
    expect(install.data?.["installed"]).toBe(false);
    const warning = install.issues?.[0];
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("(/usr/local/lib/node_modules)");
    expect(warning?.message).toContain("permission denied");
    expect(warning?.message).toContain("sudo npm install -g mycadet");
    expect(warning?.message).toContain("cadet wake --all");
    expect(warning?.message).not.toContain("Command failed:");
  });

  test("the permission failure offers a sudo retry through the hook and a successful one completes the install", async () => {
    const ops = baseOps({
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & { stderr?: string };
        err.stderr = "npm error code EACCES\nnpm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
        throw err;
      },
      async npmGlobalRoot() {
        return "/usr/local/lib/node_modules";
      },
      async cadetVersion() {
        return { version: "0.13.1" };
      },
    });
    const asked: Array<{ npmRoot: string | null }> = [];

    const install = await installCadetCli(ops, 2, {
      async retryAsSudo(info) {
        asked.push(info);
        return { ok: true };
      },
    });

    expect(asked).toEqual([{ npmRoot: "/usr/local/lib/node_modules" }]);
    expect(install.status).toBe("completed");
    expect(install.summary).toContain("via sudo");
    expect(install.summary).toContain("(0.13.1)");
    expect(install.data?.["installed"]).toBe(true);
    expect(install.data?.["binAvailable"]).toBe(true);
    expect(install.data?.["version"]).toBe("0.13.1");
    expect(install.issues ?? []).toEqual([]);
  });

  test("a declined sudo retry keeps the manual-fix warning", async () => {
    const ops = baseOps({
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & { stderr?: string };
        err.stderr = "npm error code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
        throw err;
      },
      async npmGlobalRoot() {
        return "/usr/local/lib/node_modules";
      },
    });

    const install = await installCadetCli(ops, 2, {
      async retryAsSudo() {
        return { ok: false, detail: "you declined the sudo retry" };
      },
    });

    expect(install.status).toBe("completed");
    expect(install.data?.["installed"]).toBe(false);
    const warning = install.issues?.[0];
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("you declined the sudo retry");
    expect(warning?.message).toContain("sudo npm install -g mycadet");
    expect(warning?.message).toContain("cadet wake --all");
  });

  test("a failed sudo retry names what happened to it", async () => {
    const ops = baseOps({
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & { stderr?: string };
        err.stderr = "npm error code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
        throw err;
      },
    });

    const install = await installCadetCli(ops, 1, {
      async retryAsSudo() {
        return { ok: false, detail: "sudo npm install -g mycadet exited 1" };
      },
    });

    const warning = install.issues?.[0];
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("sudo npm install -g mycadet exited 1");
    expect(warning?.message).toContain("cadet wake --all");
  });

  test("a successful sudo install without a cadet binary keeps the no-bin warning", async () => {
    const ops = baseOps({
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & { stderr?: string };
        err.stderr = "npm error code EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
        throw err;
      },
      async cadetBinAvailable() {
        return false;
      },
    });

    const install = await installCadetCli(ops, 1, {
      async retryAsSudo() {
        return { ok: true };
      },
    });

    expect(install.status).toBe("completed");
    expect(install.data?.["installed"]).toBe(true);
    expect(install.data?.["binAvailable"]).toBe(false);
    const warning = install.issues?.[0];
    expect(warning?.message).toContain("ships no `cadet` bin");
  });

  test("a missing npm binary gets its own actionable message", async () => {
    const ops = baseOps({
      installCadet() {
        const err = new Error("spawn npm ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      },
    });

    const install = await installCadetCli(ops, 1);
    const warning = install.issues?.[0];
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("npm was not found on PATH");
    expect(warning?.message).toContain("cadet wake --all");
  });

  test("a generic npm failure surfaces the registry's stderr detail instead of the command echo", async () => {
    const ops = baseOps({
      async installCadet() {
        const err = new Error("Command failed: npm install -g mycadet") as Error & { stderr?: string };
        err.stderr = [
          "npm error code ENOTFOUND",
          "npm error network request to https://registry.npmjs.org/mycadet failed",
        ].join("\n");
        throw err;
      },
    });

    const install = await installCadetCli(ops, 1);
    const warning = install.issues?.[0];
    expect(warning?.message).toContain("npm install -g mycadet failed:");
    expect(warning?.message).toContain("ENOTFOUND");
    expect(warning?.message).not.toContain("Command failed:");
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
    expect(wake.summary).toBe("cadet wake --all failed");
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

test("detached login runs and a timeout warns without failing the migration", async () => {
  let logins = 0;
  const result = await cadetLoginStep(baseOps({ cadetLogin: async () => { logins++; throw new Error("Login timed out after 5 minutes."); } }), {
    binAvailable: true, detected: true, interactive: false,
  });
  expect(logins).toBe(1);
  expect(result.status).toBe("completed");
  expect(result.issues?.[0]?.message).toContain("5 minutes");
});

test("wake errors keep the assistant and missing image without Docker wrappers", async () => {
  const result = await wakeAssistants(baseOps({ cadetWakeAll: async () => {
    throw new Error('Error: failed to wake \'assistant-test\': docker exited with code 1 — Error response from daemon: failed to resolve reference "docker.io/example/assistant:v1": docker.io/example/assistant:v1: not found');
  } }), 1, true);
  expect(result.summary).toBe("cadet wake --all failed");
  expect(result.issues?.[0]?.message).toBe('failed to wake \'assistant-test\': failed to resolve reference "docker.io/example/assistant:v1": not found');
});
