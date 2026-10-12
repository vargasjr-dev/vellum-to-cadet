import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

import { expect } from "../helpers/expect.js";

// The BUILT CLI — node can't run the TS source directly, and the tests
// exercise exactly the dist the npx package ships.
const cliPath = path.join(
  url.fileURLToPath(new URL(".", import.meta.url)),
  "../../../dist/cli.js",
);

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): { code: number; stdout: string; stderr: string } {
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
    expect(r.stdout).toContain("--foreground");
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
    expect(r.stdout).toContain("npx migrate-vellum-assistant-to-cadet uninstall");
    expect(r.stdout).not.toContain(`rm -rf ${root}`);
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
    expect(r.stdout).toContain("npx migrate-vellum-assistant-to-cadet uninstall");
    expect(r.stdout).not.toContain(`rm -rf ${full.root}`);
    expect(r.stdout).not.toContain(`rm -rf ${minimal.root}`);
  });

  test("a live run lock exits 12 with an already-running message", async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), "cli-lock-"));
    await fs.mkdir(path.join(home, ".cadet-migration-logs"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".cadet-migration-logs", "migrate.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "t0", logPath: "migrate-live.log" }),
    );
    const r = runCli([], { env: { HOME: home } });
    expect(r.code).toBe(12);
    expect(r.stderr).toContain("a migration is already running");
    expect(r.stderr).toContain(`pid ${process.pid}`);
    expect(r.stderr).toContain("tail -f migrate-live.log");
  });

  test("a stale run lock (dead pid) is broken and the run proceeds", async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), "cli-stale-"));
    await fs.mkdir(path.join(home, ".cadet-migration-logs"), { recursive: true });
    // 2^30 is far above every pid_max — the pid cannot be alive.
    await fs.writeFile(
      path.join(home, ".cadet-migration-logs", "migrate.lock"),
      JSON.stringify({ pid: 1 << 30, startedAt: "t0", logPath: "migrate-dead.log" }),
    );
    const r = runCli([], { env: { HOME: home } });
    // Proceeded past the lock — no vellum root in this home, so exit 2 (not 12).
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("already running");
  });

  test("the default run detaches: started line with the pid, log relayed to stdout, log file kept", { timeout: 30000 }, async () => {
    const { buildFullVellum0126 } = await import("../helpers/build-fixture.js");
    const { root } = await buildFullVellum0126();
    const env = await deterministicDiscoveryEnv(root);
    // The run-log dir lives under the CLI's $HOME — the helper's fake home,
    // not the fixture's.
    const logsDir = path.join(env["HOME"]!, ".cadet-migration-logs");
    const r = runCli(["--cadet-root", path.join(env["HOME"]!, ".cadet"), "--yes"], {
      env: {
        ...env,
        npm_config_registry: "http://127.0.0.1:1/", // install-cadet fails fast — a warning, not a hang
        XDG_CONFIG_HOME: path.join(env["HOME"]!, ".config"),
        XDG_DATA_HOME: path.join(env["HOME"]!, ".local", "share"),
      },
    });
    expect(r.code).toBe(0);
    // The started line: the header, then the pid + run-log path as nested
    // bullets under the redirected HOME.
    expect(r.stdout).toMatch(
      /✔ started\s+Begun Vellum to Cadet migration\n {4}· pid \d+\n {4}· logs: .+\.cadet-migration-logs\/migrate-.+\.log/,
    );
    // The child's output was relayed through to this process's stdout.
    expect(r.stdout).toContain("Migration complete");
    // The log file holds the record (the tail-able artifact).
    const logFiles = (await fs.readdir(logsDir)).filter((f) => f.startsWith("migrate-") && f.endsWith(".log"));
    expect(logFiles.length).toBe(1);
    const logText = await fs.readFile(path.join(logsDir, logFiles[0]!), "utf8");
    expect(logText).toContain("Migration complete");
    // The lock was released when the child finished.
    expect(fsExistsSync(path.join(logsDir, "migrate.lock"))).toBe(false);
  });

  test("--foreground runs in-process and tees the run-log", { timeout: 30000 }, async () => {
    const { buildFullVellum0126 } = await import("../helpers/build-fixture.js");
    const { root } = await buildFullVellum0126();
    const env = await deterministicDiscoveryEnv(root);
    const logsDir = path.join(env["HOME"]!, ".cadet-migration-logs");
    const r = runCli(["--cadet-root", path.join(env["HOME"]!, ".cadet"), "--yes", "--foreground"], {
      env: {
        ...env,
        npm_config_registry: "http://127.0.0.1:1/",
        XDG_CONFIG_HOME: path.join(env["HOME"]!, ".config"),
        XDG_DATA_HOME: path.join(env["HOME"]!, ".local", "share"),
      },
    });
    expect(r.code).toBe(0);
    // The started line still prints (its own pid, its own log path).
    expect(r.stdout).toMatch(/✔ started\s+Begun Vellum to Cadet migration\n {4}· pid \d+\n {4}· logs: /);
    expect(r.stdout).toContain("Migration complete");
    // And the run-log holds everything the terminal saw.
    const logFiles = (await fs.readdir(logsDir)).filter((f) => f.startsWith("migrate-") && f.endsWith(".log"));
    expect(logFiles.length).toBe(1);
    expect(await fs.readFile(path.join(logsDir, logFiles[0]!), "utf8")).toContain("Migration complete");
  });

  test("--internal-run renders the relayed terminal stream and releases the lock", { timeout: 30000 }, async () => {
    const { buildFullVellum0126 } = await import("../helpers/build-fixture.js");
    const { root, home } = await buildFullVellum0126();
    const logsDir = path.join(home, ".cadet-migration-logs");
    await fs.mkdir(logsDir, { recursive: true });
    const r = runCli(
      [
        "--cadet-root", path.join(home, ".cadet"),
        "--yes",
        "--internal-run",
        "--run-log", path.join(logsDir, "migrate-manual.log"),
        "--internal-lock", path.join(logsDir, "migrate.lock"),
        "--internal-vellum-root", root,
      ],
      {
        env: {
          HOME: home,
          npm_config_registry: "http://127.0.0.1:1/",
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
        },
      },
    );
    expect(r.code).toBe(0);
    // The run-log child renders its full terminal stream (forced live +
    // color): the pending line, then the completed line replacing it.
    const plainStderr = stripAnsi(r.stderr);
    expect(plainStderr).toContain("· detect …");
    expect(plainStderr).toContain("✔ detect");
    // The cursor math and color are IN the stream — the parent's relay
    // passes them to a real terminal, where the view rewrites in place
    // (piped relays strip them; this is the raw child stream).
    expect(r.stderr).toContain("\u001b[1A\u001b[2K");
    expect(r.stderr).toContain("\u001b[32m");
    // The final block lands on stdout.
    expect(r.stdout).toContain("Migration complete");
    expect(fsExistsSync(path.join(logsDir, "migrate.lock"))).toBe(false);
  });

  test("the no-root failure names every searched location, modern roots included", async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), "cli-noroot-"));
    const r = runCli(["--cadet-root", path.join(home, ".cadet"), "--json"], {
      env: { HOME: home },
    });
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    // Roots AND lockfiles: the modern XDG root must be visibly searched —
    // a report naming only the legacy home root reads like the modern
    // layout was never looked for.
    expect(report.searched).toContain(path.join(home, ".vellum"));
    expect(report.searched).toContain(path.join(home, ".local", "share", "vellum"));
    expect(report.searched).toContain(path.join(home, ".vellum.lock.json"));
    expect(report.searched).toContain(path.join(home, ".config", "vellum", "lockfile.json"));
  });

  test("a vellum lockfile without a root directory self-diagnoses", async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), "cli-lockonly-"));
    // A docker-tracked install's root may be missing or marker-less — the
    // failure must say the lockfile was seen, not imply nothing was found.
    await fs.writeFile(
      path.join(home, ".vellum.lock.json"),
      JSON.stringify({ assistants: [{ assistantId: "velly", cloud: "local" }] }),
    );
    const r = runCli(["--cadet-root", path.join(home, ".cadet")], {
      env: { HOME: home },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("found a vellum lockfile");
    expect(r.stderr).toContain(".vellum.lock.json");
  });
});

/** Test view of the relay's piped contract: escape sequences and CRs gone. */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]|\r/g, "");
}

import { existsSync as fsExistsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
