import { DatabaseSync as Database } from "node:sqlite";
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, test } from "node:test";

import { migrate, repair } from "../../src/runner.js";
import { migrateAssistantDbAt } from "../../src/steps/migrate-assistant-db.js";
import { stopAssistant } from "../../src/steps/stop-assistant.js";
import type { ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { buildFullVellum0126, buildModernVellum } from "../helpers/build-fixture.js";

/** No-op ops: fixtures have no real processes to find or stop. */
const noopOps: ProcessOps = {
  async vellumVersion() {
    return null;
  },
  async find() {
    return [];
  },
  async vellumSleep() {},
  async cadetSleep() {},
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

    // ── Machine-owned files inside the workspace: vellum VALUES rewritten. ──
    const wsConfig = JSON.parse(await fs.readFile(path.join(cadetRoot, "workspace/config.json"), "utf8"));
    expect(wsConfig.profiles[0].provider).toBe("cadet");
    expect(wsConfig.profiles[1].provider).toBe("anthropic");
    expect(wsConfig.services.stt.provider).toBe("cadet");
    const installMeta = JSON.parse(
      await fs.readFile(path.join(cadetRoot, "workspace/skills/github-summary/install-meta.json"), "utf8"),
    );
    expect(installMeta.origin).toBe("cadet");
    const pluginSource = await fs.readFile(path.join(cadetRoot, "workspace/plugins/greeter/index.ts"), "utf8");
    expect(pluginSource).toContain("@mycadet/plugin-api");
    expect(pluginSource).not.toContain("@vellumai/");
    const pluginPkg = JSON.parse(
      await fs.readFile(path.join(cadetRoot, "workspace/plugins/greeter/package.json"), "utf8"),
    );
    expect(Object.keys(pluginPkg.dependencies)[0]).toBe("@mycadet/plugin-api");

    // ── User content inside the workspace stays byte-for-byte — EXCEPT the
    // skill frontmatter contract (metadata.vellum → metadata.cadet), its own
    // reported substep; prose below the frontmatter survives. ──
    const skillDoc = await fs.readFile(
      path.join(cadetRoot, "workspace/skills/github-summary/SKILL.md"),
      "utf8",
    );
    expect(skillDoc).toContain("From the vellum catalog.");
    expect(skillDoc).toContain("  cadet:\n    display-name: GitHub Summary");
    expect(skillDoc).not.toContain("  vellum:");
    const history = await fs.readFile(
      path.join(cadetRoot, "workspace/notes/vellum-history.md"),
      "utf8",
    );
    expect(history).toContain("I used vellum before it was cadet.");

    // ── Conversation logs + runtime logs: PRECISE edits only — attachment
    // links and channel values flip so the runtime never reads broken
    // history; quoted prose and single-quoted shell output survive. ──
    const convo = await fs.readFile(
      path.join(
        cadetRoot,
        "workspace/conversations/2026-10-01T09-00-00.000Z_11111111-1111-4111-8111-111111111111/messages.jsonl",
      ),
      "utf8",
    );
    expect(convo).toContain("cadet://workspace/data/attachments/q3-report.pdf");
    expect(convo).toContain('"channel":"cadet"');
    expect(convo).toContain("I used vellum before it was cadet");
    expect(convo).toContain("type = 'vellum'");
    expect(convo).not.toContain("vellum://");

    const toolResult = await fs.readFile(
      path.join(
        cadetRoot,
        "workspace/conversations/2026-10-01T09-00-00.000Z_11111111-1111-4111-8111-111111111111/.tool-results/abc123.txt",
      ),
      "utf8",
    );
    expect(toolResult).toContain("cadet://workspace/data/attachments/notes.txt");
    expect(toolResult).toContain("plain vellum in prose");

    const dailyLog = await fs.readFile(
      path.join(cadetRoot, "workspace/data/logs/assistant-2026-10-09.log"),
      "utf8",
    );
    expect(dailyLog).toContain("cadet://workspace/data/attachments/q3-report.pdf");
    expect(dailyLog).toContain('channel "cadet"');
    expect(dailyLog).toContain("CADET_ROOT_DIR=");
    expect(dailyLog).toContain(".local/share/cadet/assistants/vellum/workspace");
    expect(dailyLog).toContain('user said "I used vellum before it was cadet"');
    expect(dailyLog).not.toContain("VELLUM_");
    expect(dailyLog).not.toContain("vellum://");

    // The legacy-named log file keeps its name (cadet never reads it) but
    // its content follows the same rules.
    expect(await exists(path.join(cadetRoot, "workspace/data/logs/vellum.log"))).toBe(true);
    const legacyLog = await fs.readFile(path.join(cadetRoot, "workspace/data/logs/vellum.log"), "utf8");
    expect(legacyLog).toContain("cadet://workspace/data/attachments/old.txt");

    // ── Persona prompt files: brand references flip so the persona never
    // tells cadet it runs on vellum — while the migrated instance's own
    // name (vellum, inside rewritten paths) survives untouched. ──
    const soul = await fs.readFile(path.join(cadetRoot, "workspace/SOUL.md"), "utf8");
    expect(soul).toContain("comes with the Cadet harness");
    expect(soul).toContain("cadet://workspace/notes/readme");
    expect(soul).toContain("~/.local/share/cadet/assistants/vellum");
    expect(soul).not.toContain("Vellum");
    expect(soul).not.toContain("vellum://");

    // ── Protected keys: verbatim, dissolved to the per-service dirs. ──
    const key = await fs.readFile(
      path.join(cadetRoot, "gateway-security/actor-token-signing-key"),
      "utf8",
    );
    expect(key).toContain("BEGIN PRIVATE KEY");
    expect(await exists(path.join(cadetRoot, "protected"))).toBe(false);

    // ── Gateway state: relocated to gateway-security (the cadet gateway no
    // longer self-migrates legacy paths — the migrator owns relocations) and
    // value-migrated (the gateway's own channel-branded rows). The fake
    // -wal sidecar folds away on the step's checkpoint — asserted BEFORE
    // the readonly inspection below, which re-creates the sidecars (any
    // open of a wal-mode db does, even readonly). ──
    expect(await exists(path.join(cadetRoot, "gateway-security/gateway.sqlite-wal"))).toBe(false);
    expect(await exists(path.join(cadetRoot, "data/gateway.sqlite"))).toBe(false);
    const gwStep = report.steps.find((s) => s.step === "migrate-gateway-db");
    expect(gwStep?.status).toBe("completed");
    const gwDb = new Database(path.join(cadetRoot, "gateway-security/gateway.sqlite"), {
      readOnly: true,
    });
    const gwChannelTypes = gwDb.prepare(`SELECT type AS t FROM contact_channels ORDER BY id`).all();
    expect(gwChannelTypes).toEqual([{ t: "cadet" }, { t: "telegram" }]);
    const gwInvites = gwDb.prepare(`SELECT source_channel AS c FROM ingress_invites`).all();
    expect(gwInvites).toEqual([{ c: "cadet" }]);
    const gwOverrides = gwDb
      .prepare(`SELECT channel_type AS t FROM channel_permission_overrides ORDER BY id`)
      .all();
    expect(gwOverrides).toEqual([{ t: "cadet" }, { t: "slack" }]);
    gwDb.close();
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

    // ── DB artifacts copied, then the assistant DB value-migrated. ──
    const db = await fs.readFile(path.join(cadetRoot, "workspace/data/db/assistant.db"));
    expect(db.toString()).toContain("SQLite format 3");
    const dbStep = report.steps.find((s) => s.step === "migrate-assistant-db");
    expect(dbStep?.status).toBe("completed");
    const migratedDb = new Database(path.join(cadetRoot, "workspace/data/db/assistant.db"), {
      readOnly: true,
    });
    const convChannels = migratedDb
      .prepare(`SELECT origin_channel AS c FROM conversations ORDER BY id`)
      .all();
    expect(convChannels).toEqual([{ c: "cadet" }, { c: "telegram" }]);
    const msg = migratedDb
      .prepare(
        `SELECT content, user_message_channel, assistant_message_channel, metadata
         FROM messages WHERE id = 'm1'`,
      )
      .get() as { content: string; user_message_channel: string; assistant_message_channel: string; metadata: string };
    expect(msg.content).toContain("cadet://workspace/report.md");
    expect(msg.content).not.toContain("vellum://");
    expect(msg.user_message_channel).toBe("cadet");
    expect(msg.assistant_message_channel).toBe("cadet");
    expect(JSON.parse(msg.metadata).channel).toBe("cadet");
    const conns = migratedDb
      .prepare(`SELECT name, provider FROM provider_connections ORDER BY name`)
      .all();
    expect(conns).toEqual([
      { name: "cadet", provider: "cadet" },
      { name: "openai", provider: "openai" },
    ]);
    migratedDb.close();

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

  test("stop step delegates to `vellum sleep` and proceeds even when pgrep reports look-alike processes", async () => {
    const { root, home } = await buildFullVellum0126();
    const sleeps: number[] = [];
    const ops: ProcessOps = {
      async vellumVersion() {
        return null;
      },
      async find() {
        // pgrep pattern matches are untrustworthy: a browser's bundled
        // credential-executor helpers matched here on a real migration.
        // Whatever find reports, the migration proceeds — no re-check.
        return [
          { pid: 111, command: "vellum-assistant daemon" },
          { pid: 222, command: "Arc Browser Helper (Renderer)" },
        ];
      },
      async vellumSleep() {
        sleeps.push(1);
      },
      async cadetSleep() {},
    };

    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: ops,
      termGraceMs: 0,
    });

    expect(sleeps.length).toBe(1);
    const stop = report.steps.find((s) => s.step === "stop-assistant");
    expect(stop?.status).toBe("completed");
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
  });

  test("the stop step never re-discovers processes after sleeping", async () => {
    const { root, home } = await buildFullVellum0126();
    let findCalls = 0;
    const ops: ProcessOps = {
      async vellumVersion() {
        return null;
      },
      async find() {
        findCalls += 1;
        return [{ pid: 111, command: "vellum-assistant daemon" }];
      },
      async vellumSleep() {},
      async cadetSleep() {},
    };

    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: ops,
      termGraceMs: 0,
    });

    // find is detect's informational probe only — the stop step trusts
    // the sleep and does not re-discover.
    expect(findCalls).toBe(1);
    const stop = report.steps.find((s) => s.step === "stop-assistant");
    expect(stop?.status).toBe("completed");
    expect(report.ok).toBe(true);
  });

  test("the migrated instance is named after the source assistant's handle", async () => {
    // Real vellum assistants have handles like vellum-fresh-eel-8di6pa —
    // cadet keeps the distinctive part, not our old default "vellum".
    const { root, home } = await buildModernVellum(undefined, "vellum", "vellum-fresh-eel-8di6pa");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // A populated cadet root makes the run take the named-instance path.
      const cadetData = path.join(home, ".local", "share", "cadet");
      await fs.mkdir(cadetData, { recursive: true });
      await fs.writeFile(path.join(cadetData, "sentinel.txt"), "occupied");

      const report = await migrate({
        vellumRoot: root,
        processOps: noopOps,
      });

      expect(report.ok).toBe(true);
      expect(report.detect.cadetRoot).toBe(
        path.join(cadetData, "assistants", "fresh-eel-8di6pa"),
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("the gateway db is found at its real protected/ source location", async () => {
    // Seen in the wild: assistants/<handle>/.vellum/protected/gateway.sqlite
    // reported as "no gateway db in the migrated workspace".
    const { root, home } = await buildModernVellum();
    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });

    expect(report.ok).toBe(true);
    const gw = report.steps.find((s) => s.step === "migrate-gateway-db");
    expect(gw?.status).toBe("completed");
    expect(gw?.summary).not.toContain("no gateway db");
  });

  test("db value migrations skip missing columns silently and keep going", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-db-warn-"));
    const cadetRoot = path.join(home, ".cadet");
    const dbDir = path.join(cadetRoot, "workspace", "data", "db");
    await fs.mkdir(dbDir, { recursive: true });
    // A messages table WITHOUT the expected channel columns: the schema
    // drift the old product's own migration 120 introduced when it rebuilt
    // messages — expected for newer DBs, so skipped silently, not a ⚠.
    const db = new Database(path.join(dbDir, "assistant.db"));
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)");
    db.exec("INSERT INTO messages (content) VALUES ('see vellum://attachment-1')");
    db.close();

    const result = await migrateAssistantDbAt(cadetRoot, "workspace/data/db/assistant.db");

    // The step keeps going: completed, no warnings, nothing about columns.
    expect(result.status).toBe("completed");
    expect(result.issues ?? []).toEqual([]);
    expect(result.summary).not.toContain("no such column");
    // The phase that COULD run (attachment links) still ran.
    expect(result.summary).toContain("attachment links: 1 row(s)");
  });

  test("a newer-vellum assistant db (schema 120+ shape) verifies semantically", async () => {
    const { root, home } = await buildFullVellum0126();
    // The old product's migration 120 rebuilt messages WITHOUT the channel
    // columns (content/metadata survived). Its channel-value UPDATEs skip
    // silently, and verify must still check the db semantically — falling
    // back to a byte diff would flag the value migration as an error.
    const dbPath = path.join(root, "workspace", "data", "db", "assistant.db");
    const db = new Database(dbPath);
    db.exec(`DROP TABLE messages`);
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, metadata TEXT)");
    db.exec("INSERT INTO messages (content, metadata) VALUES ('see vellum://a.png', NULL)");
    db.close();

    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");
    const report = await migrate({ vellumRoot: root, cadetRoot, processOps: noopOps });

    expect(report.ok).toBe(true);
    const verifyStep = report.steps.find((s) => s.step === "verify");
    expect(verifyStep?.status).toBe("completed");
    // Semantically checked (not the byte-diff fallback).
    expect((verifyStep?.data as { dbsChecked: number } | undefined)?.dbsChecked ?? 0).toBeGreaterThan(0);
    expect(
      (verifyStep?.issues ?? []).some((i) => i.message.includes("could not be checked semantically")),
    ).toBe(false);
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

  test("a lockfile-tracked docker deployment is detected as docker", async () => {
    const { root, home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // A hatch-docker install: the CLI records the topology in its lockfile.
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: "velly",
              cloud: "docker",
              containerInfo: { assistantImage: "vellumai/vellum-assistant" },
            },
          ],
        }),
      );
      const report = await migrate({
        vellumRoot: root,
        cadetRoot: path.join(home, ".cadet"),
        processOps: noopOps,
      });

      expect(report.ok).toBe(true);
      expect(report.detect.deploymentKind).toBe("docker");
      expect(report.detect.docker.instances).toEqual(["velly"]);
      expect(report.detect.docker.images).toEqual(["vellumai/vellum-assistant"]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
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

    // DB artifacts: copied, then value-migrated (assistant + gateway dbs).
    const db = await fs.readFile(path.join(instance, "workspace/data/db/assistant.db"));
    expect(db.toString()).toContain("SQLite format 3");
    const gwDb = new Database(path.join(instance, "gateway-security/gateway.sqlite"), {
      readOnly: true,
    });
    const gwChannelTypes = gwDb.prepare(`SELECT type AS t FROM contact_channels ORDER BY id`).all();
    expect(gwChannelTypes).toEqual([{ t: "cadet" }, { t: "telegram" }]);
    gwDb.close();
    expect(
      await exists(path.join(instance, "workspace/skills/github-summary/SKILL.md")),
    ).toBe(true);
    const modernSkillDoc = await fs.readFile(
      path.join(instance, "workspace/skills/github-summary/SKILL.md"),
      "utf8",
    );
    expect(modernSkillDoc).toContain("  cadet:");
    expect(modernSkillDoc).not.toContain("  vellum:");

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

describe("e2e: repair mode", () => {
  test("self-discovers the migrated cadet root and re-runs the idempotent value steps", async () => {
    const { root, home } = await buildFullVellum0126();
    const migrateReport = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });
    expect(migrateReport.ok).toBe(true);
    const cadetRoot = path.join(home, ".cadet");

    // Simulate a migration bug: legacy tokens back in migrated files, a
    // vellum-branded row back in the assistant db.
    const logPath = path.join(cadetRoot, "workspace/data/logs/assistant-2026-10-09.log");
    await fs.appendFile(logPath, "2026-10-09T13:00:00.000Z INFO bugged line vellum://workspace/data/attachments/late.txt\n");
    const configPath = path.join(cadetRoot, "workspace/config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ services: { stt: { provider: "vellum" } } }, null, 2),
    );
    const soulPath = path.join(cadetRoot, "workspace/SOUL.md");
    await fs.appendFile(soulPath, "Bugged addendum: comes with the Vellum harness again.\n");
    const db = new Database(path.join(cadetRoot, "workspace/data/db/assistant.db"));
    db.exec(
      `INSERT INTO messages VALUES ('m9', 'c1', 'assistant', 'bugged reply', 9,
       '{"channel":"vellum"}', 'vellum', 'vellum')`,
    );
    db.close();

    let cadetSleeps = 0;
    let vellumSleeps = 0;
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const report = await repair({
        processOps: {
          async vellumVersion() {
            return null;
          },
          async find() {
            return [];
          },
          async vellumSleep() {
            vellumSleeps++;
          },
          async cadetSleep() {
            cadetSleeps++;
          },
        },
        termGraceMs: 0,
      });

      expect(report.mode).toBe("repair");
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(0);
      expect(vellumSleeps).toBe(0); // repair never touches the vellum CLI
      // The sleep runs unconditionally — pgrep can't be trusted to gate it.
      expect(cadetSleeps).toBe(1);
      const stop = report.steps.find((s) => s.step === "stop-cadet");
      expect(stop?.status).toBe("completed");
      // The root was self-discovered via its manifest, not passed in.
      const discovery = report.steps.find((s) => s.step === "discover-cadet-roots");
      expect(discovery?.status).toBe("completed");
      expect(discovery?.summary).toContain(cadetRoot);
      expect(report.detect.cadetRoot).toBe(cadetRoot);

      const log = await fs.readFile(logPath, "utf8");
      expect(log).toContain("cadet://workspace/data/attachments/late.txt");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(config.services.stt.provider).toBe("cadet");
      const soul = await fs.readFile(soulPath, "utf8");
      expect(soul).toContain("comes with the Cadet harness again.");
      const checked = new Database(path.join(cadetRoot, "workspace/data/db/assistant.db"), {
        readOnly: true,
      });
      const leftover = checked
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE user_message_channel = 'vellum'")
        .all();
      expect(leftover).toEqual([{ n: 0 }]);

      // A timestamped backup of the cadet root itself, beside it.
      expect(report.backupPath).toContain(".cadet-migration-backups");
      expect(report.backupPath!.startsWith(home)).toBe(true);

      // Second repair: everything already clean → still ok, no rewrites.
      const second = await repair({ processOps: noopOps, termGraceMs: 0 });
      expect(second.ok).toBe(true);
      const rewrite = second.steps.find((s) => s.step === "rewrite-content");
      expect(rewrite?.summary).toContain("already matches its sanctioned transform");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("repairs every discovered root, not just one", async () => {
    const { root, home } = await buildFullVellum0126();
    const first = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });
    expect(first.ok).toBe(true);
    // A second migrated root: the modern XDG instance layout.
    const secondRoot = path.join(home, ".local/share/cadet/assistants/velly");
    const second = await migrate({
      vellumRoot: root,
      cadetRoot: secondRoot,
      processOps: noopOps,
    });
    expect(second.ok).toBe(true);

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const report = await repair({ processOps: noopOps, termGraceMs: 0 });
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(0);
      const discovery = report.steps.find((s) => s.step === "discover-cadet-roots");
      expect(discovery?.summary).toContain("2 migrated cadet root(s)");
      // Every value step ran once per root.
      expect(report.steps.filter((s) => s.step === "backup")).toHaveLength(2);
      expect(report.steps.filter((s) => s.step === "rewrite-content")).toHaveLength(2);
      expect(report.steps.filter((s) => s.step === "verify")).toHaveLength(2);
      expect(report.steps.filter((s) => s.step === "verify").every((s) => s.status === "completed")).toBe(true);
      // Backups are per-root and distinct (sibling instances share an anchor).
      expect(new Set(report.steps.filter((s) => s.step === "backup").map((s) => s.summary)).size).toBe(2);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("dry run reports pending work, touches nothing, stops nothing", async () => {
    const { root, home } = await buildFullVellum0126();
    const migrateReport = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });
    expect(migrateReport.ok).toBe(true);
    const cadetRoot = path.join(home, ".cadet");

    const logPath = path.join(cadetRoot, "workspace/data/logs/assistant-2026-10-09.log");
    await fs.appendFile(logPath, "2026-10-09T14:00:00.000Z INFO pending vellum://workspace/data/attachments/x.txt\n");

    let cadetSleeps = 0;
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const report = await repair({
        dryRun: true,
        processOps: {
          async vellumVersion() {
            return null;
          },
          async find() {
            return [];
          },
          async vellumSleep() {},
          async cadetSleep() {
            cadetSleeps++;
          },
        },
      });

      expect(report.mode).toBe("repair");
      expect(report.ok).toBe(true);
      expect(report.steps.find((s) => s.step === "repair-plan")?.status).toBe("planned");
      expect(report.steps.find((s) => s.step === "stop-cadet")).toBeUndefined();
      expect(cadetSleeps).toBe(0);
      expect(await fs.readFile(logPath, "utf8")).toContain("vellum://workspace/data/attachments/x.txt");
      expect(report.backupPath).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("finds nothing to repair when no root was migrated by this tool", async () => {
    const { home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const bare = path.join(home, ".cadet-not-ours");
      await fs.mkdir(bare, { recursive: true });

      const report = await repair({ processOps: noopOps });
      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(2);
      expect(report.steps.find((s) => s.step === "discover-cadet-roots")?.status).toBe("failed");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("stop-assistant: vellum lockfile iteration", () => {
  test("sleeps every lockfile-tracked assistant by id — no bare sleep", async () => {
    const { home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            { assistantId: "velly", cloud: "local" },
            { assistantId: "velly-2", cloud: "local" },
          ],
        }),
      );
      const slept: Array<string | undefined> = [];
      const result = await stopAssistant(
        {
          async vellumVersion() {
            return null;
          },
          async find() {
            return [];
          },
          async vellumSleep(assistant) {
            slept.push(assistant);
          },
          async cadetSleep() {},
        },
        false,
        0,
      );
      expect(slept).toEqual(["velly", "velly-2"]);
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("2 lockfile-tracked assistant(s)");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("falls back to one bare sleep when the lockfile is absent", async () => {
    const { home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const slept: Array<string | undefined> = [];
      const result = await stopAssistant(
        {
          async vellumVersion() {
            return null;
          },
          async find() {
            return [];
          },
          async vellumSleep(assistant) {
            slept.push(assistant);
          },
          async cadetSleep() {},
        },
        false,
        0,
      );
      expect(slept).toEqual([undefined]);
      expect(result.status).toBe("completed");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("e2e: retired archives", () => {
  const run = promisify(execFileCb);

  test("retired archives are untarred, migrated, and re-tarred; a corrupt one only warns", async () => {
    const { root, home } = await buildFullVellum0126();
    const retiredDir = path.join(root, "retired");
    await fs.mkdir(retiredDir, { recursive: true });

    // ── Archive 1: a finished retire — a tar of a workspace tree with the
    //    same branded shapes as the live tree (logs, config, a db).
    const staging1 = path.join(retiredDir, "grand-assistant.staging");
    await fs.mkdir(path.join(staging1, "workspace", "data", "db"), { recursive: true });
    await fs.mkdir(path.join(staging1, "workspace", "data", "logs"), { recursive: true });
    await fs.writeFile(
      path.join(staging1, "workspace", "data", "logs", "2026-01-01.log"),
      "session start; attachment vellum://a.png; root /Users/x/.local/share/vellum\n",
    );
    await fs.writeFile(
      path.join(staging1, "workspace", "config.json"),
      JSON.stringify({ services: { stt: { provider: "vellum" } } }, null, 2),
    );
    const db = new Database(path.join(staging1, "workspace", "data", "db", "assistant.db"));
    db.exec("CREATE TABLE conversations (id INTEGER PRIMARY KEY, origin_channel TEXT)");
    db.exec("INSERT INTO conversations (origin_channel) VALUES ('vellum')");
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)");
    db.exec("INSERT INTO messages (content) VALUES ('see vellum://a.png')");
    db.close();
    await run("tar", ["-czf", path.join(retiredDir, "grand-assistant.tar.gz"), "-C", staging1, "."]);
    await fs.rm(staging1, { recursive: true, force: true });

    // ── Archive 2: an interrupted retire — a staging tree, never tarred.
    const staging2 = path.join(retiredDir, "interrupted.tar.gz.staging");
    await fs.mkdir(path.join(staging2, "workspace", "data", "logs"), { recursive: true });
    await fs.writeFile(path.join(staging2, "workspace", "data", "logs", "day.log"), "vellum://x\n");

    // ── Archive 3: a corrupt tar — must warn and never fail the run.
    await fs.writeFile(path.join(retiredDir, "broken.tar.gz"), Buffer.from("not a tar at all"));

    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet", "assistants", "vellum");

    const report = await migrate({ vellumRoot: root, cadetRoot, processOps: noopOps });
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);

    const retired = report.steps.find((s) => s.step === "migrate-retired");
    expect(retired?.status).toBe("completed");

    // Finished archive: re-tarred with migrated content inside.
    const extracted = path.join(retiredDir, "check-grand");
    await fs.mkdir(extracted, { recursive: true });
    await run("tar", ["-xzf", path.join(cadetRoot, "retired", "grand-assistant.tar.gz"), "-C", extracted]);
    const log = await fs.readFile(path.join(extracted, "workspace/data/logs/2026-01-01.log"), "utf8");
    expect(log).toContain("cadet://");
    expect(log).not.toContain("vellum://");
    const config = await fs.readFile(path.join(extracted, "workspace/config.json"), "utf8");
    expect(config).not.toContain('"vellum"');
    const migratedDb = new Database(path.join(extracted, "workspace/data/db/assistant.db"));
    const channel = migratedDb.prepare("SELECT origin_channel FROM conversations").get() as {
      origin_channel: string;
    };
    expect(channel.origin_channel).toBe("cadet");
    const link = migratedDb.prepare("SELECT content FROM messages").get() as { content: string };
    expect(link.content).toContain("cadet://");
    migratedDb.close();

    // Interrupted retire: completed into a tar, staging consumed.
    expect(await exists(path.join(cadetRoot, "retired", "interrupted.tar.gz"))).toBe(true);
    expect(await exists(path.join(cadetRoot, "retired", "interrupted.tar.gz.staging"))).toBe(false);

    // Corrupt archive: byte-identical, warned, run still ok.
    expect((await fs.readFile(path.join(cadetRoot, "retired", "broken.tar.gz"))).toString()).toBe(
      "not a tar at all",
    );
    const broken = (retired?.issues ?? []).filter((i) => i.message.includes("'broken'"));
    expect(broken.length).toBe(1);
    expect(broken[0]?.severity).toBe("warning");

    // No staging litter left behind anywhere.
    const litter = (await fs.readdir(path.join(cadetRoot, "retired"))).filter((n) =>
      n.endsWith(".staging"),
    );
    expect(litter.length).toBe(0);
  });

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }
});

