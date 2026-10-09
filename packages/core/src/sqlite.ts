/**
 * Runtime-neutral SQLite access for the value-migration steps.
 *
 * The migrator ships as an npx package that users run under node, while this
 * repo's test suite runs under bun — and each runtime ships a different
 * built-in SQLite binding (`node:sqlite` vs `bun:sqlite`). The db steps go
 * through this seam so the SQL stays runtime-agnostic: `bun:sqlite` under
 * bun (dev/CI), `node:sqlite` under node (the shipped npx path). CI exercises
 * both adapters: the full suite under bun, plus scripts/node-sqlite-smoke.mjs
 * against the built dist under node.
 *
 * Both adapters keep stock SQLite semantics — journal mode and foreign-key
 * enforcement at SQLite defaults (node:sqlite enables foreign keys by
 * default; disabled here to match).
 */

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

type OpenSqlite = (dbPath: string, options?: SqliteOpenOptions) => SqliteDatabase;

let bindingPromise: Promise<OpenSqlite> | null = null;

/**
 * Open a SQLite database file. The binding is resolved once per process.
 * Opening is stock SQLite in both runtimes: committed frames sitting in a
 * copied -wal sidecar are replayed before any statement runs, and a clean
 * close checkpoints the -wal away.
 */
export async function openSqliteDatabase(dbPath: string, options?: SqliteOpenOptions): Promise<SqliteDatabase> {
  bindingPromise ??= loadBinding();
  return bindingPromise.then((open) => open(dbPath, options));
}

async function loadBinding(): Promise<OpenSqlite> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    return (dbPath, openOptions) => {
      const db = openOptions?.readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
      return {
        prepare: (sql) => db.query(sql),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  return (dbPath, openOptions) => {
    const db = new DatabaseSync(dbPath, {
      readOnly: openOptions?.readonly ?? false,
      enableForeignKeyConstraints: false,
    });
    return {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  };
}
