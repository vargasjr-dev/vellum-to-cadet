import { describe, test } from "node:test";

import { preflight } from "../../src/steps/preflight.js";
import type { DetectInfo, ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";

function detectInfo(assistantHandles: string[]): DetectInfo {
  return {
    vellumRoot: "/tmp",
    cadetRoot: "/tmp/fake-cadet-root",
    vellumRootExists: true,
    cadetRootExists: false,
    cadetRootPopulated: false,
    previousManifest: false,
    version: "0.12.6",
    assistantHandles,
    retiredCount: 0,
    deploymentKind: "docker",
    docker: { instances: [], images: [] },
    runningProcesses: [],
    rootSizeBytes: 0, // the desktop disk check is gated on rootSizeBytes > 0
    externalReferences: [],
  };
}

/** A fake npm ops pair for the preflight heads-up. */
function makeNpmOps(over: { root?: string | null; writable?: boolean | null } = {}) {
  return {
    npmGlobalRoot: async (): Promise<string | null> => over.root ?? null,
    npmGlobalRootWritable: async (): Promise<boolean | null> => over.writable ?? null,
  } as Pick<ProcessOps, "npmGlobalRoot" | "npmGlobalRootWritable">;
}

describe("preflight npm-global-root heads-up", () => {
  test("warns when assistants are tracked and npm's global directory is unwritable", async () => {
    const result = await preflight(detectInfo(["prime"]), {
      npmOps: makeNpmOps({ root: "/usr/local/lib/node_modules", writable: false }),
    });
    expect(result.status).toBe("completed");
    const warning = (result.issues ?? []).find((issue) => issue.severity === "warning");
    expect(warning?.message).toContain("/usr/local/lib/node_modules");
    expect(warning?.message).toContain("sudo npm install -g mycadet");
    expect(warning?.message).toContain("cadet wake --all");
  });

  test("stays silent when the global directory is writable", async () => {
    const result = await preflight(detectInfo(["prime"]), {
      npmOps: makeNpmOps({ root: "/usr/local/lib/node_modules", writable: true }),
    });
    expect(result.status).toBe("completed");
    expect(result.issues ?? []).toEqual([]);
  });

  test("stays silent when writability cannot be determined (npm absent)", async () => {
    const result = await preflight(detectInfo(["prime"]), {
      npmOps: makeNpmOps({ root: null, writable: null }),
    });
    expect(result.status).toBe("completed");
    expect(result.issues ?? []).toEqual([]);
  });

  test("no warning when the root tracks no assistants — the install step skips anyway", async () => {
    const result = await preflight(detectInfo([]), {
      npmOps: makeNpmOps({ root: "/usr/local/lib/node_modules", writable: false }),
    });
    expect(result.status).toBe("completed");
    expect(result.issues ?? []).toEqual([]);
  });
});
