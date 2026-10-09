// Node-runtime smoke for the sqlite seam.
//
// CI's test suite runs under bun, which cannot load node:sqlite — but the
// shipped npx package runs under node, where the db steps use node:sqlite.
// This script exercises the BUILT dist under node against a real fixture
// database (created with node:sqlite): the plain value rewrite, the hot-WAL
// replay, and the read-only verify pass.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ASSISTANT_DB_STATE_REL,
  CHANNEL_COLUMNS,
  migrateAssistantDbAt,
} from "../packages/core/dist/steps/migrate-assistant-db.js";
import { dbVellumRows, VALUE_MIGRATED_DBS } from "../packages/core/dist/steps/verify.js";

const destRel = ASSISTANT_DB_STATE_REL; // workspace/data/db/assistant.db
const assistantSpec = VALUE_MIGRATED_DBS[0];

function fail(message) {
  console.error(`node-sqlite-smoke: FAIL — ${message}`);
  process.exit(1);
}

// Build the assistant-db schema FROM the step's own column registry (every
// table+column pair the step touches must exist or the UPDATEs would fail),
// with one 'vellum' value in every pair plus the message and connection
// extras.
function buildVellumDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const columnsByTable = {};
    for (const { table, column } of CHANNEL_COLUMNS) {
      (columnsByTable[table] ??= []).push(column);
    }
    for (const [table, columns] of Object.entries(columnsByTable)) {
      // messages carries content + metadata too — the step rewrites both.
      const extra = table === "messages" ? ", content TEXT, metadata TEXT" : "";
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, ${columns.map((c) => `${c} TEXT`).join(", ")}${extra})`);
      const placeholders = columns.map(() => "?").join(", ");
      db.prepare(`INSERT INTO ${table} (id, ${columns.join(", ")}) VALUES (?, ${placeholders})`).run(
        `${table}-row`,
        ...columns.map(() => "vellum"),
      );
    }
    db.exec(
      `UPDATE messages SET content = 'see vellum://attachments/x', metadata = '{"channel":"vellum"}'
       WHERE id = 'messages-row'`,
    );
    db.exec(`CREATE TABLE provider_connections (id TEXT PRIMARY KEY, name TEXT, provider TEXT)`);
    db.prepare(`INSERT INTO provider_connections VALUES (?, ?, ?)`).run("pc-0", "vellum", "vellum");
  } finally {
    db.close();
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-node-smoke-"));

// 1. Plain rewrite: fresh fixture at the destination, step rewrites it.
{
  const cadetRoot = path.join(tmp, "plain", "cadet");
  const destPath = path.join(cadetRoot, destRel);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  buildVellumDb(destPath);
  const initial = await dbVellumRows(destPath, assistantSpec);
  if (initial !== CHANNEL_COLUMNS.length + 3) {
    fail(`plain rewrite: fixture should start with ${CHANNEL_COLUMNS.length + 3} vellum-branded values, got ${initial}`);
  }
  const result = await migrateAssistantDbAt(cadetRoot, destRel);
  if (result.status !== "completed") fail(`plain rewrite: status ${result.status} (${result.summary})`);
  for (const expected of [
    // the messages.metadata JSON rewrite counts into "channel values" too
    `channel values: ${CHANNEL_COLUMNS.length + 1} row(s)`,
    "attachment links: 1 row(s)",
    "provider connections: 2 row(s)",
  ]) {
    if (!result.summary.includes(expected)) fail(`plain rewrite: summary "${result.summary}" missing "${expected}"`);
  }
  const check = new DatabaseSync(destPath, { readOnly: true });
  const assertions = [
    [`contact_channels`, `SELECT COUNT(*) AS c FROM contact_channels WHERE type = 'cadet'`],
    [`messages content`, `SELECT COUNT(*) AS c FROM messages WHERE content LIKE '%cadet://%'`],
    [`messages metadata`, `SELECT COUNT(*) AS c FROM messages WHERE metadata LIKE '%"cadet"%'`],
    [`provider name`, `SELECT COUNT(*) AS c FROM provider_connections WHERE name = 'cadet'`],
    [`provider value`, `SELECT COUNT(*) AS c FROM provider_connections WHERE provider = 'cadet'`],
  ];
  for (const [label, sql] of assertions) {
    const got = check.prepare(sql).get().c;
    if (got !== 1) fail(`plain rewrite: ${label} — expected 1, got ${got}`);
  }
  check.close();
  const leftover = await dbVellumRows(destPath, assistantSpec);
  if (leftover !== 0) fail(`plain rewrite: ${leftover} vellum-branded value(s) left`);
}

// 2. Hot-WAL replay: rows committed to a WAL-mode db without a checkpoint,
// copied to the destination as main + sidecars (the way migrate-layout does),
// then rewritten by the step — the open replays the WAL frames first.
{
  const srcDir = path.join(tmp, "wal", "src");
  await fs.mkdir(srcDir, { recursive: true });
  const srcPath = path.join(srcDir, "assistant.db");
  const source = new DatabaseSync(srcPath);
  source.exec(`PRAGMA journal_mode = wal`);
  source.exec(`CREATE TABLE contact_channels (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  const insertChannel = source.prepare(`INSERT INTO contact_channels VALUES (?, ?)`);
  insertChannel.run("cc-0", "telegram");
  insertChannel.run("cc-1", "vellum");
  insertChannel.run("cc-2", "vellum");

  // The rows must truly be WAL-resident: a main-file-only copy shows not
  // even the schema.
  const mainOnly = path.join(srcDir, "main-only.db");
  await fs.copyFile(srcPath, mainOnly);
  const peek = new DatabaseSync(mainOnly, { readOnly: true });
  const peekTable = peek
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_channels'`)
    .get();
  peek.close();
  if (peekTable) fail(`wal replay: main-only copy has the table — the smoke scenario is broken`);

  const cadetRoot = path.join(tmp, "wal", "cadet");
  const destPath = path.join(cadetRoot, destRel);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await fs.copyFile(`${srcPath}${suffix}`, `${destPath}${suffix}`);
    } catch {
      // sidecar may not exist — fine
    }
  }

  const result = await migrateAssistantDbAt(cadetRoot, destRel);
  if ((await fs.stat(`${srcPath}-wal`)).size <= 0) fail(`wal replay: source -wal vanished before source close`);
  source.close();
  if (result.status !== "completed") fail(`wal replay: status ${result.status} (${result.summary})`);
  if (!result.summary.includes("channel values: 2 row(s)")) {
    fail(`wal replay: summary "${result.summary}" missing "channel values: 2 row(s)"`);
  }
  try {
    await fs.stat(`${destPath}-wal`);
    fail(`wal replay: destination -wal survived (close should have checkpointed it)`);
  } catch {
    // gone, as expected
  }
  const leftover = await dbVellumRows(destPath, assistantSpec);
  if (leftover !== 0) fail(`wal replay: ${leftover} vellum-branded value(s) left`);
}

// 3. Verify fallback: a non-sqlite file at a db path reads as "unreadable",
// not a crash — verify falls back to a byte comparison there.
{
  const garbage = path.join(tmp, "garbage.db");
  await fs.writeFile(garbage, "not a sqlite file at all");
  const verdict = await dbVellumRows(garbage, { columns: [{ table: "contact_channels", column: "type" }] });
  if (verdict !== "unreadable") fail(`verify fallback: expected "unreadable", got ${JSON.stringify(verdict)}`);
}

console.log("node-sqlite-smoke: ok — plain rewrite, hot-WAL replay, verify fallback all pass under node");
