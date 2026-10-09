import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { readDockerLockfileEvidence } from "../../src/steps/detect.js";
import { expect } from "../helpers/expect.js";

/** Redirect $HOME for the duration of fn (discovery reads it live). */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

describe("readDockerLockfileEvidence", () => {
  test("reads docker instances and images from ~/.vellum.lock.json", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    await withHome(home, async () => {
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: "velly",
              cloud: "docker",
              containerInfo: {
                assistantImage: "vellumai/vellum-assistant",
                gatewayImage: "vellumai/vellum-gateway",
                cesImage: "vellumai/vellum-credential-executor",
              },
            },
            { assistantId: "local-bot", cloud: "local" },
          ],
        }),
      );
      const evidence = await readDockerLockfileEvidence();
      expect(evidence.instances).toEqual(["velly"]);
      expect(evidence.images).toEqual([
        "vellumai/vellum-assistant",
        "vellumai/vellum-gateway",
        "vellumai/vellum-credential-executor",
      ]);
    });
  });

  test("falls back to the older .vellum.lockfile.json name", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    await withHome(home, async () => {
      await fs.writeFile(
        path.join(home, ".vellum.lockfile.json"),
        JSON.stringify({ assistants: [{ assistantId: "old-bot", cloud: "docker" }] }),
      );
      expect((await readDockerLockfileEvidence()).instances).toEqual(["old-bot"]);
    });
  });

  test("honors VELLUM_LOCKFILE_DIR", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-dir-"));
    await fs.writeFile(
      path.join(dir, "lockfile.json"),
      JSON.stringify({ assistants: [{ assistantId: "dir-bot", cloud: "docker" }] }),
    );
    const prev = process.env.VELLUM_LOCKFILE_DIR;
    process.env.VELLUM_LOCKFILE_DIR = dir;
    try {
      expect((await readDockerLockfileEvidence()).instances).toEqual(["dir-bot"]);
    } finally {
      if (prev === undefined) delete process.env.VELLUM_LOCKFILE_DIR;
      else process.env.VELLUM_LOCKFILE_DIR = prev;
    }
  });

  test("reads the production XDG config dir; env-scoped dirs are ignored", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    await withHome(home, async () => {
      for (const dir of ["vellum", "vellum-dev"]) {
        await fs.mkdir(path.join(home, ".config", dir), { recursive: true });
        await fs.writeFile(
          path.join(home, ".config", dir, "lockfile.json"),
          JSON.stringify({
            assistants: [{ assistantId: `${dir}-bot`, cloud: "docker" }],
          }),
        );
      }
      expect((await readDockerLockfileEvidence()).instances).toEqual(["vellum-bot"]);
    });
  });

  test("malformed or missing lockfiles yield no evidence", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    await withHome(home, async () => {
      await fs.writeFile(path.join(home, ".vellum.lock.json"), "not json");
      expect(await readDockerLockfileEvidence()).toEqual({ instances: [], images: [] });
    });
    expect(await readDockerLockfileEvidence()).toEqual({ instances: [], images: [] });
  });
});
