import { afterEach, beforeEach, describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  desktopMigrationStatePath,
  markDeclined,
  markMigrated,
  probeDesktopInstall,
  readDesktopMigrationState,
} from "../../src/desktop.js";
import { expect } from "../helpers/expect.js";

const homeOrig = process.env["HOME"];
const xdgConfigOrig = process.env["XDG_CONFIG_HOME"];
const xdgDataOrig = process.env["XDG_DATA_HOME"];
const vellumDataOrig = process.env["VELLUM_DATA_DIR"];
const vellumWorkspaceOrig = process.env["VELLUM_WORKSPACE_DIR"];

let fakeHome = "";

beforeEach(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-probe-home-"));
  // Isolate every ambient root + config location the probe reads.
  process.env["HOME"] = fakeHome;
  process.env["XDG_CONFIG_HOME"] = path.join(fakeHome, ".config");
  process.env["XDG_DATA_HOME"] = path.join(fakeHome, ".local", "share");
  delete process.env["VELLUM_DATA_DIR"];
  delete process.env["VELLUM_WORKSPACE_DIR"];
});

afterEach(async () => {
  if (homeOrig !== undefined) process.env["HOME"] = homeOrig;
  else delete process.env["HOME"];
  if (xdgConfigOrig !== undefined) process.env["XDG_CONFIG_HOME"] = xdgConfigOrig;
  else delete process.env["XDG_CONFIG_HOME"];
  if (xdgDataOrig !== undefined) process.env["XDG_DATA_HOME"] = xdgDataOrig;
  else delete process.env["XDG_DATA_HOME"];
  if (vellumDataOrig !== undefined) process.env["VELLUM_DATA_DIR"] = vellumDataOrig;
  else delete process.env["VELLUM_DATA_DIR"];
  if (vellumWorkspaceOrig !== undefined) process.env["VELLUM_WORKSPACE_DIR"] = vellumWorkspaceOrig;
  else delete process.env["VELLUM_WORKSPACE_DIR"];
  await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
});

/** A trusted MODERN root: ~/.local/share/vellum with one assistant's state dir. */
async function makeModernRoot(assistant = "vellum-fresh-eel-8di6pa"): Promise<string> {
  const root = path.join(fakeHome, ".local", "share", "vellum");
  await fs.mkdir(path.join(root, "assistants", assistant, ".vellum"), { recursive: true });
  await fs.writeFile(path.join(root, "assistants", assistant, ".vellum", ".vellum-assistant"), "0.12.6");
  return root;
}

/** A trusted LEGACY root: ~/.vellum with strong markers. */
async function makeLegacyRoot(): Promise<string> {
  const root = path.join(fakeHome, ".vellum");
  for (const marker of ["workspace", ".vellum-assistant", "device/registry.json"]) {
    await fs.mkdir(path.join(root, marker), { recursive: true });
  }
  return root;
}

/** Plant a cadet lockfile tracking N assistants. */
async function plantCadetLockfile(assistants: unknown[], envSuffix = ""): Promise<void> {
  const dir = path.join(fakeHome, ".config", `cadet${envSuffix}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "lockfile.json"), JSON.stringify({ assistants }));
}

describe("desktop migration state", () => {
  test("a legacy root's state file lands on the vellum XDG side, not the root", async () => {
    const root = await makeLegacyRoot();
    expect(await markMigrated(root, "/cadet")).toBe(true);

    const state = await readDesktopMigrationState(root);
    expect(state?.status).toBe("migrated");
    expect(state?.cadetRoot).toBe("/cadet");
    // ~/.vellum install → ~/.local/share/vellum/.cadet-migration-state.json
    expect(desktopMigrationStatePath(root)).toBe(
      path.join(fakeHome, ".local", "share", "vellum", ".cadet-migration-state.json"),
    );
    // And never inside the root itself.
    let threw = false;
    try {
      await fs.access(path.join(root, ".cadet-migration-state.json"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("a modern root's state file lives inside the root", async () => {
    const root = await makeModernRoot();
    expect(await markMigrated(root)).toBe(true);
    expect((await readDesktopMigrationState(root))?.status).toBe("migrated");
    expect(desktopMigrationStatePath(root)).toBe(path.join(root, ".cadet-migration-state.json"));
  });

  test("migrated is never downgraded to declined", async () => {
    const root = await makeModernRoot();
    await markMigrated(root);
    expect(await markDeclined(root)).toBe(false);
    expect((await readDesktopMigrationState(root))?.status).toBe("migrated");
  });

  test("an unreadable state file reads as absent (prompt returns)", async () => {
    const root = await makeModernRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(desktopMigrationStatePath(root), "not json at all {");
    expect(await readDesktopMigrationState(root)).toBe(null);
  });
});

describe("probeDesktopInstall", () => {
  test("quiet when no vellum root exists", async () => {
    expect(await probeDesktopInstall()).toEqual({ status: "quiet", reason: "no-vellum-root" });
  });

  test("offers a trusted root with its handles and cadet target", async () => {
    const root = await makeModernRoot();
    const probe = await probeDesktopInstall();
    expect(probe.status).toBe("offer");
    if (probe.status !== "offer") return;
    expect(probe.vellumRoot).toBe(root);
    expect(probe.assistantHandles).toEqual(["vellum-fresh-eel-8di6pa"]);
    expect(probe.cadetRoot).toBe(path.join(fakeHome, ".local", "share", "cadet"));
    expect(probe.layout).toBe("modern");
  });

  test("an explicit root skips discovery", async () => {
    const root = await makeLegacyRoot();
    const probe = await probeDesktopInstall({ vellumRoot: root });
    expect(probe.status).toBe("offer");
    if (probe.status !== "offer") return;
    expect(probe.layout).toBe("legacy");
    expect(probe.assistantHandles).toEqual([]);
  });

  test("the cadet lockfile gates the offer — no docker, no process scan", async () => {
    await makeModernRoot();
    await plantCadetLockfile([{ assistantId: "fresh-eel" }]);
    expect(await probeDesktopInstall()).toEqual({ status: "quiet", reason: "cadet-in-use" });
  });

  test("an env-scoped cadet lockfile gates the env-scoped root", async () => {
    const root = path.join(fakeHome, ".local", "share", "vellum-staging");
    await fs.mkdir(path.join(root, "assistants", "vellum-warm-fox", ".vellum"), { recursive: true });
    await plantCadetLockfile([{ assistantId: "warm-fox" }], "-staging");
    expect(await probeDesktopInstall({ vellumRoot: root })).toEqual({
      status: "quiet",
      reason: "cadet-in-use",
    });
  });

  test("a missing cadet lockfile still offers (count reads as 0)", async () => {
    await makeModernRoot();
    await plantCadetLockfile([]);
    const probe = await probeDesktopInstall();
    expect(probe.status).toBe("offer");
  });

  test("a migrated root is quiet", async () => {
    const root = await makeModernRoot();
    await markMigrated(root);
    expect(await probeDesktopInstall()).toEqual({ status: "quiet", reason: "already-migrated" });
  });

  test("a checked don't-ask-again decline is quiet", async () => {
    const root = await makeModernRoot();
    await markDeclined(root);
    expect(await probeDesktopInstall()).toEqual({ status: "quiet", reason: "declined" });
  });

  test("a modern root with no assistants has nothing to migrate", async () => {
    // Explicit root: discovery never trusts a marker-less root, so this
    // quiet reason is only reachable when the shim names a root itself.
    const root = path.join(fakeHome, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants"), { recursive: true });
    expect(await probeDesktopInstall({ vellumRoot: root })).toEqual({
      status: "quiet",
      reason: "nothing-to-migrate",
    });
  });
});
