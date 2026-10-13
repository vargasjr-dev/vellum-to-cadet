import { DatabaseSync as Database } from "node:sqlite";
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { after, describe, test } from "node:test";

import { migrate, repair } from "../../src/runner.js";
import { migrateAssistantDbAt } from "../../src/steps/migrate-assistant-db.js";
import { stopAssistant } from "../../src/steps/stop-assistant.js";
import { EXIT_CODES } from "../../src/types.js";
import type { ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import {
  buildFullVellum0126,
  buildMinimal,
  buildModernVellum,
  cleanupFixtures,
  writeAssistantState,
} from "../helpers/build-fixture.js";

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
  async installCadet() {},
  async cadetWakeAll() {},
  async cadetVersion() {
    return { version: null };
  },
  async dockerVolumeToDir() {},
  async dockerDirToVolume() {},
  async dockerAvailable() {
    return false;
  },
  async cadetLogin() {},
  async cadetBinAvailable() {
    return true;
  },
  async npmGlobalRoot() {
    return null;
  },
};

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

after(cleanupFixtures);

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

    // ── Output-contract pins from the v0.0.8 run feedback. ──
    // The root-level version is per-assistant in practice — never "unknown":
    // the clause is omitted unless a version was actually determined.
    const detectStep = report.steps.find((s) => s.step === "detect");
    expect(detectStep?.summary).not.toContain("version unknown");
    // The root line carries NO install-kind suffix — the deployment kind
    // rides the per-assistant branch lines as a "(docker)" tag instead
    // (v0.0.11 run feedback: the suffix crowded the root line).
    expect(detectStep?.summary.split("\n")[0]).toContain("vellum root at ");
    expect(detectStep?.summary).not.toContain("install");
    // No backup step: the vellum root is never mutated, so the original IS
    // the backup — copying it would only double the disk bill.
    expect(report.steps.some((s) => s.step === "backup")).toBe(false);
    expect(report.backupPath).toBe(null);
    // The run reports its own wall-clock duration.
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    // Post-migration setup: the fixture has no lockfile, so both skip.
    const install = report.steps.find((s) => s.step === "install-cadet");
    expect(install?.status).toBe("skipped");
    expect(install?.summary).toContain("no lockfile-tracked assistant(s)");
    const wake = report.steps.find((s) => s.step === "wake-assistants");
    expect(wake?.status).toBe("skipped");

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

    // ── No backup copy was made; the source root IS the record. ──
    expect(
      await exists(path.join(path.dirname(cadetRoot), ".cadet-migration-backups")),
    ).toBe(false);
    // Source root still intact — it is a read-only source of truth, always.
    expect(await exists(path.join(root, "workspace/notes/README.md"))).toBe(true);

    // ── Migration manifest is the audit trail + idempotency marker. ──
    const migManifest = JSON.parse(
      await fs.readFile(path.join(cadetRoot, ".cadet-migration-manifest.json"), "utf8"),
    );
    expect(migManifest.vellumVersion).toBe("0.12.6");
    expect(migManifest.files.length).toBeGreaterThan(0);
  });

  test("no backup copy is made — the migration only ever reads the vellum root", async () => {
    const { root, home } = await buildFullVellum0126();
    const report = await migrate({
      vellumRoot: root,
      cadetRoot: path.join(home, ".cadet"),
      processOps: noopOps,
    });

    expect(report.ok).toBe(true);
    // No .cadet-migration-backups anywhere: not beside the cadet root, not
    // in the home dir. The untouched vellum root is the safety net.
    expect(await exists(path.join(home, ".cadet", ".cadet-migration-backups"))).toBe(false);
    expect(await exists(path.join(home, ".cadet-migration-backups"))).toBe(false);
    // Every source file still hashes to its pre-migration value.
    const before = await fs.readFile(path.join(root, "workspace/notes/vellum-history.md"));
    expect(sha(before)).toBeTruthy();
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

    // No backup copy exists anywhere — the untouched root is the record.
    expect(report.backupPath).toBe(null);
    expect(await exists(path.join(home, ".cadet-migration-backups"))).toBe(false);
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
      async installCadet() {},
      async cadetWakeAll() {},
      async cadetVersion() {
        return { version: null };
      },
      async dockerVolumeToDir() {},
      async dockerDirToVolume() {},
      async dockerAvailable() {
        return false;
      },
  async cadetLogin() {},
      async cadetBinAvailable() {
        return true;
      },
      async npmGlobalRoot() {
        return null;
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
      async installCadet() {},
      async cadetWakeAll() {},
      async cadetVersion() {
        return { version: null };
      },
      async dockerVolumeToDir() {},
      async dockerDirToVolume() {},
      async dockerAvailable() {
        return false;
      },
  async cadetLogin() {},
      async cadetBinAvailable() {
        return true;
      },
      async npmGlobalRoot() {
        return null;
      },
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
    // The phase that COULD run (attachment links) still ran — as the
    // per-table info bullet under the step line.
    expect(result.issues ?? []).toEqual([{ severity: "info", message: "assistant.db - messages.attachment links: 1 row(s)" }]);
    expect(result.summary).not.toContain("no such column");
    expect(result.summary).toContain("assistant db — 1 row(s)");
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

      // The detect summary: one root line, then one item-style bullet per
      // migrating assistant — docker ones tagged (docker) (v0.0.11 run
      // feedback; v0.0.13 swapped the tree glyphs for the renderer's
      // bullet notation).
      const detectStep = report.steps.find((s) => s.step === "detect");
      expect(detectStep?.summary.split("\n")[0]).toContain("vellum root at ");
      expect(detectStep?.summary).toContain(`    · migrating assistant velly (docker)`);
      expect(detectStep?.summary).not.toContain("docker instance");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("a vellum-prefixed docker instance names the migrated install after its own name", async () => {
    const { root, home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const prevXdgData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    try {
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: "vellum-prime-quail-3ezfs4",
              cloud: "docker",
              containerInfo: { assistantImage: "vellumai/vellum-assistant" },
            },
          ],
        }),
      );
      const report = await migrate({ vellumRoot: root, processOps: noopOps });

      expect(report.ok).toBe(true);
      // v0.0.10 run feedback: the docker assistant's install landed at
      // assistants/vellum — the generic legacy name — instead of its own.
      expect(report.detect.cadetRoot).toBe(
        path.join(home, ".local", "share", "cadet", "assistants", "prime-quail-3ezfs4"),
      );
      expect(report.detect.assistantHandles).toContain("vellum-prime-quail-3ezfs4");
      const detectStep = report.steps.find((s) => s.step === "detect");
      expect(detectStep?.summary).toContain("migrating assistant prime-quail-3ezfs4");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgData;
    }
  });

  test("a docker-only install migrates from its config-dir root — the guardian token lands where cadet reads it", async () => {
    const prevHome = process.env.HOME;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-docker-only-"));
    process.env.HOME = home;
    // Sandboxed like the lockfile tests: GH runners preset XDG_CONFIG_HOME.
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    try {
      // Field QA: a modern install whose ONLY assistant is docker-backed
      // never creates ~/.local/share/vellum — the config dir is the entire
      // on-disk vellum state.
      const configRoot = path.join(home, ".config", "vellum");
      const assistantDir = path.join(configRoot, "assistants", "vellum-eager-otter-kdqnjj");
      await fs.mkdir(assistantDir, { recursive: true });
      await fs.writeFile(path.join(assistantDir, "guardian-token.json"), JSON.stringify({ accessToken: "tok-1" }));
      await fs.writeFile(path.join(configRoot, "client-id"), "client-123");
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: "vellum-eager-otter-kdqnjj",
              name: "vellum-eager-otter-kdqnjj",
              cloud: "docker",
              containerInfo: { assistantImage: "vellumai/vellum-assistant" },
            },
          ],
        }),
      );

      const report = await migrate({ vellumRoot: configRoot, processOps: noopOps });

      expect(report.ok).toBe(true);
      // The config root migrates root-to-root: cadet's own config dir is
      // exactly where the cadet CLI reads its lockfile and guardian token.
      expect(report.detect.cadetRoot).toBe(path.join(home, ".config", "cadet"));
      const tokenDest = path.join(
        home,
        ".config",
        "cadet",
        "assistants",
        "eager-otter-kdqnjj",
        "guardian-token.json",
      );
      expect(await fs.readFile(tokenDest, "utf8")).toContain("tok-1");
      const lockfileRaw = await fs.readFile(
        path.join(home, ".config", "cadet", "lockfile.json"),
        "utf8",
      );
      expect(lockfileRaw).toContain("eager-otter-kdqnjj");

      // The image-refs warning (noopOps resolves no cadet version) now says
      // WHY instead of a bare "unavailable".
      const lockfileStep = report.steps.find((s) => s.step === "migrate-lockfile");
      const warning = lockfileStep?.issues?.find((i) => i.severity === "warning");
      expect(warning?.message).toContain("`cadet --version` printed no parsable version");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    }
  });

  test("a docker volume transfer failure aborts the run as failed — no green completion, scratch discarded", async () => {
    const { root, home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: "vellum-prime-quail-3ezfs4",
              cloud: "docker",
              containerInfo: { assistantImage: "vellumai/vellum-assistant" },
            },
          ],
        }),
      );
      // The preflight guard passes (the daemon reports room, the volumes
      // measure small), then the transfer itself dies — the v0.0.13 run's
      // disk-full mid-extract, replayed.
      const scratchBefore = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("vtc-volumes-"));
      const report = await migrate({
        vellumRoot: root,
        processOps: noopOps,
        dockerOps: {
          ...noopOps,
          dockerAvailable: async () => true,
          dockerDiskFree: async () => 500 * 1024 ** 3,
          dockerVolumeSize: async () => 1024 ** 3, // 3 volumes × 1GB — fits everywhere
          dockerVolumeToDir: async () => {
            throw new Error("extract vellum-prime-quail-3ezfs4-workspace: exited 125 — no space left on device");
          },
          dockerDirToVolume: async () => {},
        },
      });

      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(EXIT_CODES.migrationFailed);
      // The run ended AT the fetch — no value steps over the partial tree,
      // no load, no verify.
      const stepNames = report.steps.map((s) => s.step);
      expect(stepNames).toContain("fetch-docker-volumes");
      expect(stepNames).not.toContain("migrate-assistant-db");
      expect(stepNames).not.toContain("load-docker-volumes");
      const fetchStep = report.steps.find((s) => s.step === "fetch-docker-volumes");
      expect(fetchStep?.status).toBe("failed");
      // The scratch tree was discarded.
      const scratchAfter = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("vtc-volumes-"));
      expect(scratchAfter.length).toBe(scratchBefore.length);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("a docker re-run sleeps the assistants BEFORE re-fetching the volumes (v0.0.15 field run)", async () => {
    const { root, home } = await buildFullVellum0126();
    const prevHome = process.env.HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    try {
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: "vellum-prime-quail-3ezfs4",
              cloud: "docker",
              containerInfo: { assistantImage: "vellumai/vellum-assistant" },
            },
          ],
        }),
      );
      const dockerOps = {
        ...noopOps,
        dockerAvailable: async () => true,
        dockerDiskFree: async () => 500 * 1024 ** 3,
        dockerVolumeSize: async () => 1024 ** 3,
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
      };
      const first = await migrate({ vellumRoot: root, processOps: noopOps, dockerOps });
      expect(first.ok).toBe(true);

      // The re-run heals the volumes — and it cannot assume run 1 left
      // the assistant asleep (it may have been woken between runs; a
      // re-run IS the "the migrator got better since my last test"
      // path). A live writer during fetch/load is an inconsistent
      // snapshot, so the re-run must sleep FIRST, exactly like the
      // fresh flow.
      let sleeps = 0;
      const second = await migrate({
        vellumRoot: root,
        processOps: {
          ...noopOps,
          vellumSleep: async () => {
            sleeps++;
          },
        },
        dockerOps,
      });
      expect(second.ok).toBe(true);
      expect(second.mode).toBe("verify-only");
      expect(sleeps).toBe(1);
      console.error("DEBUG", JSON.stringify({
        mode: second.mode,
        steps: second.steps.map((s) => ({ step: s.step, status: s.status })),
        cadetRoot: (second as unknown as { detect?: { cadetRoot?: string } }).detect?.cadetRoot,
      }, null, 1));
      const stepNames = second.steps.map((s) => s.step);
      expect(stepNames.indexOf("stop-assistant")).toBeGreaterThan(-1);
      expect(stepNames.indexOf("fetch-docker-volumes")).toBeGreaterThan(stepNames.indexOf("stop-assistant"));
      const stop = second.steps.find((s) => s.step === "stop-assistant");
      expect(stop?.status).toBe("completed");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgData;
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
    // The instance is named after the handle — recorded legacy-root paths
    // must agree with the directory the data actually landed in.
    expect(env).toContain("CADET_DATA_DIR=~/.local/share/cadet/assistants/velly");
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
      expect(lockStep?.summary).toContain("left in place");
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
          async installCadet() {},
          async cadetWakeAll() {},
          async cadetVersion() {
            return { version: null };
          },
          async dockerVolumeToDir() {},
          async dockerDirToVolume() {},
          async dockerAvailable() {
            return false;
          },
  async cadetLogin() {},
          async cadetBinAvailable() {
            return true;
          },
          async npmGlobalRoot() {
            return null;
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
          async installCadet() {},
          async cadetWakeAll() {},
          async cadetVersion() {
            return { version: null };
          },
          async dockerVolumeToDir() {},
          async dockerDirToVolume() {},
          async dockerAvailable() {
            return false;
          },
  async cadetLogin() {},
          async cadetBinAvailable() {
            return true;
          },
          async npmGlobalRoot() {
            return null;
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
          async installCadet() {},
          async cadetWakeAll() {},
          async cadetVersion() {
            return { version: null };
          },
          async dockerVolumeToDir() {},
          async dockerDirToVolume() {},
          async dockerAvailable() {
            return false;
          },
  async cadetLogin() {},
          async cadetBinAvailable() {
            return true;
          },
          async npmGlobalRoot() {
            return null;
          },
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
          async installCadet() {},
          async cadetWakeAll() {},
          async cadetVersion() {
            return { version: null };
          },
          async dockerVolumeToDir() {},
          async dockerDirToVolume() {},
          async dockerAvailable() {
            return false;
          },
  async cadetLogin() {},
          async cadetBinAvailable() {
            return true;
          },
          async npmGlobalRoot() {
            return null;
          },
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
    const scratch1 = path.join(retiredDir, "grand-assistant.staging");
    await fs.mkdir(path.join(scratch1, "workspace", "data", "db"), { recursive: true });
    await fs.mkdir(path.join(scratch1, "workspace", "data", "logs"), { recursive: true });
    await fs.writeFile(
      path.join(scratch1, "workspace", "data", "logs", "2026-01-01.log"),
      "session start; attachment vellum://a.png; root /Users/x/.local/share/vellum\n",
    );
    await fs.writeFile(
      path.join(scratch1, "workspace", "config.json"),
      JSON.stringify({ services: { stt: { provider: "vellum" } } }, null, 2),
    );
    const db = new Database(path.join(scratch1, "workspace", "data", "db", "assistant.db"));
    db.exec("CREATE TABLE conversations (id INTEGER PRIMARY KEY, origin_channel TEXT)");
    db.exec("INSERT INTO conversations (origin_channel) VALUES ('vellum')");
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)");
    db.exec("INSERT INTO messages (content) VALUES ('see vellum://a.png')");
    db.close();
    await run("tar", ["-czf", path.join(retiredDir, "grand-assistant.tar.gz"), "-C", scratch1, "."]);
    await fs.rm(scratch1, { recursive: true, force: true });

    // ── Archive 2: an interrupted retire — a .tmp scratch tree, never tarred.
    const staging2 = path.join(retiredDir, "interrupted.tar.gz.tmp");
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
    // No "(optional by design…)" parenthetical — the ⚠ bullets say it all.
    expect(retired?.summary).toBe(
      "retired archives: 2 migrated, 1 left as-is; retired manifests: nothing stale found",
    );

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

    // Interrupted retire: completed into a tar, .tmp scratch consumed.
    expect(await exists(path.join(cadetRoot, "retired", "interrupted.tar.gz"))).toBe(true);
    expect(await exists(path.join(cadetRoot, "retired", "interrupted.tar.gz.tmp"))).toBe(false);

    // Corrupt archive: byte-identical, warned, run still ok.
    expect((await fs.readFile(path.join(cadetRoot, "retired", "broken.tar.gz"))).toString()).toBe(
      "not a tar at all",
    );
    const broken = (retired?.issues ?? []).filter((i) => i.message.includes("'broken'"));
    expect(broken.length).toBe(1);
    expect(broken[0]?.severity).toBe("warning");

    // No scratch litter left behind anywhere.
    const litter = (await fs.readdir(path.join(cadetRoot, "retired"))).filter((n) =>
      n.endsWith(".tar.gz.tmp"),
    );
    expect(litter.length).toBe(0);
  });

  test("EVERY assistant workspace's dbs get value-rewritten (multi-workspace root)", async () => {
    // v0.0.9 run feedback: a real root hosts one state tree PER assistant;
    // the runner rewrote only the first copy-plan match, so the second
    // workspace's contact_channels stayed branded and verify flagged it.
    const { root, home } = await buildModernVellum(undefined, "vellum", "alpha");
    await writeAssistantState(path.join(root, "assistants", "beta", ".vellum"));
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const cadetRoot = path.join(home, ".local", "share", "cadet");

    const report = await migrate({ vellumRoot: root, cadetRoot, processOps: noopOps });
    expect(report.ok).toBe(true);

    const dbStep = report.steps.find((s) => s.step === "migrate-assistant-db");
    expect(dbStep?.status).toBe("completed");
    expect(dbStep?.summary).toContain("across 2 db(s)");
    const gwStep = report.steps.find((s) => s.step === "migrate-gateway-db");
    expect(gwStep?.status).toBe("completed");
    expect(gwStep?.summary).toContain("across 2 db(s)");

    // Walk the migrated tree: EVERY assistant db and gateway db must be clean.
    const dbs: string[] = [];
    async function collect(dir: string): Promise<void> {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await collect(p);
        else if (e.name === "assistant.db" || e.name === "gateway.sqlite") dbs.push(p);
      }
    }
    await collect(cadetRoot);
    expect(dbs.length).toBe(4); // 2 workspaces × (assistant db + gateway db)
    for (const dbPath of dbs) {
      const db = new Database(dbPath, { readOnly: true });
      try {
        const hasTable = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_channels'`)
          .get();
        if (hasTable) {
          const rows = db.prepare(`SELECT COUNT(*) AS c FROM contact_channels WHERE type = 'vellum'`).get() as {
            c: number;
          };
          expect(rows.c).toBe(0);
        }
      } finally {
        db.close();
      }
    }

    // Verify raised no leftover-data warnings at all.
    const verifyStep = report.steps.find((s) => s.step === "verify");
    expect((verifyStep?.issues ?? []).filter((issue) => issue.severity !== "info")).toEqual([]);
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


// ── Run-feedback batch 3: the cadet lockfile conversion, instance-name
//    prefix strips, retired-manifest cleaning, and the legacy-credential
//    removal — everything the v0.0.9 run feedback flagged. ──

describe("e2e: cadet lockfile conversion + legacy credentials", () => {
  test("writes the cadet lockfile, renames the instance dir, scrubs the encrypted store, logs in", async () => {
    const { root, home } = await buildModernVellum(undefined, "vellum", "vellum-grand-ram");
    const state = path.join(root, "assistants", "vellum-grand-ram", ".vellum");
    const prevHome = process.env.HOME;
    const prevXdgDataHome = process.env.XDG_DATA_HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    let logins = 0;
    const ops: ProcessOps = {
      ...noopOps,
      async cadetLogin() {
        logins++;
      },
      async cadetVersion() {
        return { version: "0.12.7" };
      },
    };
    try {
      // The vellum lockfile: home-level, vellum-branded, cloud-registered —
      // plus the vellum-runtime root bookkeeping the conversion must drop
      // (v0.0.10 run feedback: it all rode into the cadet lockfile) — and
      // a docker entry whose containerInfo must repoint at cadet's images.
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify(
          {
            assistants: [
              {
                assistantId: "vellum-grand-ram",
                name: "vellum-grand-ram",
                cloud: "local",
                runtimeUrl: "http://MacBook-Pro-8.local:7830",
                species: "cinderling",
                hatchedAt: "2026-09-01T10:00:00.000Z",
                baseDataDir: String(root),
                organizationId: "org_vellum_1",
                platformAssistantId: "pa_vellum_1",
                platformBaseUrl: "https://platform.vellum.ai",
                platformOrganizationId: "org_vellum_2",
                resources: {
                  instanceDir: path.join(root, "assistants", "vellum-grand-ram"),
                  gatewayPort: 7830,
                  daemonPort: 7821,
                },
                signingKey: "signing-key-material",
              },
              {
                assistantId: "vellum-prime-quail-3ezfs4",
                name: "vellum-prime-quail-3ezfs4",
                cloud: "docker",
                containerInfo: {
                  assistantImage: "us-central1-docker.pkg.dev/vellum-ai-prod/sandbox-images/assistant-server@sha256:c737",
                  gatewayImage: "us-central1-docker.pkg.dev/vellum-ai-prod/sandbox-images/gateway@sha256:beef",
                  cesImage: "us-central1-docker.pkg.dev/vellum-ai-prod/sandbox-images/ces@sha256:dead",
                  assistantDigest: "sha256:aaa",
                  gatewayDigest: "sha256:bbb",
                  cesDigest: "sha256:ccc",
                  networkName: "vellum-prime-quail-3ezfs4-net",
                  assistantPort: 7821,
                },
              },
            ],
            activeAssistant: "vellum-grand-ram",
            serviceGroupVersion: "0.12.6",
            previousServiceGroupVersion: "0.12.5",
            previousContainerInfo: { assistantImage: "old" },
            version: "0.12.6",
            previousDbMigrationVersion: 119,
            previousWorkspaceMigrationId: "ws-1",
          },
          null,
          2,
        ),
      );

      // The encrypted credential store: vellum cloud entries + a BYOK key.
      await fs.mkdir(path.join(state, "protected"), { recursive: true });
      await fs.writeFile(
        path.join(state, "protected", "keys.enc"),
        JSON.stringify(
          {
            version: 2,
            entries: {
              "credential/vellum/assistant_api_key": { iv: "aa", tag: "bb", data: "cc" },
              "credential/vellum/webhook_secret": { iv: "dd", tag: "ee", data: "ff" },
              "credential/anthropic/api_key": { iv: "11", tag: "22", data: "33" },
            },
          },
          null,
          2,
        ),
      );

      const report = await migrate({ vellumRoot: root, processOps: ops });
      expect(report.ok).toBe(true);

      const cadetRoot = path.join(home, ".local", "share", "cadet");

      // ── The cadet lockfile: written to the canonical config-dir path the
      //    cadet CLI reads, entries fully transformed. ──
      const lockStep = report.steps.find((s) => s.step === "migrate-lockfile");
      expect(lockStep?.summary).toContain(path.join(home, ".config", "cadet", "lockfile.json"));
      const lockRaw = JSON.parse(
        await fs.readFile(path.join(home, ".config", "cadet", "lockfile.json"), "utf8"),
      );
      const entry = lockRaw.assistants[0];
      expect(entry.assistantId).toBe("grand-ram");
      expect(entry.name).toBe("grand-ram");
      expect("species" in entry).toBe(false);
      expect(entry.runtimeUrl).toBe("http://127.0.0.1:7830");
      expect(entry.resources.instanceDir).toBe(path.join(cadetRoot, "assistants", "grand-ram"));
      expect(entry.baseDataDir).toBe(path.join(cadetRoot, "assistants", "grand-ram"));
      expect("organizationId" in entry).toBe(false);
      expect("platformAssistantId" in entry).toBe(false);
      expect("platformBaseUrl" in entry).toBe(false);
      expect("platformOrganizationId" in entry).toBe(false);
      // Unknown/sensitive fields ride through untouched.
      expect(entry.signingKey).toBe("signing-key-material");
      expect(lockRaw.activeAssistant).toBe("grand-ram");

      // The vellum-runtime root bookkeeping never rides into the cadet
      // lockfile — cadet's own upgrade machinery writes its own (v0.0.10
      // run feedback: it all rode through).
      for (const field of [
        "serviceGroupVersion",
        "previousServiceGroupVersion",
        "previousContainerInfo",
        "version",
        "previousDbMigrationVersion",
        "previousWorkspaceMigrationId",
      ]) {
        expect(field in lockRaw).toBe(false);
      }

      // The docker entry: images repointed at cadet's (derived from the
      // installed cadet's version), digest/network bookkeeping dropped.
      const dockerEntry = lockRaw.assistants.find(
        (a: { assistantId: string }) => a.assistantId === "prime-quail-3ezfs4",
      );
      expect(dockerEntry).toBeDefined();
      const info = dockerEntry.containerInfo;
      expect(info.assistantImage).toBe("mycadet/mycadet-assistant:v0.12.7");
      expect(info.gatewayImage).toBe("mycadet/mycadet-gateway:v0.12.7");
      expect(info.cesImage).toBe("mycadet/mycadet-credential-executor:v0.12.7");
      expect("assistantDigest" in info).toBe(false);
      expect("gatewayDigest" in info).toBe(false);
      expect("cesDigest" in info).toBe(false);
      expect("networkName" in info).toBe(false);
      expect(info.assistantPort).toBe(7821);

      // ── The instance dir: renamed out of the brand prefix. ──
      expect(await exists(path.join(cadetRoot, "assistants", "grand-ram"))).toBe(true);
      expect(await exists(path.join(cadetRoot, "assistants", "vellum-grand-ram"))).toBe(false);

      // ── The encrypted store: vellum entries gone, the BYOK key kept. ──
      const storeRaw = JSON.parse(
        await fs.readFile(
          path.join(cadetRoot, "assistants", "grand-ram", "ces-security", "keys.enc"),
          "utf8",
        ),
      );
      expect(Object.keys(storeRaw.entries)).toEqual(["credential/anthropic/api_key"]);
      const credStep = report.steps.find((s) => s.step === "migrate-credentials");
      expect(credStep?.data?.["detected"]).toBe(true);
      expect(credStep?.data?.["entriesRemoved"]).toBe(2);

      // ── The login step: detection fired → the login ran. ──
      expect(logins).toBe(1);
      const loginStep = report.steps.find((s) => s.step === "cadet-login");
      expect(loginStep?.status).toBe("completed");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgDataHome;
      if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
  });

  test("no legacy credentials detected → cadet-login skips", async () => {
    const { root, home } = await buildMinimal();
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const prevHome = process.env.HOME;
    const prevXdgDataHome = process.env.XDG_DATA_HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    let logins = 0;
    const ops: ProcessOps = {
      ...noopOps,
      async cadetLogin() {
        logins++;
      },
    };
    try {
      // A lockfile with NO vellum cloud identity and no encrypted store.
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify(
          {
            assistants: [
              {
                assistantId: "velly",
                cloud: "local",
                resources: {
                  instanceDir: path.join(root),
                  gatewayPort: 7830,
                  daemonPort: 7821,
                },
              },
            ],
            activeAssistant: "velly",
          },
          null,
          2,
        ),
      );
      const report = await migrate({ vellumRoot: root, processOps: ops });
      expect(report.ok).toBe(true);
      const credStep = report.steps.find((s) => s.step === "migrate-credentials");
      expect(credStep?.status).toBe("skipped");
      const loginStep = report.steps.find((s) => s.step === "cadet-login");
      expect(loginStep?.status).toBe("skipped");
      expect(logins).toBe(0);
      // The lockfile conversion still ran — the assistant rides along.
      const lockRaw = JSON.parse(
        await fs.readFile(path.join(home, ".config", "cadet", "lockfile.json"), "utf8"),
      );
      expect(lockRaw.assistants[0].assistantId).toBe("velly");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgDataHome;
      if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
  });

  test("cleans the retired manifests and drops the vellum- prefix from retired file names", async () => {
    const { root, home } = await buildModernVellum(undefined, "vellum", "vellum-grand-ram");
    const retiredDir = path.join(root, "retired");
    await fs.mkdir(retiredDir, { recursive: true });

    // A retired manifest, exactly as vellum's retire wrote it: the full
    // entry, stale values included.
    await fs.writeFile(
      path.join(retiredDir, "vellum-old-duck.json"),
      JSON.stringify(
        {
          assistantId: "vellum-old-duck",
          name: "vellum-old-duck",
          cloud: "local",
          runtimeUrl: "http://MacBook-Pro-8.local:7830",
          species: "cinderling",
          baseDataDir: String(root),
          resources: {
            instanceDir: path.join(root, "assistants", "vellum-old-duck"),
            gatewayPort: 7830,
            daemonPort: 7821,
          },
        },
        null,
        2,
      ) + "\n",
    );
    // Its archive, vellum-prefixed like the manifest.
    const scratch = path.join(retiredDir, "vellum-old-duck.staging");
    await fs.mkdir(path.join(scratch, "workspace"), { recursive: true });
    await fs.writeFile(path.join(scratch, "workspace", "note.txt"), "vellum://a.png\n");
    const run = promisify(execFileCb);
    await run("tar", ["-czf", path.join(retiredDir, "vellum-old-duck.tar.gz"), "-C", scratch, "."]);
    await fs.rm(scratch, { recursive: true, force: true });

    const cadetRoot = path.join(home, ".local", "share", "cadet");
    const prevHome = process.env.HOME;
    const prevXdgDataHome = process.env.XDG_DATA_HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    try {
      const report = await migrate({ vellumRoot: root, processOps: noopOps });
      expect(report.ok).toBe(true);

      // ── The retired files: renamed out of the brand prefix. ──
      expect(await exists(path.join(cadetRoot, "retired", "old-duck.json"))).toBe(true);
      expect(await exists(path.join(cadetRoot, "retired", "old-duck.tar.gz"))).toBe(true);
      expect(await exists(path.join(cadetRoot, "retired", "vellum-old-duck.json"))).toBe(false);
      expect(await exists(path.join(cadetRoot, "retired", "vellum-old-duck.tar.gz"))).toBe(false);

      // ── The manifest: every stale value fixed. ──
      const manifest = JSON.parse(
        await fs.readFile(path.join(cadetRoot, "retired", "old-duck.json"), "utf8"),
      );
      expect(manifest.assistantId).toBe("old-duck");
      expect(manifest.name).toBe("old-duck");
      expect("species" in manifest).toBe(false);
      expect(manifest.runtimeUrl).toBe("http://127.0.0.1:7830");
      expect(manifest.resources.instanceDir).toBe(
        path.join(cadetRoot, "assistants", "old-duck"),
      );
      // baseDataDir ends with the assistant's name, not /vellum.
      expect(manifest.baseDataDir).toBe(path.join(cadetRoot, "assistants", "old-duck"));

      const retired = report.steps.find((s) => s.step === "migrate-retired");
      expect(retired?.summary).toContain("1 cleaned, 2 renamed");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgDataHome;
      if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
  });

  test("re-running on an already-migrated root heals the lockfile and retired manifests", async () => {
    const { root, home } = await buildModernVellum(undefined, "vellum", "vellum-grand-ram");
    const state = path.join(root, "assistants", "vellum-grand-ram", ".vellum");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const prevHome = process.env.HOME;
    const prevXdgDataHome = process.env.XDG_DATA_HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    let logins = 0;
    let vellumSleeps = 0;
    const ops: ProcessOps = {
      ...noopOps,
      async cadetLogin() {
        logins++;
      },
      async vellumSleep() {
        vellumSleeps++;
      },
    };
    try {
      // The vellum install a re-run sees: the lockfile (with its cloud
      // registration — the vellum root is never mutated) and an unscrubbed
      // encrypted store.
      await fs.writeFile(
        path.join(home, ".vellum.lock.json"),
        JSON.stringify(
          {
            assistants: [
              {
                assistantId: "vellum-grand-ram",
                cloud: "local",
                platformAssistantId: "pa_vellum_1",
                resources: {
                  instanceDir: path.join(root, "assistants", "vellum-grand-ram"),
                  gatewayPort: 7830,
                  daemonPort: 7821,
                },
              },
            ],
            activeAssistant: "vellum-grand-ram",
          },
          null,
          2,
        ),
      );
      await fs.mkdir(path.join(state, "protected"), { recursive: true });
      await fs.writeFile(
        path.join(state, "protected", "keys.enc"),
        JSON.stringify(
          { version: 2, entries: { "credential/vellum/webhook_secret": { iv: "dd", tag: "ee", data: "ff" } } },
          null,
          2,
        ),
      );

      const first = await migrate({ vellumRoot: root, processOps: ops });
      expect(first.ok).toBe(true);
      expect(await exists(path.join(home, ".config", "cadet", "lockfile.json"))).toBe(true);

      // Remove the migrated lockfile to simulate an install that predates
      // the conversion — the re-run must heal it.
      await fs.rm(path.join(home, ".config", "cadet", "lockfile.json"));

      const second = await migrate({ vellumRoot: root, processOps: ops });
      expect(second.ok).toBe(true);
      expect(second.mode).toBe("verify-only");

      // The fix steps ran on the already-migrated path…
      const lockStep = second.steps.find((s) => s.step === "migrate-lockfile");
      expect(lockStep?.status).toBe("completed");
      expect(
        await exists(path.join(home, ".config", "cadet", "lockfile.json")),
      ).toBe(true);
      const credStep = second.steps.find((s) => s.step === "migrate-credentials");
      expect(credStep?.status).toBe("skipped"); // already scrubbed on run 1

      // A local re-run never touches vellum-owned data (the cadet root is
      // the only working root here), so it must NOT sleep the assistant —
      // yanking an assistant the user woke between runs would be hostile.
      // The pre-second-run sleep is the fresh flow's own (step 1); the
      // re-run adds none. The docker re-run is the counterexample that
      // DOES sleep — asserted in the docker describe block above.
      expect(vellumSleeps).toBe(1);
      expect(second.steps.some((s) => s.step === "stop-assistant")).toBe(false);

      // …and the retired manifests were already cleaned on run 1.
      const retiredStep = second.steps.find((s) => s.step === "migrate-retired");
      expect(retiredStep?.status).toBe("skipped");

      // Run 1 logged in (cloud registration detected); run 2's fresh
      // lockfile conversion re-detected it and logged in again.
      expect(logins).toBe(2);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgDataHome;
      if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
  });
});
