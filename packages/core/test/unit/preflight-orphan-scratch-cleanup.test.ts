import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { preflight } from "../../src/steps/preflight.js";
import type { DetectInfo } from "../../src/types.js";
import { expect } from "../helpers/expect.js";

const HOUR_MS = 60 * 60 * 1000;

function detectInfo(): DetectInfo {
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
    docker: { instances: [], images: [] },
    runningProcesses: [],
    rootSizeBytes: 0, // the desktop disk check is gated on rootSizeBytes > 0
    externalReferences: [],
  };
}

/**
 * Redirect os.tmpdir() at a fixture dir for the duration of fn — the same
 * seam the statfs test uses (preflight reads os.tmpdir() at call time).
 */
async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const realTmp = process.env.TMPDIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-orphan-test-"));
  process.env.TMPDIR = dir;
  try {
    await fn(dir);
  } finally {
    if (realTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = realTmp;
    }
  }
}

async function makeScratchDir(dir: string, ageMs: number): Promise<void> {
  await fs.mkdir(path.join(dir, "instance"), { recursive: true });
  await fs.writeFile(path.join(dir, "instance", "blob.bin"), "x".repeat(8192));
  const then = new Date(Date.now() - ageMs);
  await fs.utimes(dir, then, then);
}

async function gone(dir: string): Promise<boolean> {
  try {
    await fs.stat(dir);
    return false;
  } catch {
    return true;
  }
}

describe("preflight orphan scratch sweep", () => {
  test("removes stale vtc-volumes-* corpses and reports their sizes", async () => {
    await withTmpDir(async (tmp) => {
      const corpseA = path.join(tmp, "vtc-volumes-aaaa");
      const corpseB = path.join(tmp, "vtc-volumes-bbbb");
      const bystander = path.join(tmp, "vtc-unrelated-cccc");
      const fresh = path.join(tmp, "vtc-volumes-fresh");
      await makeScratchDir(corpseA, 2 * HOUR_MS);
      await makeScratchDir(corpseB, 2 * HOUR_MS);
      await makeScratchDir(bystander, 2 * HOUR_MS);
      await makeScratchDir(fresh, 0); // too young — may be a live run's scratch

      const result = await preflight(detectInfo());

      expect(await gone(corpseA)).toBe(true);
      expect(await gone(corpseB)).toBe(true);
      await fs.access(bystander); // non-scratch names are never touched
      await fs.access(fresh); // young dirs survive — they may be live
      const sweep = (result.issues ?? []).find((issue) => issue.message.includes("orphaned scratch dir"));
      expect(sweep?.severity).toBe("info");
      expect(sweep?.message).toContain("removed 2");
      expect(sweep?.message).toContain("vtc-volumes-aaaa");
      expect(sweep?.message).toContain("vtc-volumes-bbbb");
    });
  });

  test("leaves recently-touched scratch dirs alone — no sweep issue", async () => {
    await withTmpDir(async (tmp) => {
      const live = path.join(tmp, "vtc-volumes-live");
      await makeScratchDir(live, 0);

      const result = await preflight(detectInfo());

      await fs.access(live);
      expect((result.issues ?? []).some((issue) => issue.message.includes("orphaned"))).toBe(false);
    });
  });

  test("dry-run reports corpses without removing them", async () => {
    await withTmpDir(async (tmp) => {
      const corpse = path.join(tmp, "vtc-volumes-dry");
      await makeScratchDir(corpse, 2 * HOUR_MS);

      const result = await preflight(detectInfo(), { dryRun: true });

      await fs.access(corpse); // still there
      const sweep = (result.issues ?? []).find((issue) => issue.message.includes("orphaned scratch dir"));
      expect(sweep?.severity).toBe("info");
      expect(sweep?.message).toContain("not removed");
      expect(sweep?.message).toContain("vtc-volumes-dry");
    });
  });
});
