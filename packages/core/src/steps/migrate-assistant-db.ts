import { promises as fs } from "node:fs";
import * as path from "node:path";

import { handleToInstanceName, USER_WORKSPACE_DIR } from "../layout.js";
import { walkTree } from "../fs-utils.js";
import { openSqliteDatabase, type SqliteDatabase } from "../sqlite.js";
import { migratePrincipalIds } from "./migrate-principal-ids.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * Rewrite vellum-branded VALUES inside the migrated SQLite DBs. The old
 * product persisted channel ids as `'vellum'` (the desktop client channel),
 * `vellum://` attachment links in message content, and the managed provider
 * connection under the name/provider `vellum`. The renamed product only reads
 * `cadet` spellings, and its own migrations can't heal them (its migration
 * numbering already marks those versions applied — see the
 * provider-connections normalization note below).
 *
 * Two databases carry vellum-branded values, each an explicit step with an
 * explicit column list:
 *
 * - `migrate-assistant-db` — the assistant DB. Channel columns mirror the old
 *   product's own channel-rename migration (its 144) table-for-table, plus
 *   message content/metadata and the managed connection row.
 * - `migrate-gateway-db` — the gateway DB (relocated to `gateway-security/`
 *   by the layout step). The gateway owns its own channel-branded tables —
 *   its contact_channels copy (guardian-bootstrap finds the owner's contact
 *   with `type = 'vellum'`), its invite/request/delivery/seen-event channel
 *   columns, and the per-channel-type policy/identity tables.
 *
 * Every UPDATE is guarded by a table-exists check so older DBs without a
 * table are fine, and only rows still spelling `vellum` are touched
 * (idempotent). Runs on the DESTINATION copy — the vellum root (and its
 * backup) stay byte-identical.
 */

/** Every assistant-db table+column that stores a channel id, from the old product's own rename migration. */
export const CHANNEL_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "contact_channels", column: "type" },
  { table: "conversations", column: "origin_channel" },
  { table: "conversations", column: "origin_interface" },
  { table: "messages", column: "user_message_channel" },
  { table: "messages", column: "assistant_message_channel" },
  { table: "assistant_ingress_invites", column: "source_channel" },
  { table: "assistant_inbox_thread_state", column: "source_channel" },
  { table: "guardian_action_requests", column: "source_channel" },
  { table: "guardian_action_requests", column: "answered_by_channel" },
  { table: "channel_verification_sessions", column: "channel" },
  { table: "channel_guardian_approval_requests", column: "channel" },
  { table: "channel_guardian_rate_limits", column: "channel" },
  { table: "notification_events", column: "source_channel" },
  { table: "notification_deliveries", column: "channel" },
  { table: "external_conversation_bindings", column: "source_channel" },
  { table: "channel_inbound_events", column: "source_channel" },
  { table: "conversation_attention_events", column: "source_channel" },
  { table: "conversation_assistant_attention_state", column: "last_seen_source_channel" },
  { table: "canonical_guardian_requests", column: "source_channel" },
  { table: "canonical_guardian_deliveries", column: "destination_channel" },
  { table: "guardian_action_deliveries", column: "destination_channel" },
  { table: "scoped_approval_grants", column: "request_channel" },
  { table: "scoped_approval_grants", column: "decision_channel" },
  { table: "scoped_approval_grants", column: "execution_channel" },
  { table: "sequences", column: "channel" },
  { table: "followups", column: "channel" },
];

/**
 * Every gateway-db table+column that stores a channel id, read off the
 * gateway's own schema (gateway/src/db/schema.ts). The gateway db's
 * `contact_channels` is the gateway's OWN copy (not the assistant's proxied
 * table) — guardian-bootstrap resolves the owner's contact with
 * `type = 'vellum'`, so an unrewritten row makes the migrated gateway treat
 * the guardian as unknown. External chat ids (Slack `channel_id`,
 * `channel_external_id`) and webhook route kinds are a different vocabulary —
 * deliberately not touched.
 */
export const GATEWAY_CHANNEL_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "contact_channels", column: "type" },
  { table: "ingress_invites", column: "source_channel" },
  { table: "channel_denial_reply_log", column: "channel" },
  { table: "guardian_requests", column: "source_channel" },
  { table: "guardian_request_deliveries", column: "destination_channel" },
  { table: "inbound_seen_events", column: "source_channel" },
  { table: "channel_bot_identity", column: "channel_type" },
  { table: "channel_admission_policy", column: "channel_type" },
  { table: "channel_permission_overrides", column: "channel_type" },
  { table: "channel_verification_sessions", column: "channel" },
  { table: "channel_guardian_rate_limits", column: "channel" },
];

/** State-relative path of the assistant db — how the copy plan addresses it. */
export const ASSISTANT_DB_STATE_REL = `${USER_WORKSPACE_DIR}/data/db/assistant.db`;

/**
 * State-relative source forms of the gateway db. Real vellum 0.12.6 keeps it
 * inside the assistant's protected/ dir (dissolved to gateway-security/ by
 * the protected-dir rules); the state-root data/ form is the older shape.
 */
export const GATEWAY_DB_STATE_RELS: ReadonlyArray<string> = [
  "protected/gateway.sqlite",
  "data/gateway.sqlite",
];

/** True when a state-relative path is the gateway db's source location. */
export function isGatewayDbStateRel(stateRel: string): boolean {
  return GATEWAY_DB_STATE_RELS.includes(stateRel);
}

/**
 * Where the gateway db lands in every MIGRATED tree: PATH_MOVES relocates
 * both source forms here, so the copied cadet root and the docker flow's
 * state-shaped scratch tree both carry this shape.
 */
export const GATEWAY_DB_DEST_REL = "gateway-security/gateway.sqlite";

/** Gateway-db tails a working root can hold (the second covers volume content that kept a data/ level). */
const GATEWAY_DB_DEST_TAILS: ReadonlyArray<string> = [
  GATEWAY_DB_DEST_REL,
  "gateway-security/data/gateway.sqlite",
];

function isAssistantDbRel(relPath: string): boolean {
  return relPath === ASSISTANT_DB_STATE_REL || relPath.endsWith(`/${ASSISTANT_DB_STATE_REL}`);
}

function isGatewayDbDestRel(relPath: string): boolean {
  return GATEWAY_DB_DEST_TAILS.some((tail) => relPath === tail || relPath.endsWith(`/${tail}`));
}

/**
 * Scan a working root for the value-migrated dbs, destination-relative.
 * The direct-or-suffix match covers every tree shape that holds a state
 * root: the legacy cadet root (`workspace/…` at the top), the modern one
 * (`assistants/<name>/…` nesting), and the docker flow's state-shaped
 * scratch root (one state tree per assistant, `<instance>/…`). Retired
 * cold storage and dot-directories are skipped — the same exclusions the
 * credentials scrub applies. A walk failure (nothing was materialized at
 * this root — an unreachable docker daemon, say) scans as empty.
 */
export async function findStateDbs(
  root: string,
): Promise<{ assistantDbs: string[]; gatewayDbs: string[] }> {
  const found: { assistantDbs: string[]; gatewayDbs: string[] } = { assistantDbs: [], gatewayDbs: [] };
  let entries;
  try {
    entries = await walkTree(root);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rel = entry.relPath.split("\\").join("/");
    if (rel.split("/").some((seg) => seg === "retired" || seg.startsWith("."))) continue;
    if (isAssistantDbRel(rel)) found.assistantDbs.push(rel);
    else if (isGatewayDbDestRel(rel)) found.gatewayDbs.push(rel);
  }
  return found;
}

/**
 * One db to value-migrate: the working root it lives under and its path
 * relative to that root.
 */
interface DbTarget {
  root: string;
  destRel: string;
}

/**
 * Display form of a db path under a working root: the docker scratch tree
 * keys dbs by the RAW lockfile handle (`vellum-<name>/workspace/…`), and
 * the raw brand prefix is noise the user never chose — labels read under
 * the migrated instance name, matching every other step line (v0.0.15
 * field feedback). Non-instance leading segments pass through unchanged.
 */
export function displayDbRel(rel: string): string {
  const segments = rel.split("/");
  const [first] = segments;
  if (first === undefined) return rel;
  return [handleToInstanceName(first), ...segments.slice(1)].join("/");
}

/**
 * The shared migrate-assistant-db step: value-migrate EVERY assistant db
 * the given working roots hold. The roots are plain directories carrying
 * state trees — the copied cadet root (local) and/or the docker flow's
 * state-shaped scratch tree — and discovery is one shared scan for both,
 * so this step knows nothing about volumes or docker (a mixed install
 * passes both roots and gets both sets of dbs migrated).
 */
export async function migrateAssistantDb(roots: ReadonlyArray<string>): Promise<StepResult> {
  const targets: DbTarget[] = [];
  for (const root of roots) {
    for (const destRel of (await findStateDbs(root)).assistantDbs) {
      targets.push({ root, destRel });
    }
  }
  return migrateDbsAt(targets, {
    step: "migrate-assistant-db",
    label: "assistant db",
    columns: CHANNEL_COLUMNS,
    rewriteMessages: true,
    rewriteConnections: true,
  });
}

/** Repair-mode entry: same step, aimed at one db in an already-migrated cadet root. */
export async function migrateAssistantDbAt(
  cadetRoot: string,
  destRel: string | undefined,
): Promise<StepResult> {
  if (!destRel) {
    return {
      step: "migrate-assistant-db",
      status: "skipped",
      summary: "no assistant db in the migrated workspace",
    };
  }
  return migrateDbsAt([{ root: cadetRoot, destRel }], {
    step: "migrate-assistant-db",
    label: "assistant db",
    columns: CHANNEL_COLUMNS,
    rewriteMessages: true,
    rewriteConnections: true,
  });
}

/**
 * The shared migrate-gateway-db step: same roots-based shape as the
 * assistant-db step, with the gateway's own channel column list.
 */
export async function migrateGatewayDb(roots: ReadonlyArray<string>): Promise<StepResult> {
  const targets: DbTarget[] = [];
  for (const root of roots) {
    for (const destRel of (await findStateDbs(root)).gatewayDbs) {
      targets.push({ root, destRel });
    }
  }
  return migrateDbsAt(targets, {
    step: "migrate-gateway-db",
    label: "gateway db",
    columns: GATEWAY_CHANNEL_COLUMNS,
  });
}

/** Repair-mode entry: same step, aimed at one db in an already-migrated cadet root. */
export async function migrateGatewayDbAt(
  cadetRoot: string,
  destRel: string | undefined,
): Promise<StepResult> {
  if (!destRel) {
    return {
      step: "migrate-gateway-db",
      status: "skipped",
      summary: "no gateway db in the migrated workspace",
    };
  }
  return migrateDbsAt([{ root: cadetRoot, destRel }], {
    step: "migrate-gateway-db",
    label: "gateway db",
    columns: GATEWAY_CHANNEL_COLUMNS,
  });
}

/**
 * Run the value rewrite against every target and fold the per-db results
 * into one step result. A real machine carries one state tree PER assistant
 * (`assistants/<name>/…` all normalize to the same state-relative form), and
 * the docker flow adds one state tree per instance — rewriting only the
 * first left every later workspace's contact_channels branded (v0.0.9 run
 * feedback).
 */
async function migrateDbsAt(
  targets: ReadonlyArray<DbTarget>,
  options: Omit<DbValuesOptions, "cadetRoot" | "destRel">,
): Promise<StepResult> {
  if (targets.length === 0) {
    return {
      step: options.step,
      status: "skipped",
      summary: `no ${options.label} in the migrated workspace`,
    };
  }
  const results: StepResult[] = [];
  for (const target of targets) {
    results.push(await migrateDbValues({ ...options, cadetRoot: target.root, destRel: target.destRel }));
  }
  if (results.length === 1) {
    const result = results[0]!;
    result.issues = result.issues?.map((issue) => issue.severity === "info"
      ? { ...issue, message: `${path.basename(targets[0]!.destRel)} - ${issue.message}` }
      : issue);
    return result;
  }

  // Multi-db fold: per-db info bullets carry their path so N workspaces read
  // as N lines, and the headline reports the combined row count.
  const issues: StepIssue[] = [];
  let totalRows = 0;
  let completed = 0;
  for (const [i, r] of results.entries()) {
    const destRel = targets[i]!.destRel;
    // Display form: the docker scratch tree keys dbs by the RAW lockfile
    // handle (`vellum-prime-quail-3ezfs4/workspace/…`) — the raw brand
    // prefix is noise the user never chose (v0.0.15 field feedback), so
    // labels read under the migrated instance name.
    const displayRel = path.basename(destRel);
    if (r.status === "completed") completed++;
    for (const issue of r.issues ?? []) {
      issues.push(
        issue.severity === "info"
          ? { ...issue, message: `${displayRel} - ${issue.message}` }
          : { ...issue, message: `${displayRel}: ${issue.message}` },
      );
    }
    const rows = Object.values(
      (r.data?.["substeps"] as Record<string, number> | undefined) ?? {},
    ).reduce((a, b) => a + b, 0);
    totalRows += rows;
  }
  const allSkipped = completed === 0;
  const warningNote = issues.some((i) => i.severity === "warning")
    ? ` — ${issues.filter((i) => i.severity === "warning").length} skipped (see ⚠)`
    : "";
  return {
    step: options.step,
    status: allSkipped ? "skipped" : "completed",
    summary: allSkipped
      ? results[0]!.summary
      : `${options.label}s — ${totalRows} row(s) across ${targets.length} db(s)${warningNote}`,
    issues,
    data: {
      dbs: targets.map((target, i) => ({
        dbPath: target.destRel,
        substeps: results[i]!.data?.["substeps"] ?? {},
      })),
    },
  };
}

type DbValuesOptions = {
  cadetRoot: string;
  destRel: string;
  step: StepResult["step"];
  label: string;
  columns: ReadonlyArray<{ table: string; column: string }>;
  /** Assistant-only: message metadata JSON refs + `vellum://` content links. */
  rewriteMessages?: boolean;
  /** Assistant-only: the managed provider connection row. */
  rewriteConnections?: boolean;
};

async function migrateDbValues(options: DbValuesOptions): Promise<StepResult> {
  const { cadetRoot, destRel, step, label, columns } = options;
  const dbPath = path.join(cadetRoot, destRel);

  if (!(await fileExists(dbPath))) {
    return { step, status: "skipped", summary: `no ${label} in the migrated workspace` };
  }

  let db: SqliteDatabase;
  try {
    // Opening recovers/checkpoints any copied -wal sidecar: committed frames
    // still sitting in the WAL are replayed into the main db BEFORE the
    // rewrites below run, so WAL-resident vellum rows are rewritten too.
    db = openSqliteDatabase(dbPath);
  } catch (err) {
    // SELF-DIAGNOSING (v0.0.15 field feedback: "unable to open database
    // file" named neither the absolute path nor why — on a re-run the
    // working roots include the cadet root itself, where a legacy-shaped
    // copy of the db can be a broken leftover the user has never seen).
    const absPath = path.join(cadetRoot, destRel);
    const diagnosis = await diagnoseUnreadableDb(absPath);
    return {
      step,
      status: "skipped",
      summary: `${label} could not be opened — left verbatim (${(err as Error).message})`,
      issues: [
        {
          severity: "warning",
          message: `${absPath}: ${(err as Error).message} — ${diagnosis}`,
        },
      ],
    };
  }

  const issues: StepIssue[] = [];
  try {
    const substeps: Record<string, number> = {};
    const tableExists = (name: string): boolean =>
      !!db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(name);
    const runCounted = (sql: string): number => {
      db.exec(sql);
      const row = db.prepare(`SELECT changes() AS c`).get() as { c: number } | null;
      return row?.c ?? 0;
    };
    /** A weird db never fails the migration — it becomes a nested ⚠. */
    const note = (what: string, err: unknown): void => {
      issues.push({
        severity: "warning",
        message: `${what}: ${(err as Error).message} — skipped, continuing`,
      });
    };

    // "channel values": every channel-id column, 'vellum' → 'cadet'. Each
    // column is its own transaction of one: a table that exists but lacks
    // the expected column is known schema drift (the old product's own
    // migration 120 dropped the messages channel columns), so it skips
    // silently — only real errors warn.
    const columnExists = (table: string, column: string): boolean =>
      !!db
        .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
        .get(table, column);
    let channelRows = 0;
    const tableRows: Record<string, number> = {};
    for (const { table, column } of columns) {
      if (!tableExists(table)) continue;
      if (!columnExists(table, column)) continue;
      try {
        // Unique-index-aware dedupe BEFORE the rewrite: rewriting 'vellum'
        // → 'cadet' can only collide on an index that includes the column,
        // and the real-world case is a twin row — the same address recorded
        // once under each brand spelling (contact_channels UNIQUE(type,
        // address) with rows (vellum, X) and (cadet, X) from the guardian
        // principal re-seed across the rebrand). Without this, the UPDATE
        // aborts with "UNIQUE constraint failed", 0 rows rewritten, and the
        // whole column stays branded (v0.0.15 field run: 19 rows). The
        // cadet-spelled twin wins — it is the row the renamed runtime
        // seeded and reads; the vellum row is the dead spelling.
        let mergedRows = 0;
        for (const keyCols of uniqueIndexesOn(db, table, column)) {
          const merged = dedupeCollidingRows(runCounted, table, column, keyCols);
          if (merged > 0) {
            mergedRows += merged;
          }
        }
        if (mergedRows > 0) {
          issues.push({
            severity: "info",
            message: `${table}.${column}: merged ${mergedRows} duplicate row(s) — a 'cadet' twin already held the unique key; the vellum-spelled row was dropped`,
          });
        }
        const rows = runCounted(
          `UPDATE ${table} SET ${column} = 'cadet' WHERE ${column} = 'vellum'`,
        );
        channelRows += rows;
        tableRows[table] = (tableRows[table] ?? 0) + rows;
      } catch (err) {
        note(`${table}.${column}`, err);
      }
    }
    if (options.rewriteMessages && tableExists("messages") && columnExists("messages", "metadata")) {
      // Message metadata records channel refs as JSON string values.
      try {
        const rows = runCounted(
          `UPDATE messages SET metadata = REPLACE(metadata, '"vellum"', '"cadet"')
           WHERE metadata LIKE '%"vellum"%'`,
        );
        channelRows += rows;
        tableRows["messages"] = (tableRows["messages"] ?? 0) + rows;
      } catch (err) {
        note("messages.metadata", err);
      }
    }
    substeps["channel values"] = channelRows;

    if (options.rewriteMessages) {
      // "attachment links": vellum:// attachment URIs in message content.
      let linkRows = 0;
      if (tableExists("messages") && columnExists("messages", "content")) {
        try {
          linkRows += runCounted(
            `UPDATE messages SET content = REPLACE(content, 'vellum://', 'cadet://')
             WHERE content LIKE '%vellum://%'`,
          );
        } catch (err) {
          note("messages.content (attachment links)", err);
        }
      }
      substeps["attachment links"] = linkRows;
    }

    if (options.rewriteConnections) {
      // "provider connections": the managed platform connection was named and
      // typed `vellum`. The renamed product's own normalizer can't revisit it
      // (its migration version is already marked applied), so the rename is
      // ours. The name only moves when `cadet` is free (a re-seeded cadet row
      // would make the PK collide).
      let connectionRows = 0;
      if (
        tableExists("provider_connections") &&
        columnExists("provider_connections", "provider")
      ) {
        try {
          connectionRows += runCounted(
            `UPDATE provider_connections SET provider = 'cadet' WHERE provider = 'vellum'`,
          );
          connectionRows += runCounted(
            `UPDATE provider_connections SET name = 'cadet'
             WHERE name = 'vellum'
               AND NOT EXISTS (SELECT 1 FROM provider_connections WHERE name = 'cadet')`,
          );
        } catch (err) {
          note("provider_connections", err);
        }
      }
      substeps["provider connections"] = connectionRows;
    }

    try {
      const principals = migratePrincipalIds(db);
      substeps["principal ids"] = principals.rows;
      if (principals.revoked > 0) {
        issues.push({ severity: "warning", message: "Legacy signed access tokens were revoked after renaming their principal. Browser refresh tokens remain valid; run `cadet login` again for CLI clients without a refresh token." });
      }
    } catch (err) {
      note("principal ids (rolled back together)", err);
    }
    db.close();

    const parts = [
      ...Object.entries(tableRows).filter(([, n]) => n > 0).map(([table, n]) => `${table}.channel values: ${n} row(s)`),
      ...Object.entries(substeps).filter(([name, n]) => name !== "channel values" && n > 0)
        .map(([name, n]) => `${name === "principal ids" ? label : name === "attachment links" ? "messages" : "provider_connections"}.${name}: ${n} row(s)`),
    ];
    const totalRows = Object.values(substeps).reduce((a, b) => a + b, 0);
    const warnings = issues.filter((issue) => issue.severity === "warning").length;
    const warningNote = warnings > 0 ? ` — ${warnings} skipped (see ⚠)` : "";
    return {
      step,
      status: "completed",
      // The headline carries just the total; each table's count renders as
      // a nested bullet below the step line.
      summary: totalRows > 0 ? `${label} — ${totalRows} row(s)${warningNote}` : `${label} — nothing to rewrite${warningNote}`,
      issues: [...parts.map((p): StepIssue => ({ severity: "info", message: p })), ...issues],
      data: { substeps, dbPath: destRel },
    };
  } catch (err) {
    // Total surprise (locked db, corrupt page): the BACKUP is the safety
    // net, not this step's exit code. Keep going, say what happened.
    try {
      db.close();
    } catch {
      // already closed
    }
    issues.push({ severity: "warning", message: (err as Error).message });
    return {
      step,
      status: "completed",
      summary: `${label} value migration hit ${(err as Error).message} — left as-is (see ⚠)`,
      issues,
    };
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * UNIQUE indexes containing the given column — the only constraints a
 * 'vellum' → 'cadet' rewrite on that column can violate (the UPDATE
 * changes nothing else, so a collision must involve the column).
 * Expression indexes (null column names in pragma_index_info) and partial
 * indexes are skipped: their semantics don't reduce to plain column
 * equality. The PK autoindex drops out naturally unless the rewritten
 * column IS the key.
 */
function uniqueIndexesOn(
  db: SqliteDatabase,
  table: string,
  column: string,
): string[][] {
  const out: string[][] = [];
  const list = db
    .prepare(`SELECT name, "unique" AS uniq, partial FROM pragma_index_list(?)`)
    .all(table) as Array<{ name: string; uniq: number; partial: number }>;
  for (const idx of list) {
    if (!idx.uniq || idx.partial) continue;
    const cols = (
      db.prepare(`SELECT name FROM pragma_index_info(?)`).all(idx.name) as Array<{
        name: string | null;
      }>
    ).map((c) => c.name);
    if (cols.some((c) => typeof c !== "string")) continue;
    if (!cols.includes(column)) continue;
    out.push(cols as string[]);
  }
  return out;
}

/**
 * Delete the vellum-spelled rows that would collide with an existing
 * cadet-spelled twin on one unique index. `twin.col IS table.col` keeps
 * NULLs equal (SQLite's null-safe comparison). Returns the rows removed.
 */
function dedupeCollidingRows(
  runCounted: (sql: string) => number,
  table: string,
  column: string,
  keyCols: string[],
): number {
  const twinMatch = keyCols
    .filter((k) => k !== column)
    .map((k) => `twin.${k} IS ${table}.${k}`)
    .join(" AND ");
  return runCounted(
    `DELETE FROM ${table} WHERE ${table}.${column} = 'vellum' AND EXISTS (` +
      `SELECT 1 FROM ${table} AS twin WHERE twin.${column} = 'cadet'` +
      (twinMatch ? ` AND ${twinMatch}` : "") +
      `)`,
  );
}

/**
 * Why a db file can't be opened — the classes that produced the v0.0.15
 * field warning: a directory wearing a db's name, a symlink whose target
 * is gone (copied verbatim by an earlier run's layout copy), odd
 * permissions. Read-only probing; never throws.
 */
export async function diagnoseUnreadableDb(absPath: string): Promise<string> {
  const parts: string[] = [];
  try {
    const lstat = await fs.lstat(absPath);
    if (lstat.isSymbolicLink()) {
      const target = await fs.readlink(absPath).catch(() => "?");
      let targetNote = target;
      try {
        await fs.stat(absPath);
      } catch {
        targetNote = `${target} (target missing)`;
      }
      parts.push(`symlink → ${targetNote}`);
    } else if (lstat.isDirectory()) {
      parts.push("it is a directory, not a sqlite file");
    }
    parts.push(`${lstat.size} bytes, mode ${(lstat.mode & 0o777).toString(8).padStart(3, "0")}`);
  } catch {
    parts.push("no longer present on disk");
  }
  return parts.join(", ");
}
