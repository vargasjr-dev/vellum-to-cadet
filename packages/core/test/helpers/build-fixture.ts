import { DatabaseSync as Database } from "node:sqlite";
import { promises as fs, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Synthetic vellum 0.12.6 workspace trees for the e2e harness. Every scenario
 * is built fresh in a temp dir — no checked-in binaries, fully deterministic.
 *
 * As Vargas discovers real cases from customer data, add a builder function
 * here and an assertion set in the e2e tests.
 */

const SQLITE_MAGIC = "SQLite format 3\u0000";

export interface BuiltFixture {
  root: string;
  home: string;
}

/** The full 0.12.6-shaped tree: every directory the assistant ever wrote. */
export async function buildFullVellum0126(home?: string): Promise<BuiltFixture> {
  const tempHome = home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "vellum-migrate-")));
  if (!home) tempHomes.push(tempHome);
  const root = path.join(tempHome, ".vellum");
  await writeAssistantState(root);
  return { root, home: tempHome };
}

/**
 * The modern multi-instance layout: per-assistant state dirs at
 * `~/.local/share/vellum[-env]/assistants/<name>/.vellum/`. Pass dirName to
 * build an env-suffixed root (e.g. "vellum-dev").
 */
export async function buildModernVellum(
  home?: string,
  dirName = "vellum",
  /** The assistant handle (the dir under assistants/). */
  assistantName = "velly",
): Promise<BuiltFixture> {
  // Neutral prefix — the temp home shows up verbatim inside machine files
  // that embed absolute state paths.
  const tempHome = home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "cadet-migrate-")));
  if (!home) tempHomes.push(tempHome);
  const root = path.join(tempHome, ".local", "share", dirName);
  const state = path.join(root, "assistants", assistantName, ".vellum");
  await writeAssistantState(state);
  return { root, home: tempHome };
}

/**
 * Every temp home this module created, for `cleanupFixtures()`. The e2e
 * trees are MBs each — without an after-hook they accumulate across local
 * runs until the disk files a complaint.
 */
const tempHomes: string[] = [];

/** Remove every fixture temp home created so far. Safe to call twice. */
export async function cleanupFixtures(): Promise<void> {
  const homes = tempHomes.splice(0, tempHomes.length);
  for (const home of homes) {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Writes the full 0.12.6 assistant state tree into `root`. */
export async function writeAssistantState(root: string): Promise<void> {
  // User-facing workspace (a git repo — the assistant commits to it).
  await mkdirs(root, [
    "workspace",
    "workspace/.git/objects",
    "workspace/notes",
    "workspace/projects/demo",
    // Machine-owned runtime state lives INSIDE the workspace.
    "workspace/data/db",
    "workspace/data/avatar",
    "workspace/data/apps/my-app",
    // Assistant-owned trees.
    "skills/github-summary",
    "plugins/level-up",
    "device",
    "backups/local",
    "protected/credential-executor",
    ".vellum-assistant",
  ]);

  // User data — must survive byte-for-byte.
  await write(root, "workspace/notes/README.md", "# My notes\n\nThe vellum assistant helps me.\n");
  await write(root, "workspace/projects/demo/index.ts", "export const greeting = 'hello from my project';\n");
  await write(
    root,
    "workspace/.git/objects/pack",
    "PACKFILLEDFAKEGITBYTES",
  );
  // User prose that mentions vellum must NOT be rewritten.
  await write(
    root,
    "workspace/notes/vellum-history.md",
    "# History\n\nI used vellum before it was cadet. VELLUM_ROOT_DIR was a nice env var.\n",
  );

  // Machine-owned files inside the workspace carry vellum-branded VALUES.
  await write(
    root,
    "workspace/config.json",
    JSON.stringify(
      {
        profiles: [
          { name: "daily", provider: "vellum", model: "claude-sonnet" },
          { name: "byok", provider: "anthropic", model: "claude" },
        ],
        services: { stt: { provider: "vellum" }, tts: { provider: "vellum" } },
      },
      null,
      2,
    ),
  );
  await write(
    root,
    "workspace/skills/github-summary/install-meta.json",
    JSON.stringify({ origin: "vellum", version: "1.2.3", installedAt: "2026-10-01" }, null, 2),
  );
  await write(
    root,
    "workspace/plugins/greeter/package.json",
    JSON.stringify({ name: "greeter", dependencies: { "@vellumai/plugin-api": "^1.0.0" } }, null, 2),
  );
  await write(
    root,
    "workspace/plugins/greeter/index.ts",
    'import { definePlugin } from "@vellumai/plugin-api";\n\nexport default definePlugin({ name: "greeter" });\n',
  );
  // Skill docs' frontmatter is a machine contract (cadet reads
  // metadata.cadet.*) — old installs carry metadata.vellum and must be
  // rewritten; the prose below stays verbatim.
  await write(
    root,
    "workspace/skills/github-summary/SKILL.md",
    "---\nname: github-summary\ndescription: Summarize commits\nmetadata:\n  emoji: \"octopus\"\n  vellum:\n    display-name: GitHub Summary\n    category: productivity\n---\n\n# GitHub summary\n\nFrom the vellum catalog.\n",
  );

  // Agent conversation logs — the runtime reads these back to answer
  // questions about shared history. Precise edits only: attachment links
  // and channel values flip; quoted user prose and single-quoted shell
  // output stay verbatim.
  await mkdirs(root, ["workspace/conversations/2026-10-01T09-00-00.000Z_11111111-1111-4111-8111-111111111111/.tool-results"]);
  await write(
    root,
    "workspace/conversations/2026-10-01T09-00-00.000Z_11111111-1111-4111-8111-111111111111/messages.jsonl",
    [
      JSON.stringify({ type: "user", content: "Remember when I said I used vellum before it was cadet?" }),
      JSON.stringify({
        type: "assistant",
        content: "Here is the doc you shared: vellum://workspace/data/attachments/q3-report.pdf",
      }),
      JSON.stringify({ type: "event", channel: "vellum", detail: "delivered" }),
      JSON.stringify({ type: "tool", content: "SELECT * FROM channels WHERE type = 'vellum';" }),
      "",
    ].join("\n"),
  );
  await write(
    root,
    "workspace/conversations/2026-10-01T09-00-00.000Z_11111111-1111-4111-8111-111111111111/.tool-results/abc123.txt",
    "saved attachment to vellum://workspace/data/attachments/notes.txt\nsecond line mentions plain vellum in prose\n",
  );

  // Runtime logs (daily files, same names in cadet) + the legacy-named
  // vellum.log (content rewritten, name kept — cadet never reads it).
  await mkdirs(root, ["workspace/data/logs"]);
  await write(
    root,
    "workspace/data/logs/assistant-2026-10-09.log",
    [
      "2026-10-09T12:00:00.000Z INFO attached doc vellum://workspace/data/attachments/q3-report.pdf",
      '2026-10-09T12:00:01.000Z INFO event delivered on channel "vellum"',
      "2026-10-09T12:00:02.000Z INFO VELLUM_ROOT_DIR=/root/.vellum workspace=/root/.vellum/workspace",
      '2026-10-09T12:00:03.000Z INFO user said "I used vellum before it was cadet"',
      "",
    ].join("\n"),
  );
  await write(
    root,
    "workspace/data/logs/vellum.log",
    "legacy daemon line with a vellum://workspace/data/attachments/old.txt link\n",
  );

  // Persona prompt files: brand references flip (Vargas's call) so the
  // persona never tells cadet it runs on vellum. Paths and links follow
  // the same precise rules.
  await write(
    root,
    "workspace/SOUL.md",
    [
      "# Soul",
      "",
      "You are the user's loyal padawan. The assistant comes with the Vellum harness by default.",
      "",
      "## History",
      "We keep shared docs at vellum://workspace/notes/readme and my old keys lived in ~/.vellum.",
      "",
    ].join("\n"),
  );

  // Machine runtime state inside workspace.
  await write(root, "workspace/data/db/assistant.db-wal", "wal-bytes");
  await write(root, "workspace/data/db/assistant.db-shm", "shm-bytes");
  await writeRealAssistantDb(path.join(root, "workspace/data/db/assistant.db"));
  await write(root, "workspace/data/stream-seq.json", JSON.stringify({ seq: 42 }));
  await write(root, "workspace/data/avatar/avatar.png", "png-bytes-here");

  // Assistant config with env vars, npm scope, and absolute paths.
  await write(
    root,
    "config.json",
    JSON.stringify(
      {
        npmPackages: ["@vellumai/slack", "@vellumai/twilio"],
        hooks: [
          {
            name: "on-wake",
            command: "bash ~/.vellum/hooks/on-wake.sh",
          },
        ],
        daemon: { noauth: false },
      },
      null,
      2,
    ),
  );

  // Hook scripts referencing vellum env vars and paths.
  await write(
    root,
    "hooks/on-wake.sh",
    "#!/bin/bash\necho \"$VELLUM_HOOK_EVENT|$VELLUM_HOOK_NAME|$VELLUM_ROOT_DIR|$VELLUM_WORKSPACE_DIR\"\nls ~/.vellum/skills >> /dev/null\n",
  );

  // Skills with frontmatter + env var references.
  await write(
    root,
    "skills/github-summary/SKILL.md",
    "---\nname: github-summary\ndescription: Summarize commits\n---\n\nUse $VELLUM_ROOT_DIR to find the root.\n",
  );

  // Gateway state (vellum 0.12.6): the gateway DB lives under protected/
  // (seen in the wild at <state>/.vellum/protected/gateway.sqlite) and
  // cadet's gateway reads it only from gateway-security — the migrator
  // owns the relocation. It is a REAL db carrying the gateway's own
  // channel-branded rows; the value-migration step rewrites them after
  // the relocation. The -wal sidecar is fake bytes on purpose: an invalid
  // WAL is tolerated (treated as empty) by SQLite.
  await writeRealGatewayDb(path.join(root, "protected/gateway.sqlite"));
  await write(root, "protected/gateway.sqlite-wal", "gateway-wal-bytes");

  // Root-level guardian-init lock (pre-0.12 straggler; 0.12 kept it in
  // protected/ which dissolves there anyway).
  await write(root, "guardian-init.lock", "{}");
  await write(root, "guardian-init-consumed.json", "{}");

  // Pre-XDG backup key straggler (vellum migration 061 parked it in the
  // workspace). The workspace stays byte-for-byte; the migrator copies it
  // into gateway-security.
  await write(root, "workspace/.backup.key", "0123456789abcdef0123456789abcdef");

  // Protected key material — never rewritten; destinations dissolve to the
  // per-service dirs (gateway-security / ces-security / ces-data).
  await write(root, "protected/actor-token-signing-key", "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n");
  await write(root, "protected/backup.key", "fedcba9876543210fedcba9876543210");
  await write(root, "protected/keys.enc", "FAKEENCRYPTEDSTOREBYTES");
  await write(root, "protected/store.key", "FAKESTOREKEYBYTES");
  await write(root, "protected/credential-executor/grants.json", JSON.stringify({ grants: [] }));

  // Device registry + daemon state.
  await write(root, "device/registry.json", JSON.stringify({ deviceId: "dev_123", platform: "local" }));

  // Desktop marker with version.
  await write(root, ".vellum-assistant/version", "0.12.6");

  // Skill-run marker dotfile.
  await write(root, ".vellum-skill-run/github-summary", "1700000000000");

  // A .env with vellum vars.
  await write(root, ".env", "VELLUM_PLATFORM_URL=https://api.vellum.example\nVELLUM_DATA_DIR=~/.vellum\n");
}

/** Bare minimum root: just a workspace. */
export async function buildMinimal(home?: string): Promise<BuiltFixture> {
  const tempHome = home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "vellum-migrate-")));
  const root = path.join(tempHome, ".vellum");
  await mkdirs(root, ["workspace", ".vellum-assistant"]);
  await write(root, "workspace/hello.txt", "hi\n");
  await write(root, ".vellum-assistant/version", "0.12.6");
  return { root, home: tempHome };
}

/** A docker-compose deployment: compose file references the root as a bind mount. */
export async function buildDocker(home?: string): Promise<BuiltFixture & { composePath: string }> {
  const built = await buildFullVellum0126(home);
  const composePath = path.join(built.home, "docker-compose.yml");
  await fs.writeFile(
    composePath,
    `services:\n  assistant:\n    image: vellum-assistant:0.12.6\n    volumes:\n      - ${built.root}:/data\n`,
    "utf8",
  );
  return { ...built, composePath };
}

async function mkdirs(root: string, rels: string[]): Promise<void> {
  for (const rel of rels) {
    await fs.mkdir(path.join(root, rel), { recursive: true });
  }
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/**
 * A REAL sqlite assistant db carrying the vellum-branded values the old
 * product persisted: channel ids `'vellum'` (the desktop client channel),
 * `vellum://` attachment links in message content, and the managed provider
 * connection row named/typed `vellum`. The db-value migration step must
 * rewrite all of it to cadet spellings.
 */
function writeRealAssistantDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE conversations (
    id TEXT PRIMARY KEY, title TEXT, origin_channel TEXT, origin_interface TEXT, created_at INTEGER
  )`);
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER,
    metadata TEXT, user_message_channel TEXT, assistant_message_channel TEXT
  )`);
  db.exec(`CREATE TABLE provider_connections (
    name TEXT PRIMARY KEY, provider TEXT, auth TEXT, created_at INTEGER, updated_at INTEGER
  )`);
  db.exec(`CREATE TABLE channel_inbound_events (
    source_channel TEXT, external_chat_id TEXT, external_message_id TEXT
  )`);
  db.exec(`INSERT INTO conversations VALUES
    ('c1', 'Desktop chat', 'vellum', 'text', 1),
    ('c2', 'Telegram chat', 'telegram', 'text', 2)`);
  db.exec(`INSERT INTO messages VALUES
    ('m1', 'c1', 'user', 'Here it is: [report.md](vellum://workspace/report.md)', 1,
     '{"channel":"vellum"}', 'vellum', 'vellum'),
    ('m2', 'c2', 'assistant', 'plain reply, no links', 2,
     '{"channel":"telegram"}', 'telegram', 'telegram')`);
  db.exec(`INSERT INTO provider_connections VALUES
    ('vellum', 'vellum', '{"type":"platform"}', 1, 1),
    ('openai', 'openai', '{"type":"api_key"}', 2, 2)`);
  db.exec(`INSERT INTO channel_inbound_events VALUES ('vellum', 'chat-1', 'evt-1')`);
  db.close();
}

/**
 * A REAL sqlite gateway db carrying the gateway's OWN channel-branded rows
 * (gateway/src/db/schema.ts): the gateway-owned contact_channels copy,
 * invite/request/delivery/seen-event channel columns, and the per-channel
 * policy/identity tables. The value-migration step must rewrite all of it to
 * cadet spellings after the relocation into gateway-security/.
 */
function writeRealGatewayDb(dbPath: string): void {
  // The state root's data/ dir may not exist yet — sqlite won't create it.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE contacts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'contact'
  )`);
  db.exec(`CREATE TABLE contact_channels (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, address TEXT
  )`);
  db.exec(`CREATE TABLE ingress_invites (
    id TEXT PRIMARY KEY, source_channel TEXT NOT NULL, code TEXT
  )`);
  db.exec(`CREATE TABLE guardian_requests (
    id TEXT PRIMARY KEY, source_channel TEXT, summary TEXT
  )`);
  db.exec(`CREATE TABLE guardian_request_deliveries (
    id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL, chat_id TEXT
  )`);
  db.exec(`CREATE TABLE inbound_seen_events (
    id TEXT PRIMARY KEY, source_channel TEXT NOT NULL, external_message_id TEXT
  )`);
  db.exec(`CREATE TABLE channel_bot_identity (
    channel_type TEXT PRIMARY KEY, bot_user_id TEXT
  )`);
  db.exec(`CREATE TABLE channel_admission_policy (
    channel_type TEXT PRIMARY KEY, mode TEXT
  )`);
  db.exec(`CREATE TABLE channel_permission_overrides (
    id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, channel_external_id TEXT
  )`);
  db.exec(`CREATE TABLE channel_verification_sessions (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT
  )`);
  db.exec(`CREATE TABLE channel_guardian_rate_limits (
    channel TEXT PRIMARY KEY, window_start INTEGER
  )`);
  db.exec(`CREATE TABLE slack_active_threads (
    id TEXT PRIMARY KEY, channel_id TEXT
  )`);
  db.exec(`INSERT INTO contacts VALUES ('contact-1', 'Vargas', 'guardian')`);
  db.exec(`INSERT INTO contact_channels VALUES
    ('cc-1', 'contact-1', 'vellum', 'owner@vellum.local'),
    ('cc-2', 'contact-1', 'telegram', '@owner')`);
  db.exec(`INSERT INTO ingress_invites VALUES ('inv-1', 'vellum', 'code-1')`);
  db.exec(`INSERT INTO guardian_requests VALUES ('gr-1', 'vellum', 'open the pod bay doors')`);
  db.exec(`INSERT INTO guardian_request_deliveries VALUES ('gd-1', 'vellum', 'chat-1')`);
  db.exec(`INSERT INTO inbound_seen_events VALUES ('se-1', 'vellum', 'evt-1')`);
  db.exec(`INSERT INTO channel_bot_identity VALUES ('vellum', 'bot-1')`);
  db.exec(`INSERT INTO channel_admission_policy VALUES ('vellum', 'open')`);
  db.exec(`INSERT INTO channel_permission_overrides VALUES
    ('po-1', 'vellum', 'chat-1'),
    ('po-2', 'slack', 'C01ABC')`);
  db.exec(`INSERT INTO channel_verification_sessions VALUES ('vs-1', 'vellum', 'owner@vellum.local')`);
  db.exec(`INSERT INTO channel_guardian_rate_limits VALUES ('vellum', 1)`);
  db.exec(`INSERT INTO slack_active_threads VALUES ('t-1', 'C01ABC')`);
  db.close();
}
