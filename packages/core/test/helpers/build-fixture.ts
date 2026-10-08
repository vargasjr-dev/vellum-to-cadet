import { promises as fs } from "node:fs";
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
): Promise<BuiltFixture> {
  // Neutral prefix — the temp home shows up verbatim inside machine files
  // that embed absolute state paths.
  const tempHome = home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "cadet-migrate-")));
  const root = path.join(tempHome, ".local", "share", dirName);
  const state = path.join(root, "assistants", "velly", ".vellum");
  await writeAssistantState(state);
  return { root, home: tempHome };
}

/** Writes the full 0.12.6 assistant state tree into `root`. */
async function writeAssistantState(root: string): Promise<void> {
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

  // Machine runtime state inside workspace.
  await write(root, "workspace/data/db/assistant.db", `${SQLITE_MAGIC}fake-assistant-db`);
  await write(root, "workspace/data/db/assistant.db-wal", "wal-bytes");
  await write(root, "workspace/data/db/assistant.db-shm", "shm-bytes");
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

  // Gateway state at the STATE ROOT (vellum 0.12.6): the gateway DB lived
  // at <root>/data/gateway.sqlite and cadet's gateway reads it only from
  // gateway-security — the migrator owns the relocation.
  await write(root, "data/gateway.sqlite", `${SQLITE_MAGIC}fake-gateway-db`);
  await write(root, "data/gateway.sqlite-wal", "gateway-wal-bytes");

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
