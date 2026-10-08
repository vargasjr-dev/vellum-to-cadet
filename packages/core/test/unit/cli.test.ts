import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";

const cliPath = path.join(
  url.fileURLToPath(new URL(".", import.meta.url)),
  "../../src/cli.ts",
);

function runCli(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", cliPath, ...args], {
    cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
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
    const r = runCli(
      [
        "--vellum-root", path.join(home, ".vellum"),
        "--cadet-root", path.join(home, ".cadet"),
        "--json",
      ],
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    expect(report.mode).toBe("plan");
    expect(report.steps[0].step).toBe("detect");
  });

  test("removed flags are rejected", () => {
    for (const flag of ["--remove-vellum-root", "--skip-stop-assistant"]) {
      const r = runCli([flag]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unknown flag");
    }
  });

  test("full migration through the CLI: human output + exit 0", async () => {
    const { buildFullVellum0126 } = await import("../helpers/build-fixture.js");
    const { root, home } = await buildFullVellum0126();
    const r = runCli([
      "--vellum-root", root,
      "--cadet-root", path.join(home, ".cadet"),
      "--yes",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Migration complete");
    expect(r.stdout).toContain(".cadet");
    // Colorful success output carries an optional-next-steps section that
    // includes the manual deletion of the (read-only) old root.
    expect(r.stdout).toContain("Optional next steps");
    expect(r.stdout).toContain(`rm -rf ${root}`);
  });
});

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
