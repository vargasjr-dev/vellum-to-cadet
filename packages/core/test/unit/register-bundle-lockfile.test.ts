import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, test } from "node:test";

import { registerBundleLockfileStep } from "../../src/steps/register-bundle-lockfile.js";
import { expect } from "../helpers/expect.js";

/**
 * The register-bundle-lockfile step: a --bundle restore ends by recording
 * the restored assistant in the VELLUM lockfile (the winning candidate of
 * the reader's scan; the canonical ~/.config/vellum/lockfile.json when none
 * exists), so the standard conversion produces the cadet entry through the
 * one path every other assistant takes.
 */

const prevHome = process.env.HOME;
const prevLockfileDir = process.env.VELLUM_LOCKFILE_DIR;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevLockfileDir === undefined) delete process.env.VELLUM_LOCKFILE_DIR;
  else process.env.VELLUM_LOCKFILE_DIR = prevLockfileDir;
});

async function sandboxHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-rbl-"));
  process.env.HOME = home;
  delete process.env.VELLUM_LOCKFILE_DIR;
  return home;
}

const baseOpts = (root: string, dir: string) => ({
  vellumRoot: root,
  assistantName: "test-bundle",
  assistantDir: dir,
  envSuffix: "-test",
});

describe("register-bundle-lockfile", () => {
  test("creates the canonical config-dir lockfile when none exists", async () => {
    const home = await sandboxHome();
    const result = await registerBundleLockfileStep(
      baseOpts("/tmp/vellum-root", "/tmp/vellum-root/assistants/test-bundle"),
    );

    expect(result.status).toBe("completed");
    const raw = JSON.parse(
      await fs.readFile(path.join(home, ".config", "vellum", "lockfile.json"), "utf8"),
    ) as Record<string, any>;
    expect(raw.activeAssistant).toBe("test-bundle");
    const entry = raw.assistants[0];
    expect(entry.assistantId).toBe("test-bundle");
    expect(entry.name).toBe("test-bundle");
    expect(entry.cloud).toBe("local");
    // Placeholder ports from the env's bases — the de-clash reallocates.
    expect(entry.resources.daemonPort).toBe(19000);
    expect(entry.resources.gatewayPort).toBe(19100);
    expect(entry.resources.cesPort).toBe(19300);
    expect(entry.resources.instanceDir).toBe("/tmp/vellum-root/assistants/test-bundle");
    // Strictly local: no vellum cloud identity, no secrets.
    expect(JSON.stringify(entry)).not.toContain("platform");
    expect(JSON.stringify(entry)).not.toContain("organizationId");
  });

  test("honors VELLUM_LOCKFILE_DIR when nothing exists yet", async () => {
    const home = await sandboxHome();
    const hookDir = path.join(home, "lockfile-hook");
    process.env.VELLUM_LOCKFILE_DIR = hookDir;

    const result = await registerBundleLockfileStep(
      baseOpts("/tmp/vellum-root", "/tmp/vellum-root/assistants/test-bundle"),
    );

    expect(result.status).toBe("completed");
    const raw = JSON.parse(
      await fs.readFile(path.join(hookDir, "lockfile.json"), "utf8"),
    ) as Record<string, any>;
    expect(raw.assistants.map((a: any) => a.assistantId)).toEqual(["test-bundle"]);
    // The canonical location stays untouched.
    expect(await fs.stat(path.join(home, ".config", "vellum", "lockfile.json")).then(
      () => true,
      () => false,
    )).toBe(false);
  });

  test("merges additively into an existing winner, preserving its state", async () => {
    const home = await sandboxHome();
    const lockDir = path.join(home, ".config", "vellum");
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "lockfile.json");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        deviceId: "keep-me",
        activeAssistant: "velly",
        assistants: [{ assistantId: "velly", name: "velly", cloud: "local" }],
      }),
      "utf8",
    );

    const result = await registerBundleLockfileStep(
      baseOpts("/tmp/vellum-root", "/tmp/vellum-root/assistants/test-bundle"),
    );

    expect(result.status).toBe("completed");
    const raw = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, any>;
    expect(raw.deviceId).toBe("keep-me");
    // An existing activeAssistant choice stands.
    expect(raw.activeAssistant).toBe("velly");
    expect(raw.assistants.map((a: any) => a.assistantId)).toEqual(["velly", "test-bundle"]);
  });

  test("a home-level legacy lockfile wins — the entry lands there", async () => {
    const home = await sandboxHome();
    const legacyPath = path.join(home, ".vellum.lock.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ assistants: [{ assistantId: "legacy-1", cloud: "local" }] }),
      "utf8",
    );

    const result = await registerBundleLockfileStep(
      baseOpts("/tmp/vellum-root", "/tmp/vellum-root/assistants/test-bundle"),
    );

    expect(result.status).toBe("completed");
    const raw = JSON.parse(await fs.readFile(legacyPath, "utf8")) as Record<string, any>;
    expect(raw.assistants.map((a: any) => a.assistantId)).toEqual(["legacy-1", "test-bundle"]);
    // The canonical location stays untouched.
    expect(
      await fs.stat(path.join(home, ".config", "vellum", "lockfile.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("an already-recorded id skips without rewriting the file", async () => {
    const home = await sandboxHome();
    const lockDir = path.join(home, ".config", "vellum");
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "lockfile.json");
    const before = JSON.stringify({
      assistants: [{ assistantId: "test-bundle", cloud: "local", resources: { gatewayPort: 7777 } }],
    });
    await fs.writeFile(lockPath, before, "utf8");

    const result = await registerBundleLockfileStep(
      baseOpts("/tmp/vellum-root", "/tmp/vellum-root/assistants/test-bundle"),
    );

    expect(result.status).toBe("skipped");
    expect(await fs.readFile(lockPath, "utf8")).toBe(before);
  });
});
