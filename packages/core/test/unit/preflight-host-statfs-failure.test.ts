import { describe, test } from "node:test";

import { preflight } from "../../src/steps/preflight.js";
import type { DetectInfo, ProcessOps, StepIssue } from "../../src/types.js";
import { expect } from "../helpers/expect.js";

const GB = 1024 ** 3;
const INSTANCE = "vellum-prime-quail-3ezfs4";
const ONE_INSTANCE = [INSTANCE];

function detectInfo(instances: string[]): DetectInfo {
  return {
    vellumRoot: "/tmp",
    cadetRoot: "/tmp/fake-cadet-root",
    vellumRootExists: true,
    cadetRootExists: false,
    cadetRootPopulated: false,
    previousManifest: false,
    version: "0.12.6",
    assistantHandles: [],
    retiredCount: 0,
    deploymentKind: "docker",
    docker: { instances, images: [] },
    runningProcesses: [],
    rootSizeBytes: 0, // the desktop disk check is gated on rootSizeBytes > 0
    externalReferences: [],
  };
}

function makeDockerOps(over: { available?: boolean; free?: number; sizes?: Record<string, number | undefined> } = {}) {
  const ops = {
    dockerAvailable: async (): Promise<boolean> => over.available ?? true,
    dockerDiskFree: async (): Promise<number | undefined> => over.free,
    dockerVolumeSize: async (volume: string): Promise<number | undefined> => over.sizes?.[volume],
  };
  return { ops: ops as Pick<ProcessOps, "dockerAvailable" | "dockerVolumeSize" | "dockerDiskFree"> };
}

/**
 * The host-side scratch check must FAIL CLOSED when the host's free disk
 * space cannot be measured. The v0.0.14 run extracted straight into a
 * host-disk scratch tree; when the statfs probe fails, a warning stands the
 * guard down and a doomed run starts (the exact v0.0.13 failure mode the
 * docker-side checks already refuse).
 *
 * The preflight reads os.tmpdir() at call time and statfs() on it — pointing
 * TMPDIR at a path that does not exist makes statfs throw ENOENT and
 * freeBytesFor resolve null, no module mocking needed.
 */
const MISSING_TMPDIR = "/nonexistent-vtc-statfs-probe/does-not-exist";

describe("preflight host statfs failure", () => {
  test("fails closed when the host's free disk space cannot be measured", async () => {
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = MISSING_TMPDIR;
    try {
      const { ops } = makeDockerOps({
        free: 100 * GB,
        sizes: { [`${INSTANCE}-workspace`]: GB, [`${INSTANCE}-gateway-sec`]: GB, [`${INSTANCE}-ces-sec`]: GB },
      });
      const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
      expect(result.status).toBe("failed");
      const issues = result.issues ?? [];
      expect(
        issues.some(
          (i: StepIssue) =>
            i.severity === "error" && /could not determine the host's free disk space/i.test(i.message),
        ),
      ).toBe(true);
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
    }
  });

  test("skipDiskSpaceCheck bypasses the unmeasurable-host guard", async () => {
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = MISSING_TMPDIR;
    try {
      const { ops } = makeDockerOps({
        free: 100 * GB,
        sizes: { [`${INSTANCE}-workspace`]: GB, [`${INSTANCE}-gateway-sec`]: GB, [`${INSTANCE}-ces-sec`]: GB },
      });
      const result = await preflight(detectInfo(ONE_INSTANCE), {
        dockerOps: ops,
        skipDiskSpaceCheck: true,
      });
      expect(result.status).toBe("completed");
      expect(result.issues ?? []).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
    }
  });
});
