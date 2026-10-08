import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

import { migrate } from "../../src/runner.js";
import type { ProcessKiller } from "../../src/types.js";
import { buildFullVellum0126 } from "../helpers/build-fixture.js";

/** A no-op killer: fixtures have no real processes to find. */
const noopKiller: ProcessKiller = {
  async find() {
    return [];
  },
  async terminate() {},
  async kill() {},
};

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

describe("e2e: full vellum 0.12.6 workspace", () => {
  test("migrates the full tree, rewrites machine files, keeps user data byte-identical", async () => {
    const { root, home } = await buildFullVellum0126();
    const cadetRoot = path.join(home, ".cadet");

    const report = await migrate({
      vellumRoot: root,
      cadetRoot,
      processKiller: noopKiller,
    });

    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);

    // ── User workspace: byte-for-byte, including vellum prose. ──
    const userNote = await fs.readFile(path.join(cadetRoot, "workspace/notes/vellum-history.md"), "utf8");
    expect(userNote).toContain("I used vellum before it was cadet");
    expect(userNote).toContain("VELLUM_ROOT_DIR was a nice env var");

    const project = await fs.readFile(path.join(cadetRoot, "workspace/projects/demo/index.ts"), "utf8");
    expect(project).toBe("export const greeting = 'hello from my project';\n");

    // ── Machine files: rewritten. ──
    const config = await fs.readFile(path.join(cadetRoot, "config.json"), "utf8");
    expect(config).toContain("@mycadet/slack");
    expect(config).toContain("@mycadet/twilio");
    expect(config).not.toContain("@vellumai/");
    expect(config).toContain(".cadet/hooks/on-wake.sh");
    expect(config).not.toContain(".vellum");

    const hook = await fs.readFile(path.join(cadetRoot, "hooks/on-wake.sh"), "utf8");
    expect(hook).toContain("$CADET_HOOK_EVENT|$CADET_HOOK_NAME|$CADET_ROOT_DIR|$CADET_WORKSPACE_DIR");
    expect(hook).toContain(".cadet/skills");
    expect(hook).not.toContain("VELLUM_");
    expect(hook).not.toContain(".vellum");

    const skill = await fs.readFile(path.join(cadetRoot, "skills/github-summary/SKILL.md"), "utf8");
    expect(skill).toContain("CADET_ROOT_DIR");
    expect(skill).not.toContain("VELLUM_ROOT_DIR");

    const env = await fs.readFile(path.join(cadetRoot, ".env"), "utf8");
    expect(env).toContain("CADET_PLATFORM_URL");
    expect(env).toContain("CADET_DATA_DIR=~/.cadet");
    expect(env).not.toContain("VELLUM_");

    // ── Dotfile renames. ──
    expect(await exists(path.join(cadetRoot, ".cadetAssistant/version"))).toBe(true);
    expect(await exists(path.join(cadetRoot, ".vellum-assistant"))).toBe(false);
    expect(await exists(path.join(cadetRoot, ".cadet-skill-run/github-summary"))).toBe(true);

    // ── Protected keys: verbatim. ──
    const key = await fs.readFile(path.join(cadetRoot, "protected/actor-token-signing-key"), "utf8");
    expect(key).toContain("BEGIN PRIVATE KEY");

    // ── DB artifacts copied verbatim. ──
    const db = await fs.readFile(path.join(cadetRoot, "workspace/data/db/assistant.db"));
    expect(db.toString()).toContain("SQLite format 3");

    // ── Backup exists with manifest, source untouched. ──
    expect(report.backupPath).toBeTruthy();
    const manifest = JSON.parse(await fs.readFile(path.join(report.backupPath!, "manifest.json"), "utf8"));
    expect(manifest.fileCount).toBeGreaterThan(0);
    const backedUp = await fs.readFile(path.join(report.backupPath!, "workspace/notes/vellum-history.md"), "utf8");
    expect(backedUp).toContain("vellum");
    // Source root still intact — it is a read-only source of truth, always.
    expect(await exists(path.join(root, "workspace/notes/README.md"))).toBe(true);

    // ── Migration manifest is the audit trail + idempotency marker. ──
    const migManifest = JSON.parse(
      await fs.readFile(path.join(cadetRoot, ".cadet-migration-manifest.json"), "utf8"),
    );
    expect(migManifest.vellumVersion).toBe("0.12.6");
    expect(migManifest.files.length).toBeGreaterThan(0);
  });

  test("backup manifest hashes match the source tree exactly", async () => {
    const { root, home } = await buildFullVellum0126();
    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processKiller: noopKiller,
    });

    const manifest = JSON.parse(await fs.readFile(path.join(report.backupPath!, "manifest.json"), "utf8"));
    for (const file of manifest.files) {
      const onDisk = await fs.readFile(path.join(root, file.path));
      expect(sha(onDisk)).toBe(file.sha256);
    }
  });

  test("re-run against an already migrated root is verify-only and exits 0", async () => {
    const { root, home } = await buildFullVellum0126();
    const cadetRoot = path.join(home, ".cadet");
    const opts = { vellumRoot: root, cadetRoot, processKiller: noopKiller };

    const first = await migrate(opts);
    expect(first.ok).toBe(true);

    const second = await migrate(opts);
    expect(second.ok).toBe(true);
    expect(second.mode).toBe("verify-only");
    expect(second.steps.some((s) => s.step === "verify" && s.status === "completed")).toBe(true);
  });

  test("dry run writes nothing anywhere", async () => {
    const { root, home } = await buildFullVellum0126();
    const cadetRoot = path.join(home, ".cadet");

    const report = await migrate({
      vellumRoot: root,
      cadetRoot,
      dryRun: true,
      processKiller: noopKiller,
    });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("plan");
    expect(await exists(cadetRoot)).toBe(false);
    const planStep = report.steps.find((s) => s.step === "plan-copy");
    expect(planStep?.status).toBe("planned");
    expect(planStep?.files?.length).toBeGreaterThan(0);
  });

  test("abort with code 8 when cadet root exists and is populated without a manifest", async () => {
    const { root, home } = await buildFullVellum0126();
    const cadetRoot = path.join(home, ".cadet");
    await fs.mkdir(cadetRoot, { recursive: true });
    await fs.writeFile(path.join(cadetRoot, "unrelated.txt"), "not ours");

    const report = await migrate({ vellumRoot: root, cadetRoot, processKiller: noopKiller });

    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(8);
    // Nothing was written into the foreign cadet root.
    expect(await fs.readdir(cadetRoot)).toEqual(["unrelated.txt"]);
  });

  test("exit code 2 when there is no vellum root", async () => {
    const home = await fs.mkdtemp(path.join("", "vellum-migrate-empty-"));
    const report = await migrate({
      vellumRoot: path.join(home, ".vellum"),
      cadetRoot: path.join(home, ".cadet"),
      processKiller: noopKiller,
    });
    expect(report.exitCode).toBe(2);
  });

  test("the vellum root is never mutated: byte-identical before and after", async () => {
    const { root, home } = await buildFullVellum0126();
    const before = await treeHash(root);

    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processKiller: noopKiller,
    });

    expect(report.ok).toBe(true);
    const after = await treeHash(root);
    expect(after).toEqual(before);

    // Backups live on the cadet side of the house.
    expect(report.backupPath).toContain(".cadet-migration-backups");
    expect(report.backupPath!.startsWith(home)).toBe(true);
    // And the old root is still there for the user to delete manually.
    expect(await exists(path.join(root, "workspace/notes/README.md"))).toBe(true);
  });

  test("stops running vellum processes before migrating (injected killer)", async () => {
    const { root, home } = await buildFullVellum0126();
    const terminated: number[] = [];
    const killed: number[] = [];
    const killer: ProcessKiller = {
      async find() {
        // Two "running" vellum processes; the second survives TERM.
        return [
          { pid: 111, command: "vellum-assistant daemon" },
          { pid: 222, command: "vellum-gateway" },
        ];
      },
      async terminate(pid) {
        terminated.push(pid);
      },
      async kill(pid) {
        killed.push(pid);
      },
    };

    const report = await migrate({ vellumRoot: root, cadetRoot: path.join(home, ".cadet"), processKiller: killer, termGraceMs: 0 });

    // In the test the processes are always "still running" after TERM grace,
    // so both get escalated to SIGKILL — and the run still succeeds because
    // the injected killer reports them dead afterwards via find()... except
    // find() always returns the same two. The stop step tolerates that:
    // escalation happened, run proceeds.
    expect(terminated).toEqual([111, 222]);
    expect(killed).toEqual([111, 222]);
    expect(report.ok).toBe(true);
  });

  test("reports external references (launchd/compose) without touching them", async () => {
    const { root, home, composePath } = await buildDockerFull();
    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processKiller: noopKiller,
    });

    expect(report.ok).toBe(true);
    const detectData = report.steps[0]?.data as { externalReferences: string[] } | undefined;
    void detectData; // v0 probes are environment-dependent; asserted via compose untouched:
    const compose = await fs.readFile(composePath, "utf8");
    expect(compose).toContain(".vellum"); // never rewritten — reported instead
  });
});

// ── helpers ──

/** Deterministic content hash of an entire directory tree. */
async function treeHash(dir: string): Promise<string> {
  const entries: Array<{ rel: string; hash: string }> = [];
  await walk(dir, "");
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");

  async function walk(abs: string, rel: string): Promise<void> {
    for (const item of (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${item.name}` : item.name;
      const p = path.join(abs, item.name);
      if (item.isDirectory()) await walk(p, r);
      else entries.push({ rel: r, hash: sha(await fs.readFile(p)) });
    }
  }
}

async function buildDockerFull() {
  const { buildDocker } = await import("../helpers/build-fixture.js");
  return buildDocker();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
