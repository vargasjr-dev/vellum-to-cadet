/**
 * SQLite access for the value-migration steps, on node's built-in binding.
 *
 * The migrator ships as an npx package run under node (>= 22.13, where
 * node:sqlite shipped unflagged), and this repo's own tests run under node
 * too — every layer exercises the same binding. Stock SQLite semantics:
 * journal mode and foreign-key enforcement stay at SQLite defaults
 * (node:sqlite enables foreign keys by default; disabled here to match).
 */

import { createRequire } from "node:module";

export type SqliteParam = string | number | bigint | null;

export type SqliteStatement = {
  get(...params: SqliteParam[]): unknown;
  all(...params: SqliteParam[]): unknown[];
};

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  /** Run one or more statements with no bound parameters. */
  exec(sql: string): void;
  close(): void;
};

export type SqliteOpenOptions = {
  /** Open read-only. Default: false. */
  readonly?: boolean;
};

// Required lazily inside openSqliteDatabase so a static import can't fail at
// module load — bun (which cannot load node:sqlite) still gets a clean error
// instead of an unresolvable-import crash.
const requireSqlite = createRequire(import.meta.url);

/**
 * node:sqlite prints "ExperimentalWarning: SQLite …" to stderr on first load
 * on every node below v25.7 (where it became a release candidate). The
 * migrator already recommends node 26+ at startup; meanwhile the warning
 * mid-run reads like a step failure. There is no in-process flag for a
 * specific warning, so filter exactly that line from stderr — nothing else
 * legitimately prints it.
 */
let warningFilterInstalled = false;
function suppressSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
    if (text.includes("ExperimentalWarning: SQLite")) return true;
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

/**
 * Open a SQLite database file. Opening is stock SQLite: committed frames
 * sitting in a copied -wal sidecar are replayed before any statement runs,
 * and a clean close checkpoints the -wal away.
 */
export function openSqliteDatabase(dbPath: string, options?: SqliteOpenOptions): SqliteDatabase {
  if (process.versions.bun) {
    throw new Error(
      "This migrator runs on node >= 22.13 (it uses node:sqlite, which bun cannot load). Re-run it with node.",
    );
  }
  suppressSqliteExperimentalWarning();
  const { DatabaseSync } = requireSqlite("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, {
    readOnly: options?.readonly ?? false,
    enableForeignKeyConstraints: false,
  });
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}
