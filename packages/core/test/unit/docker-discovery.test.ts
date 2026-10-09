import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  dockerContainerNames,
  findComposeFiles,
  readDockerLockfileEvidence,
} from "../../src/steps/detect.js";
import { stopAssistant } from "../../src/steps/stop-assistant.js";
import type { DetectInfo, ProcessOps } from "../../src/types.js";

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

function baseDetect(overrides: Partial<DetectInfo> = {}): DetectInfo {
  return {
    vellumRoot: "/tmp/nowhere/.vellum",
    cadetRoot: "/tmp/nowhere/cadet",
    vellumRootExists: false,
    cadetRootExists: false,
    cadetRootPopulated: false,
    previousManifest: false,
    version: null,
    deploymentKind: "unknown",
    docker: { instances: [], runningContainers: [], composeFiles: [], images: [] },
    runningProcesses: [],
    rootSizeBytes: 0,
    externalReferences: [],
    ...overrides,
  };
}

/** Ops recorder for the stop-step docker flow. */
function dockerOps(runningNow: string[]): {
  ops: ProcessOps;
  stopped: string[];
  sleepCalls: () => number;
} {
  let sleepCalls = 0;
  const stopped: string[] = [];
  return {
    stopped,
    sleepCalls: () => sleepCalls,
    ops: {
      async find() {
        return [];
      },
      async vellumSleep() {
        sleepCalls++;
        throw new Error("vellum: command not found");
      },
      async dockerPs() {
        return runningNow.filter((name) => !stopped.includes(name));
      },
      async dockerStop(names) {
        stopped.push(...names);
      },
    },
  };
}

describe("dockerContainerNames", () => {
  test("derives the vellum service container names for an instance", () => {
    expect(dockerContainerNames("velly")).toEqual([
      "velly-assistant",
      "velly-gateway",
      "velly-credential-executor",
    ]);
  });
});

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

  test("reads env-scoped XDG config dirs too", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    await withHome(home, async () => {
      await fs.mkdir(path.join(home, ".config", "vellum-dev"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".config", "vellum-dev", "lockfile.json"),
        JSON.stringify({ assistants: [{ assistantId: "dev-bot", cloud: "docker" }] }),
      );
      expect((await readDockerLockfileEvidence()).instances).toEqual(["dev-bot"]);
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

describe("findComposeFiles", () => {
  test("finds compose files that bind-mount the root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    const root = path.join(home, ".vellum");
    await fs.writeFile(
      path.join(home, "docker-compose.yml"),
      `services:\n  assistant:\n    image: vellumai/vellum-assistant\n    volumes:\n      - ${root}:/data\n`,
    );
    expect(await findComposeFiles(root)).toEqual([path.join(home, "docker-compose.yml")]);
  });

  test("ignores compose files that do not reference the root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "docker-detect-"));
    const root = path.join(home, ".vellum");
    await fs.writeFile(
      path.join(home, "docker-compose.yml"),
      "services:\n  other:\n    image: nginx\n",
    );
    expect(await findComposeFiles(root)).toEqual([]);
  });
});

describe("stop-assistant docker flow", () => {
  test("stops surviving containers when the vellum CLI is absent", async () => {
    const { ops, stopped } = dockerOps(["velly-assistant", "velly-gateway"]);
    const detect = baseDetect({
      docker: { instances: ["velly"], runningContainers: ["velly-assistant", "velly-gateway"], composeFiles: [], images: [] },
    });
    const result = await stopAssistant(detect, ops, false, 1);
    expect(result.status).toBe("completed");
    expect(stopped).toEqual(["velly-assistant", "velly-gateway"]);
    expect(result.summary).toContain("2 docker container(s) stopped");
  });

  test("fails the run when containers refuse to stop", async () => {
    const recorder = dockerOps(["velly-assistant"]);
    // dockerStop is a no-op that never removes from runningNow — containers stay "up".
    const ops: ProcessOps = {
      ...recorder.ops,
      async dockerStop() {},
    };
    const detect = baseDetect({
      docker: { instances: ["velly"], runningContainers: ["velly-assistant"], composeFiles: [], images: [] },
    });
    const result = await stopAssistant(detect, ops, false, 1);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("docker container(s) still running");
  });

  test("skips when nothing runs", async () => {
    const result = await stopAssistant(baseDetect(), dockerOps([]).ops, false, 1);
    expect(result.status).toBe("skipped");
  });
});
