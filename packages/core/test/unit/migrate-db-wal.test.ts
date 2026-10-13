import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DatabaseSync as Database } from "node:sqlite";

import { expect } from "../helpers/expect.js";
import { migrateAssistantDb } from "../../src/steps/migrate-assistant-db.js";

/**
 * The write-ahead question: when the source db has committed transactions
 * still sitting in its -wal (not yet checkpointed), does the value migration
 * still rewrite them? The migrator copies main db + sidecars verbatim
 * (migrate-layout), then opens the DESTINATION — SQLite replays committed
 * WAL frames on open, BEFORE the UPDATEs run, so WAL-resident vellum rows
 * are folded in and rewritten like any other row. These tests prove that
 * ordering end-to-end, including that the source files stay untouched.
 */

/** Copy main db + sidecars the way the layout migration does (verbatim). */
async function copyDbFiles(srcDir: string, destDir: string, name: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = path.join(srcDir, `${name}${suffix}`);
    try {
      await fs.copyFile(from, path.join(destDir, `${name}${suffix}`));
    } catch {
      // sidecar may not exist — fine
    }
  }
}

describe("migrate-assistant-db: write-ahead replay", () => {
  test("rewrites rows still resident in the copied -wal, then folds it in", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-wal-"));
    const srcDir = path.join(tmp, "src");
    const destDir = path.join(tmp, "workspace", "data", "db");
    await fs.mkdir(srcDir, { recursive: true });
    const srcDbPath = path.join(srcDir, "assistant.db");

    // Build a real WAL-mode db and commit rows WITHOUT closing or
    // checkpointing: the commits stay in the -wal file (SQLite checkpoints
    // on close or after ~1000 pages — neither happens here).
    const source = new Database(srcDbPath);
    source.exec("PRAGMA journal_mode = wal");
    source.exec(`CREATE TABLE contact_channels (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
    // WAL-resident content: a telegram row plus two vellum rows, all
    // committed but never checkpointed.
    source.exec(`INSERT INTO contact_channels VALUES ('cc-0', 'telegram')`);
    source.exec(`INSERT INTO contact_channels VALUES ('cc-1', 'vellum')`);
    source.exec(`INSERT INTO contact_channels VALUES ('cc-2', 'vellum')`);

    // The -wal must exist and hold ALL the rows — prove the rows are truly
    // WAL-resident by opening the MAIN file alone (no sidecars) and finding
    // nothing there (not even the schema — the CREATE TABLE itself is
    // still un-checkpointed).
    const walStat = await fs.stat(`${srcDbPath}-wal`);
    expect(walStat.size).toBeGreaterThan(0);
    const mainOnly = path.join(srcDir, "main-only.db");
    await fs.copyFile(srcDbPath, mainOnly);
    const mainOnlyDb = new Database(mainOnly, { readOnly: true });
    const mainOnlyHasTable = !!mainOnlyDb
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_channels'`)
      .get();
    const mainOnlyVellum = mainOnlyHasTable
      ? (mainOnlyDb.prepare(`SELECT COUNT(*) AS c FROM contact_channels WHERE type = 'vellum'`).get() as { c: number }).c
      : 0;
    expect(mainOnlyVellum).toBe(0);
    mainOnlyDb.close();

    // Copy main + sidecars to the destination, verbatim, like migrate-layout.
    await copyDbFiles(srcDir, destDir, "assistant.db");

    // The source connection stays OPEN (no checkpoint on close yet).
    const destRel = "workspace/data/db/assistant.db";
    const result = await migrateAssistantDb([tmp]);
    source.close();

    expect(result.status).toBe("completed");
    // The count surfaces as the per-table info bullet; the headline total.
    expect(result.summary).toContain("assistant db — 2 row(s)");
    expect(result.issues ?? []).toEqual([{ severity: "info", message: "assistant.db - contact_channels.channel values: 2 row(s)" }]);

    // The close checkpointed the destination: no -wal sidecar survives.
    // (Asserted BEFORE the readonly inspection below — any open of a
    // wal-mode db, even readonly, re-creates the sidecars when the
    // directory is writable.)
    expect(await exists(path.join(destDir, "assistant.db-wal"))).toBe(false);

    // The WAL-resident vellum rows were replayed into the destination db
    // on open, then rewritten.
    const destDb = new Database(path.join(destDir, "assistant.db"), { readOnly: true });
    const types = destDb.prepare(`SELECT id, type FROM contact_channels ORDER BY id`).all();
    expect(types).toEqual([
      { id: "cc-0", type: "telegram" },
      { id: "cc-1", type: "cadet" },
      { id: "cc-2", type: "cadet" },
    ]);
    destDb.close();

    // The SOURCE tree is untouched (the migration only ever writes the
    // destination copy).
    const srcTypes = new Database(srcDbPath, { readOnly: true })
      .prepare(`SELECT type FROM contact_channels ORDER BY id`)
      .all();
    expect(srcTypes).toEqual([
      { type: "telegram" },
      { type: "vellum" },
      { type: "vellum" },
    ]);
    expect(await fs.stat(`${srcDbPath}-wal`)).toBeTruthy();
  });

  test("an invalid -wal sidecar is tolerated (treated as empty)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-wal-bad-"));
    const destDir = path.join(tmp, "workspace", "data", "db");
    await fs.mkdir(destDir, { recursive: true });
    const dbPath = path.join(destDir, "assistant.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE contact_channels (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
    db.exec(`INSERT INTO contact_channels VALUES ('cc-1', 'vellum')`);
    db.close();
    // Garbage sidecar (not a valid WAL) — e.g. truncated or foreign bytes.
    await fs.writeFile(`${dbPath}-wal`, "not-a-real-wal-file");

    const result = await migrateAssistantDb([tmp]);
    expect(result.status).toBe("completed");

    const after = new Database(dbPath, { readOnly: true })
      .prepare(`SELECT type FROM contact_channels`)
      .get() as { type: string };
    expect(after.type).toBe("cadet");
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
