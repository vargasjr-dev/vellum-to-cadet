import { afterEach, describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  discoverCadetRoots,
  discoverVellumRoots,
  searchedLocations,
} from "../../src/discover.js";
import { expect } from "../helpers/expect.js";

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

describe("discover: the config root of docker-only installs", () => {
  test("finds ~/.config/vellum via its assistants' guardian tokens when the data root never existed", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-cfgroot-"));
    process.env["HOME"] = tempHome;
    // Docker-only install: the config dir holds the assistant state; the
    // data dir is never created (all heavy data lives in docker volumes).
    const root = path.join(tempHome, ".config", "vellum");
    await fs.mkdir(path.join(root, "assistants", "vellum-eager-otter-kdqnjj"), { recursive: true });
    await fs.writeFile(path.join(root, "assistants", "vellum-eager-otter-kdqnjj", "guardian-token.json"), "{}");

    const found = await discoverVellumRoots();
    expect(found).toHaveLength(1);
    expect(found[0]!.root).toBe(root);
    expect(found[0]!.layout).toBe("modern");
    expect(found[0]!.markers).toContain("assistants/*/guardian-token.json");
    expect(found[0]!.origin).toBe("default XDG config location");
  });

  test("prefers the data root when both modern dirs exist", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-cfgroot-"));
    process.env["HOME"] = tempHome;
    const dataRoot = path.join(tempHome, ".local", "share", "vellum");
    const state = path.join(dataRoot, "assistants", "velly", ".vellum");
    await fs.mkdir(path.join(state, "workspace"), { recursive: true });
    await fs.mkdir(path.join(state, ".vellum-assistant"), { recursive: true });
    const configRoot = path.join(tempHome, ".config", "vellum");
    await fs.mkdir(path.join(configRoot, "assistants", "vellum-eager-otter-kdqnjj"), { recursive: true });
    await fs.writeFile(path.join(configRoot, "assistants", "vellum-eager-otter-kdqnjj", "guardian-token.json"), "{}");

    const found = await discoverVellumRoots();
    expect(found).toHaveLength(1);
    expect(found[0]!.root).toBe(dataRoot);
  });

  test("an empty config dir (no assistants) is not a root", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-cfgroot-"));
    process.env["HOME"] = tempHome;
    await fs.mkdir(path.join(tempHome, ".config", "vellum", "logs"), { recursive: true });

    expect(await discoverVellumRoots()).toHaveLength(0);
  });

  test("the searched report names the config root too", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "discover-cfgroot-"));
    process.env["HOME"] = tempHome;

    const searched = await searchedLocations();
    expect(searched).toContain(path.join(tempHome, ".config", "vellum"));
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


describe("lockfile-corroborated discovery", () => {
  async function fakeHome(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "discover-home-"));
  }

  test("a docker-tracked lockfile trusts a modern root the marker scan cannot", async () => {
    const home = await fakeHome();
    process.env["HOME"] = home;
    delete process.env["VELLUM_DATA_DIR"];
    delete process.env["VELLUM_WORKSPACE_DIR"];
    // The modern root exists but carries NO strong markers — a docker
    // install's host root holds only the CLI's own state.
    await fs.mkdir(path.join(home, ".local", "share", "vellum"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".vellum.lock.json"),
      JSON.stringify({ assistants: [{ assistantId: "velly", cloud: "docker" }] }),
    );

    const found = await discoverVellumRoots();

    expect(found).toHaveLength(1);
    expect(found[0]!.root).toBe(path.join(home, ".local", "share", "vellum"));
    expect(found[0]!.layout).toBe("modern");
    expect(found[0]!.origin).toBe("docker-tracked vellum lockfile");
  });

  test("a docker-tracked lockfile cannot conjure a root that does not exist", async () => {
    const home = await fakeHome();
    process.env["HOME"] = home;
    delete process.env["VELLUM_DATA_DIR"];
    delete process.env["VELLUM_WORKSPACE_DIR"];
    await fs.writeFile(
      path.join(home, ".vellum.lock.json"),
      JSON.stringify({ assistants: [{ assistantId: "velly", cloud: "docker" }] }),
    );

    const found = await discoverVellumRoots();

    expect(found).toEqual([]);
  });

  test("a lockfile without docker entries does not corroborate a root", async () => {
    const home = await fakeHome();
    process.env["HOME"] = home;
    delete process.env["VELLUM_DATA_DIR"];
    delete process.env["VELLUM_WORKSPACE_DIR"];
    await fs.mkdir(path.join(home, ".local", "share", "vellum"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".vellum.lock.json"),
      JSON.stringify({ assistants: [{ assistantId: "loc", cloud: "local" }] }),
    );

    const found = await discoverVellumRoots();

    expect(found).toEqual([]);
  });

  test("the failure report names the modern root and the lockfiles whether or not they exist", async () => {
    const home = await fakeHome();
    process.env["HOME"] = home;
    delete process.env["VELLUM_DATA_DIR"];
    delete process.env["VELLUM_WORKSPACE_DIR"];

    const searched = await searchedLocations();

    expect(searched).toContain(path.join(home, ".vellum"));
    expect(searched).toContain(path.join(home, ".local", "share", "vellum"));
    expect(searched).toContain(path.join(home, ".vellum.lock.json"));
    expect(searched).toContain(path.join(home, ".config", "vellum", "lockfile.json"));
  });
});
