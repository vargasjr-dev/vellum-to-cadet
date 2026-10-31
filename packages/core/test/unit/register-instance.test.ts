import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { registerInstanceStep } from "../../src/steps/register-instance.js";

/**
 * The register-instance step — the migrated instance's missing end state
 * (field review item 5): a data-only `--bundle BOOTSTRAP` ships no vellum
 * lockfile, so no entry landed in the cadet lockfile and the export never
 * carried the gateway signing identity. The step tops both up additively
 * and idempotently.
 */

const sandboxRoots: string[] = [];

async function sandbox(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vtc-register-${label}-`));
  sandboxRoots.push(dir);
  return dir;
}

before(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-register-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  sandboxRoots.push(home);
});

after(async () => {
  await Promise.all(
    sandboxRoots.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

const alwaysFree = async () => true;

async function readLockfile(envSuffix = ""): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.env.XDG_CONFIG_HOME!, `cadet${envSuffix}`, "lockfile.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("register-instance", () => {
  it("registers the instance and seeds the signing key when nothing exists (the bundle case)", async () => {
    const instanceDir = await sandbox("fresh");
    const result = await registerInstanceStep({
      instanceDir,
      instanceName: "grand-ram",
      envSuffix: "",
      isPortFree: alwaysFree,
    });
    assert.equal(result.status, "completed");

    const lockfile = await readLockfile();
    const assistants = lockfile.assistants as Record<string, unknown>[];
    assert.equal(assistants.length, 1);
    const entry = assistants[0]!;
    assert.equal(entry.assistantId, "grand-ram");
    assert.equal(entry.cloud, "local");
    const resources = entry.resources as Record<string, unknown>;
    assert.equal(
      resources.instanceDir,
      instanceDir,
    );
    assert.equal(typeof resources.gatewayPort, "number");
    assert.equal(typeof resources.daemonPort, "number");
    assert.equal(lockfile.activeAssistant, "grand-ram");

    // The signing key: gateway-owned file only — 32 raw bytes at the path
    // the gateway reads, never lockfile or env state.
    const keyPath = path.join(
      instanceDir,
      "gateway-security",
      "actor-token-signing-key",
    );
    const key = await fs.readFile(keyPath);
    assert.equal(key.length, 32);
    assert.equal(result.data && (result.data as Record<string, unknown>)["lockfileRegistered"], true);
    assert.equal(result.data && (result.data as Record<string, unknown>)["signingKeySeeded"], true);
  });

  it("leaves an existing same-id entry untouched but still seeds the key", async () => {
    const instanceDir = await sandbox("existing");
    const dir = path.join(process.env.XDG_CONFIG_HOME!, "cadet");
    await fs.mkdir(dir, { recursive: true });
    const existing = {
      deviceId: "keep-me",
      assistants: [{ assistantId: "grand-ram", cloud: "local", gatewayPort: 12345 }],
    };
    await fs.writeFile(
      path.join(dir, "lockfile.json"),
      JSON.stringify(existing),
      "utf8",
    );

    const result = await registerInstanceStep({
      instanceDir,
      instanceName: "grand-ram",
      envSuffix: "",
      isPortFree: alwaysFree,
    });

    const lockfile = await readLockfile();
    assert.deepEqual(lockfile, existing); // byte-for-byte untouched
    const data = (result.data ?? {}) as Record<string, unknown>;
    assert.equal(data["lockfileRegistered"], false);
    assert.equal(data["signingKeySeeded"], true);
  });

  it("never clobbers an existing signing key (rotating it orphans paired clients)", async () => {
    const instanceDir = await sandbox("key-kept");
    const keyDir = path.join(instanceDir, "gateway-security");
    await fs.mkdir(keyDir, { recursive: true });
    const keyPath = path.join(keyDir, "actor-token-signing-key");
    const existing = Buffer.alloc(32, 7);
    await fs.writeFile(keyPath, existing, { mode: 0o600 });

    await registerInstanceStep({
      instanceDir,
      instanceName: "grand-ram",
      envSuffix: "",
      isPortFree: alwaysFree,
    });

    assert.deepEqual(await fs.readFile(keyPath), existing);
  });

  it("does not pick ports claimed by existing entries", async () => {
    const instanceDir = await sandbox("ports");
    const dir = path.join(process.env.XDG_CONFIG_HOME!, "cadet");
    await fs.mkdir(dir, { recursive: true });
    // cadet's production gateway base is 7830 — an existing entry holds it.
    await fs.writeFile(
      path.join(dir, "lockfile.json"),
      JSON.stringify({
        assistants: [{ assistantId: "other", resources: { gatewayPort: 7830, daemonPort: 7821 } }],
      }),
      "utf8",
    );

    await registerInstanceStep({
      instanceDir,
      instanceName: "grand-ram",
      envSuffix: "",
      isPortFree: alwaysFree,
    });

    const lockfile = await readLockfile();
    const assistants = lockfile.assistants as Record<string, unknown>[];
    assert.equal(assistants.length, 2);
    const mine = assistants.find((e) => e.assistantId === "grand-ram")!;
    const resources = mine.resources as Record<string, unknown>;
    assert.notEqual(resources.gatewayPort, 7830);
    assert.notEqual(resources.daemonPort, 7821);
  });
});
