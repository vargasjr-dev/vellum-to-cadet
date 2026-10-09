import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverCadetRoots, discoverVellumRoots } from "../../src/discover.js";

const ENV_KEYS = ["VELLUM_DATA_DIR", "VELLUM_WORKSPACE_DIR"] as const;
const ambientEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const homeOrig = process.env["HOME"];

afterEach(() => {
  for (const [key, value] of ambientEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (homeOrig !== undefined) process.env["HOME"] = homeOrig;
});

async function makeRoot(markers: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discover-"));
  for (const marker of markers) {
    const p = path.join(root, marker);
    if (marker.endsWith(".json")) {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, "{}");
    } else {
      await fs.mkdir(p, { recursive: true });
    }
  }
  return root;
}

describe("discoverVellumRoots", () => {
  test("finds the default home root when it has markers", async () => {
    // The default candidate is $HOME/.vellum — build a root there.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-home-"));
    const fakeRoot = path.join(fakeHome, ".vellum");
    for (const marker of ["workspace", ".vellum-assistant", "device/registry.json"]) {
      await fs.mkdir(path.join(fakeRoot, marker), { recursive: true });
    }
    process.env["HOME"] = fakeHome;

    const found = await discoverVellumRoots();

    // Other ambient candidates may exist on the machine under test; ours
    // must be among them.
    expect(found.map((c) => c.root)).toContain(fakeRoot);
  });

  test("VELLUM_DATA_DIR is a discovery candidate", async () => {
    const envRoot = await makeRoot(["workspace", "config.json", ".vellum-assistant"]);
    process.env["VELLUM_DATA_DIR"] = envRoot;
    process.env["VELLUM_WORKSPACE_DIR"] = undefined;

    const found = await discoverVellumRoots();
    expect(found.some((c) => c.root === envRoot)).toBe(true);
  });

  test("VELLUM_WORKSPACE_DIR climbs to the parent root", async () => {
    const root = await makeRoot(["workspace", ".vellum-assistant"]);
    process.env["VELLUM_DATA_DIR"] = undefined;
    process.env["VELLUM_WORKSPACE_DIR"] = path.join(root, "workspace");

    const found = await discoverVellumRoots();
    expect(found.some((c) => c.root === root)).toBe(true);
  });

  test("ignores empty directories that merely look like roots", async () => {
    const empty = await makeRoot([]);
    process.env["VELLUM_DATA_DIR"] = empty;
    process.env["VELLUM_WORKSPACE_DIR"] = undefined;

    const found = await discoverVellumRoots();
    expect(found.find((c) => c.root === empty)).toBeUndefined();
  });
});

describe("discover: modern multi-instance layout", () => {
  test("finds ~/.local/share/vellum via its assistants' state dirs", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-modern-"));
    process.env["HOME"] = tempHome;
    const root = path.join(tempHome, ".local", "share", "vellum");
    const state = path.join(root, "assistants", "velly", ".vellum");
    await fs.mkdir(path.join(state, "workspace"), { recursive: true });
    await fs.mkdir(path.join(state, ".vellum-assistant"), { recursive: true });

    const found = await discoverVellumRoots();
    const hit = found.find((c) => c.root === root);
    expect(hit).toBeDefined();
    expect(hit!.layout).toBe("modern");
    expect(hit!.markers).toContain("assistants/*/.vellum");
  });

  test("ignores env-suffixed roots — the migrator targets production only", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-modern-"));
    process.env["HOME"] = tempHome;
    const root = path.join(tempHome, ".local", "share", "vellum-dev");
    const state = path.join(root, "assistants", "velly", ".vellum");
    await fs.mkdir(path.join(state, "workspace"), { recursive: true });
    await fs.mkdir(path.join(state, ".vellum-assistant"), { recursive: true });

    const found = await discoverVellumRoots();
    expect(found.find((c) => c.root === root)).toBeUndefined();
  });

  test("modern outranks legacy when both exist", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-modern-"));
    process.env["HOME"] = tempHome;
    const modern = path.join(tempHome, ".local", "share", "vellum");
    const modernState = path.join(modern, "assistants", "velly", ".vellum");
    await fs.mkdir(path.join(modernState, "workspace"), { recursive: true });
    await fs.mkdir(path.join(modernState, ".vellum-assistant"), { recursive: true });
    await fs.mkdir(path.join(tempHome, ".vellum", "workspace"), { recursive: true });
    await fs.mkdir(path.join(tempHome, ".vellum", ".vellum-assistant"), { recursive: true });

    const found = await discoverVellumRoots();
    expect(found[0]!.root).toBe(modern);
    expect(found[0]!.layout).toBe("modern");
  });

  test("a modern root whose .vellum dirs are empty is not trusted", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-modern-"));
    process.env["HOME"] = tempHome;
    const root = path.join(tempHome, ".local", "share", "vellum");
    await fs.mkdir(path.join(root, "assistants", "velly", ".vellum"), { recursive: true });

    const found = await discoverVellumRoots();
    expect(found).toHaveLength(0);
  });
});


describe("discoverCadetRoots — production roots only", () => {
  const MANIFEST = ".cadet-migration-manifest.json";

  test("finds the bare home root and the XDG root's instance dirs when they carry the manifest", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-cadet-"));
    process.env["HOME"] = tempHome;
    const bare = path.join(tempHome, ".cadet");
    await fs.mkdir(bare, { recursive: true });
    await fs.writeFile(path.join(bare, MANIFEST), "{}");
    const instance = path.join(tempHome, ".local", "share", "cadet", "assistants", "velly");
    await fs.mkdir(instance, { recursive: true });
    await fs.writeFile(path.join(instance, MANIFEST), "{}");

    expect(await discoverCadetRoots()).toEqual([bare, instance]);
  });

  test("ignores env-suffixed cadet roots even when they carry the manifest", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-cadet-"));
    process.env["HOME"] = tempHome;
    for (const dir of [
      path.join(tempHome, ".cadet-dev"),
      path.join(tempHome, ".local", "share", "cadet-dev", "assistants", "velly"),
    ]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, MANIFEST), "{}");
    }
    const production = path.join(tempHome, ".local", "share", "cadet", "assistants", "velly");
    await fs.mkdir(production, { recursive: true });
    await fs.writeFile(path.join(production, MANIFEST), "{}");

    expect(await discoverCadetRoots()).toEqual([production]);
  });
});
