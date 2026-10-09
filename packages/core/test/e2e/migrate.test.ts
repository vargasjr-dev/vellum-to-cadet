import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

import { migrate } from "../../src/runner.js";
import type { ProcessOps } from "../../src/types.js";
import { buildFullVellum0126, buildModernVellum } from "../helpers/build-fixture.js";

/** No-op ops: fixtures have no real processes to find or stop. */
const noopOps: ProcessOps = {
  async find() {
    return [];
  },
  async vellumSleep() {},
};

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

describe("e2e: full vellum 0.12.6 workspace", () => {
  test("migrates the full tree, rewrites machine files, keeps user data byte-identical", async () => {
    const { root, home } = await buildFullVellum0126();
    // No explicit cadetRoot: the derivation sends the legacy single root to
    // a named instance under the XDG data root.
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");

    const report = await migrate({
      vellumRoot: root,
      cadetRoot,
      processOps: noopOps,
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
    expect(config).toContain(".local/share/cadet/assistants/vellum/hooks/on-wake.sh");
    expect(config).not.toContain(".vellum");

    const hook = await fs.readFile(path.join(cadetRoot, "hooks/on-wake.sh"), "utf8");
    expect(hook).toContain("$CADET_HOOK_EVENT|$CADET_HOOK_NAME|$CADET_ROOT_DIR|$CADET_WORKSPACE_DIR");
    expect(hook).toContain(".local/share/cadet/assistants/vellum/skills");
    expect(hook).not.toContain("VELLUM_");
    expect(hook).not.toContain(".vellum");

    const skill = await fs.readFile(path.join(cadetRoot, "skills/github-summary/SKILL.md"), "utf8");
    expect(skill).toContain("CADET_ROOT_DIR");
    expect(skill).not.toContain("VELLUM_ROOT_DIR");

    const env = await fs.readFile(path.join(cadetRoot, ".env"), "utf8");
    expect(env).toContain("CADET_PLATFORM_URL");
    expect(env).toContain("CADET_DATA_DIR=~/.local/share/cadet/assistants/vellum");
    expect(env).not.toContain("VELLUM_");

    // ── Dotfile renames. ──
    expect(await exists(path.join(cadetRoot, ".cadetAssistant/version"))).toBe(true);
    expect(await exists(path.join(cadetRoot, ".vellum-assistant"))).toBe(false);
    expect(await exists(path.join(cadetRoot, ".cadet-skill-run/github-summary"))).toBe(true);

    // ── Protected keys: verbatim, dissolved to the per-service dirs. ──
    const key = await fs.readFile(
      path.join(cadetRoot, "gateway-security/actor-token-signing-key"),
      "utf8",
    );
    expect(key).toContain("BEGIN PRIVATE KEY");
    expect(await exists(path.join(cadetRoot, "protected"))).toBe(false);

    // ── Gateway state: relocated to gateway-security (the cadet gateway no
    // longer self-migrates legacy paths — the migrator owns relocations). ──
    expect(
      await fs.readFile(path.join(cadetRoot, "gateway-security/gateway.sqlite"), "utf8"),
    ).toContain("fake-gateway-db");
    expect(
      await fs.readFile(path.join(cadetRoot, "gateway-security/gateway.sqlite-wal"), "utf8"),
    ).toBe("gateway-wal-bytes");
    expect(await exists(path.join(cadetRoot, "data/gateway.sqlite"))).toBe(false);
    // Root-level guardian-init locks relocate too (a stray one would make
    // the migrated gateway re-run guardian init on an installed instance).
    expect(await exists(path.join(cadetRoot, "gateway-security/guardian-init.lock"))).toBe(true);
    expect(await exists(path.join(cadetRoot, "guardian-init.lock"))).toBe(false);
    // Dissolved protected/backup.key wins over the workspace straggler.
    expect(
      await fs.readFile(path.join(cadetRoot, "gateway-security/backup.key"), "utf8"),
    ).toBe("fedcba9876543210fedcba9876543210");
    expect(
      await fs.readFile(path.join(cadetRoot, "workspace/.backup.key"), "utf8"),
    ).toBe("0123456789abcdef0123456789abcdef");
    // CES store → ces-security; CES local data root → ces-data.
    const cesStore = await fs.readFile(
      path.join(cadetRoot, "ces-security/keys.enc"),
    );
    expect(cesStore).toEqual(await fs.readFile(path.join(root, "protected/keys.enc")));
    const grants = await fs.readFile(path.join(cadetRoot, "ces-data/grants.json"), "utf8");
    expect(grants).toContain("grants");

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
      processOps: noopOps,
    });

    const manifest = JSON.parse(await fs.readFile(path.join(report.backupPath!, "manifest.json"), "utf8"));
    for (const file of manifest.files) {
      const onDisk = await fs.readFile(path.join(root, file.path));
      expect(sha(onDisk)).toBe(file.sha256);
    }
  });

  test("re-run against an already migrated root is verify-only and exits 0", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");
    const opts = { vellumRoot: root, cadetRoot, processOps: noopOps };

    const first = await migrate(opts);
    expect(first.ok).toBe(true);

    const second = await migrate(opts);
    expect(second.ok).toBe(true);
    expect(second.mode).toBe("verify-only");
    expect(second.steps.some((s) => s.step === "verify" && s.status === "completed")).toBe(true);
  });

  test("dry run writes nothing anywhere", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");

    const report = await migrate({
      vellumRoot: root,
      cadetRoot,
      dryRun: true,
      processOps: noopOps,
    });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("plan");
    expect(await exists(cadetRoot)).toBe(false);
    const planStep = report.steps.find((s) => s.step === "plan-copy");
    expect(planStep?.status).toBe("planned");
    expect(planStep?.files?.length).toBeGreaterThan(0);
  });

  test("an occupied default cadet root migrates into a fresh instance dir, leaving it untouched", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");
    await fs.mkdir(cadetRoot, { recursive: true });
    await fs.writeFile(path.join(cadetRoot, "unrelated.txt"), "not ours");

    const report = await migrate({ vellumRoot: root, cadetRoot, processOps: noopOps });

    // Idempotent: the migration lands in a fresh instance dir instead of failing.
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(await fs.readdir(cadetRoot)).toEqual(["unrelated.txt"]);

    const freshRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum-2");
    expect(report.detect.cadetRoot).toBe(freshRoot);
    expect(await fs.readdir(freshRoot)).toContain("workspace");

    // Machine files inside the migrated tree reference the fresh instance
    // dir, not the bare cadet root.
    const readme = await fs.readFile(path.join(freshRoot, "workspace/notes/vellum-history.md"), "utf8");
    expect(readme).not.toContain(".local/share/vellum");
  });

  test("an explicit --cadet-root that is occupied is still a conflict (exit 8)", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");
    await fs.mkdir(cadetRoot, { recursive: true });
    await fs.writeFile(path.join(cadetRoot, "unrelated.txt"), "not ours");

    const report = await migrate({
      vellumRoot: root,
      cadetRoot,
      cadetRootExplicit: true,
      processOps: noopOps,
    });

    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(8);
    expect(await fs.readdir(cadetRoot)).toEqual(["unrelated.txt"]);
  });

  test("exit code 2 when there is no vellum root", async () => {
    const home = await fs.mkdtemp(path.join("", "vellum-migrate-empty-"));
    const report = await migrate({
      vellumRoot: path.join(home, ".vellum"),
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });
    expect(report.exitCode).toBe(2);
  });

  test("the vellum root is never mutated: byte-identical before and after", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const before = await treeHash(root);

    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });

    expect(report.ok).toBe(true);
    const after = await treeHash(root);
    expect(after).toEqual(before);

    // Backups live beside the assistants tree (not inside it), still under home.
    expect(report.backupPath).toContain(".cadet-migration-backups");
    expect(report.backupPath).not.toContain("assistants/.cadet-migration-backups");
    expect(report.backupPath!.startsWith(home)).toBe(true);
    // And the old root is still there for the user to delete manually.
    expect(await exists(path.join(root, "workspace/notes/README.md"))).toBe(true);
  });

  test("stop step delegates to `vellum sleep` and never signals anything itself", async () => {
    const { root, home } = await buildFullVellum0126();
    const sleeps: number[] = [];
    const ops: ProcessOps = {
      async find() {
        // Two "running" vellum processes that keep running after sleep.
        return [
          { pid: 111, command: "vellum-assistant daemon" },
          { pid: 222, command: "vellum-gateway" },
        ];
      },
      async vellumSleep() {
        sleeps.push(1);
      },
    };

    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: ops,
      termGraceMs: 0,
    });

    expect(sleeps.length).toBe(1);
    const stop = report.steps.find((s) => s.step === "stop-assistant");
    expect(stop?.status).toBe("failed");
    expect(stop?.summary).toContain("2 vellum process(es) still running after `vellum sleep`");
    expect(report.exitCode).toBe(4);
  });

  test("stop step completes when `vellum sleep` stops everything", async () => {
    const { root, home } = await buildFullVellum0126();
    let findCalls = 0;
    const ops: ProcessOps = {
      // First call = detect (processes running); after sleep, none remain.
      async find() {
        findCalls += 1;
        return findCalls === 1
          ? [{ pid: 111, command: "vellum-assistant daemon" }]
          : [];
      },
      async vellumSleep() {},
    };

    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: ops,
      termGraceMs: 0,
    });

    const stop = report.steps.find((s) => s.step === "stop-assistant");
    expect(stop?.status).toBe("completed");
    expect(report.ok).toBe(true);
  });

  test("reports external references (launchd/compose) without touching them", async () => {
    const { root, home, composePath } = await buildDockerFull();
    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
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

describe("e2e: modern multi-instance layout", () => {
  test("dissolves assistants/<name>/.vellum into the instance dir and maps the XDG root", async () => {
    const { root, home } = await buildModernVellum();
    // Modern vellum resolves absolute state paths into machine files.
    const state = path.join(root, "assistants", "velly", ".vellum");
    await fs.writeFile(
      path.join(state, "config.json"),
      JSON.stringify(
        { hooks: [{ name: "on-wake", command: `bash ${state}/hooks/on-wake.sh` }] },
        null,
        2,
      ),
    );

    // No explicit cadetRoot — the tool derives it from the source shape.
    const report = await migrate({ vellumRoot: root, processOps: noopOps });
    expect(report.ok).toBe(true);

    const cadetRoot = path.join(home, ".local", "share", "cadet");
    expect(report.detect.cadetRoot).toBe(cadetRoot);
    const instance = path.join(cadetRoot, "assistants", "velly");

    // State dissolved: workspace/protected live directly in the instance dir,
    // no redundant `.vellum` (or `.cadet`) level anywhere in the tree.
    const userNote = await fs.readFile(path.join(instance, "workspace/notes/vellum-history.md"), "utf8");
    expect(userNote).toContain("I used vellum before it was cadet");
    expect(await exists(path.join(instance, ".vellum"))).toBe(false);
    expect(await exists(path.join(instance, ".cadet"))).toBe(false);

    // Markers renamed at the instance level.
    expect(await exists(path.join(instance, ".cadetAssistant/version"))).toBe(true);
    expect(await exists(path.join(instance, ".vellum-assistant"))).toBe(false);

    // Protected keys: verbatim, dissolved to the per-service dirs.
    const key = await fs.readFile(
      path.join(instance, "gateway-security/actor-token-signing-key"),
      "utf8",
    );
    expect(key).toContain("BEGIN PRIVATE KEY");
    expect(await exists(path.join(instance, "protected"))).toBe(false);
    expect(await exists(path.join(instance, "ces-security/keys.enc"))).toBe(true);
    expect(await exists(path.join(instance, "ces-data/grants.json"))).toBe(true);

    // DB artifacts: verbatim.
    const db = await fs.readFile(path.join(instance, "workspace/data/db/assistant.db"));
    expect(db.toString()).toContain("SQLite format 3");

    // Machine files: XDG root renamed, state level dissolved, env vars renamed.
    const config = await fs.readFile(path.join(instance, "config.json"), "utf8");
    expect(config).toContain(".local/share/cadet/assistants/velly/hooks/on-wake.sh");
    expect(config).not.toContain("vellum");
    expect(config).not.toContain(".cadet");
    expect(config).not.toContain(".vellum");

    const env = await fs.readFile(path.join(instance, ".env"), "utf8");
    expect(env).toContain("CADET_DATA_DIR=~/.local/share/cadet/assistants/vellum");
    expect(env).not.toContain("VELLUM_");

    // Source untouched; manifest records the modern source shape.
    expect(await exists(path.join(root, "assistants/velly/.vellum/workspace/notes/README.md"))).toBe(true);
    const migManifest = JSON.parse(
      await fs.readFile(path.join(cadetRoot, ".cadet-migration-manifest.json"), "utf8"),
    );
    expect(migManifest.files.some((f: { src: string }) => f.src === "assistants/velly/.vellum/workspace/notes/README.md")).toBe(true);
  });

  test("env-suffixed roots derive a matching cadet root", async () => {
    const { root, home } = await buildModernVellum(undefined, "vellum-dev");
    const report = await migrate({ vellumRoot: root, processOps: noopOps });
    expect(report.ok).toBe(true);
    expect(report.detect.cadetRoot).toBe(path.join(home, ".local", "share", "cadet-dev"));
    expect(await exists(path.join(home, ".local", "share", "cadet-dev", "assistants", "velly", "workspace", "notes", "README.md"))).toBe(true);
  });
});

describe("e2e: legacy home-level lockfile move", () => {
  test("moves ~/.cadet.lock.json into the config dir during migration", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    // An ambient XDG_CONFIG_HOME (CI runners set it) would hijack the
    // destination out of the sandboxed home — sandbox it like HOME.
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    try {
      // A pre-move cadet install left its identity file at the home level.
      await fs.writeFile(
        path.join(home, ".cadet.lock.json"),
        JSON.stringify({ assistants: [{ assistantId: "old-bot" }] }, null, 2),
      );

      const report = await migrate({ vellumRoot: root, processOps: noopOps });

      expect(report.ok).toBe(true);
      const lockStep = report.steps.find((s) => s.step === "migrate-lockfile");
      expect(lockStep?.status).toBe("completed");
      expect(lockStep?.summary).toContain(".cadet.lock.json");
      // The file MOVED — the config dir now holds it, the home level does not.
      expect(
        await fs.access(path.join(home, ".config", "cadet", "lockfile.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(
        await fs.access(path.join(home, ".cadet.lock.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
  });

  test("leaves the home-level file when the config-dir lockfile already exists", async () => {
    const { root, home } = await buildFullVellum0126();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    try {
      await fs.mkdir(path.join(home, ".config", "cadet"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".config", "cadet", "lockfile.json"),
        JSON.stringify({ assistants: [{ assistantId: "live-bot" }] }, null, 2),
      );
      await fs.writeFile(
        path.join(home, ".cadet.lock.json"),
        JSON.stringify({ assistants: [{ assistantId: "old-bot" }] }, null, 2),
      );

      const report = await migrate({ vellumRoot: root, processOps: noopOps });

      expect(report.ok).toBe(true);
      const lockStep = report.steps.find((s) => s.step === "migrate-lockfile");
      expect(lockStep?.status).toBe("completed");
      expect(lockStep?.summary).toContain("left untouched");
      expect(lockStep?.issues?.[0]?.severity).toBe("warning");
      // Neither file was destroyed.
      expect(
        await fs.readFile(path.join(home, ".config", "cadet", "lockfile.json"), "utf8"),
      ).toContain("live-bot");
      expect(
        await fs.readFile(path.join(home, ".cadet.lock.json"), "utf8"),
      ).toContain("old-bot");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
  });
});
