import { describe, test } from "node:test";

import { parseDfAvail } from "../../src/process.js";
import { preflight } from "../../src/steps/preflight.js";
import type { DetectInfo, ProcessOps, StepIssue } from "../../src/types.js";
import { expect } from "../helpers/expect.js";

const GB = 1024 ** 3;
const INSTANCE = "vellum-prime-quail-3ezfs4";
const ONE_INSTANCE = [INSTANCE];
const THREE_VOLUMES = [`${INSTANCE}-workspace`, `${INSTANCE}-gateway-sec`, `${INSTANCE}-ces-sec`];

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

/** A fake docker ops pair with call counters, for the preflight disk guard. */
function makeDockerOps(over: { available?: boolean; free?: number; sizes?: Record<string, number | undefined> } = {}) {
  const calls = { available: 0, free: 0, sized: [] as string[] };
  const ops = {
    dockerAvailable: async (): Promise<boolean> => {
      calls.available++;
      return over.available ?? true;
    },
    dockerDiskFree: async (): Promise<number | undefined> => {
      calls.free++;
      return over.free;
    },
    dockerVolumeSize: async (volume: string): Promise<number | undefined> => {
      calls.sized.push(volume);
      return over.sizes?.[volume];
    },
  };
  return { calls, ops: ops as Pick<ProcessOps, "dockerAvailable" | "dockerVolumeSize" | "dockerDiskFree"> };
}

describe("preflight docker disk guard", () => {
  test("fails when the daemon disk cannot hold a second copy of the volumes", async () => {
    const { ops } = makeDockerOps({
      free: 30 * GB,
      sizes: { [`${INSTANCE}-workspace`]: 40 * GB, [`${INSTANCE}-gateway-sec`]: GB, [`${INSTANCE}-ces-sec`]: GB },
    });
    const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
    expect(result.status).toBe("failed");
    const error = (result.issues ?? []).find((issue: StepIssue) => issue.severity === "error");
    expect(error?.message).toMatch(/insufficient docker disk space/);
    expect(error?.message).toMatch(/need ~67\.6GB/); // 42GB of volumes × 1.5 headroom
    expect(error?.message).toMatch(/have 32\.2GB/);
    expect(error?.message).toMatch(/colima/);
  });

  test("passes when the free space covers the copy plus headroom on both disks", async () => {
    // Small totals: the host-side scratch check stats the REAL tmpdir, so
    // the fixture must fit whatever disk the test process actually has.
    const { ops } = makeDockerOps({
      free: 10 * GB,
      sizes: { [`${INSTANCE}-workspace`]: GB, [`${INSTANCE}-gateway-sec`]: GB, [`${INSTANCE}-ces-sec`]: GB },
    });
    const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
    expect(result.status).toBe("completed");
    expect(result.issues).toEqual([]);
  });

  test("fails closed when the daemon's free space cannot be determined", async () => {
    // v0.0.13 run feedback: the old stand-down warning is how a doomed run
    // started — an unmeasurable guard must stop the run, not wave it
    // through (--skip-disk-space-check is the explicit way out).
    const { ops } = makeDockerOps({ sizes: { [`${INSTANCE}-workspace`]: GB } });
    const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
    expect(result.status).toBe("failed");
    const issues = result.issues ?? [];
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toMatch(/could not determine the docker daemon's free disk space/);
  });

  test("fails closed when a volume size cannot be measured", async () => {
    // The v0.0.13 run's exact hole: the 60s du cap could not measure a
    // 65.9GB volume, the guard warned and continued, and the run died on
    // disk space 15 minutes later.
    const { ops } = makeDockerOps({
      free: 60 * GB,
      sizes: { [`${INSTANCE}-workspace`]: 40 * GB, [`${INSTANCE}-gateway-sec`]: undefined },
    });
    const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
    expect(result.status).toBe("failed");
    const issues = result.issues ?? [];
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toMatch(/could not measure the docker volume sizes/);
  });

  test("fails closed when the host disk cannot hold the extracted volume scratch", async () => {
    // The fetch extracts every volume into a scratch tree on the HOST's
    // disk before load writes the cadet volumes — a disk the old guard
    // never looked at. A MAX size forces the host check to fire
    // regardless of how much space the test machine's tmpdir has free.
    const { ops } = makeDockerOps({
      free: 100 * GB,
      sizes: {
        [`${INSTANCE}-workspace`]: Number.MAX_SAFE_INTEGER,
        [`${INSTANCE}-gateway-sec`]: Number.MAX_SAFE_INTEGER,
        [`${INSTANCE}-ces-sec`]: Number.MAX_SAFE_INTEGER,
      },
    });
    const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
    expect(result.status).toBe("failed");
    const issues = result.issues ?? [];
    expect(issues.some((i) => i.severity === "error" && /insufficient host disk space/.test(i.message))).toBe(true);
    expect(issues.some((i) => /scratch directory under/.test(i.message))).toBe(true);
  });

  test("skips the docker guard when no docker instances are detected", async () => {
    const { calls, ops } = makeDockerOps({ free: 0 });
    const result = await preflight(detectInfo([]), { dockerOps: ops });
    expect(result.status).toBe("completed");
    expect(calls.available).toBe(0);
    expect(result.issues).toEqual([]);
  });

  test("skips the docker guard when the daemon is unreachable", async () => {
    const { calls, ops } = makeDockerOps({ available: false, free: 30 * GB });
    const result = await preflight(detectInfo(ONE_INSTANCE), { dockerOps: ops });
    expect(result.status).toBe("completed");
    expect(calls.free).toBe(0);
    expect(result.issues).toEqual([]);
  });

  test("honors skipDiskSpaceCheck for the docker volumes", async () => {
    const { calls, ops } = makeDockerOps({ free: 0, sizes: { [`${INSTANCE}-workspace`]: 40 * GB } });
    const result = await preflight(detectInfo(ONE_INSTANCE), { skipDiskSpaceCheck: true, dockerOps: ops });
    expect(result.status).toBe("completed");
    expect(calls.available).toBe(0);
    expect(calls.sized.length).toBe(0);
    expect(result.issues).toEqual([]);
  });

  test("measures all three vellum-side volume names per instance", async () => {
    const { calls, ops } = makeDockerOps({
      free: 60 * GB,
      sizes: {
        "vellum-a-1-workspace": GB,
        "vellum-a-1-gateway-sec": GB,
        "vellum-a-1-ces-sec": GB,
        "vellum-b-2-workspace": GB,
        "vellum-b-2-gateway-sec": GB,
        "vellum-b-2-ces-sec": GB,
      },
    });
    await preflight(detectInfo(["vellum-a-1", "vellum-b-2"]), { dockerOps: ops });
    expect(calls.sized).toEqual([
      "vellum-a-1-workspace",
      "vellum-a-1-gateway-sec",
      "vellum-a-1-ces-sec",
      "vellum-b-2-workspace",
      "vellum-b-2-gateway-sec",
      "vellum-b-2-ces-sec",
    ]);
  });
});

describe("parseDfAvail", () => {
  test("reads the Avail column of the / row", () => {
    const out = ["Filesystem 1024-blocks Used Available Capacity Mounted on", "overlay 12345678 7565432 4780246 62% /", ""].join(
      "\n",
    );
    expect(parseDfAvail(out)).toBe(4780246 * 1024);
  });

  test("picks the / row when other filesystems are listed", () => {
    const out = ["Filesystem 1024-blocks Used Available Capacity Mounted on", "tmpfs 64 0 64 0% /tmp", "overlay 100 50 25 50% /"].join(
      "\n",
    );
    expect(parseDfAvail(out)).toBe(25 * 1024);
  });

  test("returns undefined for header-only or garbage output", () => {
    expect(parseDfAvail("Filesystem 1024-blocks Used Available Capacity Mounted on")).toBeUndefined();
    expect(parseDfAvail("not a df output at all")).toBeUndefined();
  });
});
