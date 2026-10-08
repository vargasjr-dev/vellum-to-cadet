import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { candidateRoots, discoverVellumRoots } from "../../src/discover.js";

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

  test("candidateRoots includes the docker volume convention", () => {
    const roots = candidateRoots().map((c) => c.root);
    expect(roots).toContain("/data/.vellum");
  });
});
