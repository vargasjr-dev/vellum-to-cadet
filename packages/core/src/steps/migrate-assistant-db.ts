import { promises as fs } from "node:fs";
import * as path from "node:path";

import { USER_WORKSPACE_DIR } from "../layout.js";
import { openSqliteDatabase, type SqliteDatabase } from "../sqlite.js";
import type { DetectInfo, StepIssue, StepResult } from "../types.js";

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

export async function migrateAssistantDb(
  detect: DetectInfo,
  /** Destination-relative path of the assistant db, derived from the copy plan. */
  destRel: string | undefined,
): Promise<StepResult> {
  return migrateAssistantDbAt(detect.cadetRoot, destRel);
}

/** Repair-mode entry: same step, aimed at an already-migrated cadet root. */
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
  return migrateDbValues({
    cadetRoot,
    destRel,
    step: "migrate-assistant-db",
    label: "assistant db",
    columns: CHANNEL_COLUMNS,
    rewriteMessages: true,
    rewriteConnections: true,
  });
}

export async function migrateGatewayDb(
  detect: DetectInfo,
  /** Destination-relative path of the gateway db, derived from the copy plan. */
  destRel: string | undefined,
): Promise<StepResult> {
  return migrateGatewayDbAt(detect.cadetRoot, destRel);
}

/** Repair-mode entry: same step, aimed at an already-migrated cadet root. */
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
  return migrateDbValues({
    cadetRoot,
    destRel,
    step: "migrate-gateway-db",
    label: "gateway db",
    columns: GATEWAY_CHANNEL_COLUMNS,
  });
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
    return {
      step,
      status: "skipped",
      summary: `${label} is not a readable sqlite file — left verbatim (${(err as Error).message})`,
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
    for (const { table, column } of columns) {
      if (!tableExists(table)) continue;
      if (!columnExists(table, column)) continue;
      try {
        channelRows += runCounted(
          `UPDATE ${table} SET ${column} = 'cadet' WHERE ${column} = 'vellum'`,
        );
      } catch (err) {
        note(`${table}.${column}`, err);
      }
    }
    if (options.rewriteMessages && tableExists("messages") && columnExists("messages", "metadata")) {
      // Message metadata records channel refs as JSON string values.
      try {
        channelRows += runCounted(
          `UPDATE messages SET metadata = REPLACE(metadata, '"vellum"', '"cadet"')
           WHERE metadata LIKE '%"vellum"%'`,
        );
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

    db.close();

    const parts = Object.entries(substeps)
      .filter(([, n]) => n > 0)
      .map(([name, n]) => `${name}: ${n} row(s)`);
    const warningNote = issues.length > 0 ? ` — ${issues.length} skipped (see ⚠)` : "";
    return {
      step,
      status: "completed",
      summary: parts.length > 0
        ? `${label} — ${parts.join(", ")}${warningNote}`
        : `${label} — nothing to rewrite${warningNote}`,
      issues,
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
