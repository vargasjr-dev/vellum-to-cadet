import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const cliPath = path.join(
  url.fileURLToPath(new URL(".", import.meta.url)),
  "../../src/cli.ts",
);

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): { code: number; stdout: string; stderr: string } {
  // node:child_process, not Bun.spawnSync — Bun drops stdin input (child sees
  // EOF without data), and plain node is the CLI's real npx runtime anyway.
  const proc = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...opts.env },
    input: opts.stdin,
    encoding: "utf8",
  });
  return {
    code: proc.status ?? 0,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

/**
 * Spawn env that makes discovery deterministic: the only candidate is the
 * fixture root pointed at via the legacy env overrides, with a HOME that
 * has no vellum installation of its own.
 */
async function deterministicDiscoveryEnv(root: string): Promise<Record<string, string>> {
  const fakeHome = await fs.mkdtemp(path.join(tmpdir(), "cli-home-"));
  return {
    HOME: fakeHome,
    VELLUM_DATA_DIR: root,
    VELLUM_WORKSPACE_DIR: path.join(root, "workspace"),
  };
}

describe("cli", () => {
  test("--help exits 0 and shows usage", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("migrate-vellum-assistant-to-cadet");
    expect(r.stdout).toContain("--dry-run");
  });

  test("unknown flag exits non-zero with the flag in stderr", () => {
    const r = runCli(["--definitely-not-a-flag"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown flag");
  });

  test("--json emits a structured report; exit 2 with no vellum root", async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), "cli-json-"));
    const emptyRoot = await fs.mkdtemp(path.join(tmpdir(), "cli-empty-"));
    const r = runCli(
      ["--cadet-root", path.join(home, ".cadet"), "--json"],
      {
        env: {
          HOME: home,
          VELLUM_DATA_DIR: emptyRoot,
          VELLUM_WORKSPACE_DIR: path.join(emptyRoot, "workspace"),
        },
      },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    expect(report.searched.length).toBeGreaterThan(0);
  });

  test("removed flags are rejected", () => {
    for (const flag of ["--remove-vellum-root", "--skip-stop-assistant", "--skip-stop", "--vellum-root"]) {
      const r = runCli([flag]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unknown flag");
    }
  });

  test("full migration through the CLI: human output + exit 0", async () => {
    const { buildFullVellum0126 } = await import("../helpers/build-fixture.js");
    const { root, home } = await buildFullVellum0126();
    const r = runCli(["--cadet-root", path.join(home, ".cadet"), "--yes"], {
      env: await deterministicDiscoveryEnv(root),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Migration complete");
    expect(r.stdout).toContain(".cadet");
    // Colorful success output carries an optional-next-steps section that
    // includes the manual deletion of the (read-only) old root.
    expect(r.stdout).toContain("Optional next steps");
    expect(r.stdout).toContain(`rm -rf ${root}`);
  });

  test("multiple discovered roots: the user picks interactively", async () => {
    const { buildFullVellum0126, buildMinimal } = await import("../helpers/build-fixture.js");
    const full = await buildFullVellum0126(); // becomes candidate #1 (higher score)
    const minimal = await buildMinimal(); // its home is candidate #2 via $HOME/.vellum

    const r = runCli(["--cadet-root", path.join(minimal.home, ".cadet"), "--yes"], {
      env: {
        HOME: minimal.home,
        VELLUM_DATA_DIR: full.root,
        VELLUM_WORKSPACE_DIR: path.join(full.root, "workspace"),
      },
      stdin: "1\n",
    });

    // The interactive picker listed both and honored the choice.
    expect(r.stderr).toContain("Found multiple vellum installations");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`rm -rf ${full.root}`);
    expect(r.stdout).not.toContain(`rm -rf ${minimal.root}`);
  });
});

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
