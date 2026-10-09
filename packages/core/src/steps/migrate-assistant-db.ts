import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { USER_WORKSPACE_DIR } from "../layout.js";
import type { DetectInfo, StepIssue, StepResult } from "../types.js";

/**
 * Rewrite vellum-branded VALUES inside the migrated assistant SQLite DB.
 * The old product persisted channel ids as `'vellum'` (the desktop client
 * channel), `vellum://` attachment links in message content, and the managed
 * provider connection under the name/provider `vellum`. The renamed product
 * only reads `cadet` spellings, and its own migrations can't heal them (its
 * migration numbering already marks those versions applied — see the
 * provider-connections normalization note below).
 *
 * Every case is an explicit substep, mirroring the old product's own
 * channel-value rename migration (its 144) table-for-table. Each UPDATE is
 * guarded by a table-exists check so older DBs without a table are fine, and
 * only rows still spelling `vellum` are touched (idempotent). Runs on the
 * DESTINATION copy — the vellum root (and its backup) stay byte-identical.
 */

/** Every table+column that stores a channel id, from the old product's own rename migration. */
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

/** State-relative path of the assistant db — how the copy plan addresses it. */
export const ASSISTANT_DB_STATE_REL = `${USER_WORKSPACE_DIR}/data/db/assistant.db`;

export async function migrateAssistantDb(
  detect: DetectInfo,
  /** Destination-relative path of the assistant db, derived from the copy plan. */
  destRel: string | undefined,
): Promise<StepResult> {
  if (!destRel) {
    return {
      step: "migrate-assistant-db",
      status: "skipped",
      summary: "no assistant db in the migrated workspace",
    };
  }
  const dbPath = path.join(detect.cadetRoot, destRel);

  if (!(await fileExists(dbPath))) {
    return {
      step: "migrate-assistant-db",
      status: "skipped",
      summary: "no assistant db in the migrated workspace",
    };
  }

  let db: Database;
  try {
    // Opening recovers/checkpoints any copied -wal sidecar.
    db = new Database(dbPath);
  } catch (err) {
    return {
      step: "migrate-assistant-db",
      status: "skipped",
      summary: `assistant db is not a readable sqlite file — left verbatim (${(err as Error).message})`,
    };
  }

  try {
    const substeps: Record<string, number> = {};
    const tableExists = (name: string): boolean =>
      !!db
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(name);
    const runCounted = (sql: string): number => {
      db.run(sql);
      const row = db.query(`SELECT changes() AS c`).get() as { c: number } | null;
      return row?.c ?? 0;
    };

    // "channel values": every channel-id column, 'vellum' → 'cadet'.
    let channelRows = 0;
    for (const { table, column } of CHANNEL_COLUMNS) {
      if (!tableExists(table)) continue;
      channelRows += runCounted(
        `UPDATE ${table} SET ${column} = 'cadet' WHERE ${column} = 'vellum'`,
      );
    }
    if (tableExists("messages")) {
      // Message metadata records channel refs as JSON string values.
      channelRows += runCounted(
        `UPDATE messages SET metadata = REPLACE(metadata, '"vellum"', '"cadet"')
         WHERE metadata LIKE '%"vellum"%'`,
      );
    }
    substeps["channel values"] = channelRows;

    // "attachment links": vellum:// attachment URIs in message content.
    let linkRows = 0;
    if (tableExists("messages")) {
      linkRows += runCounted(
        `UPDATE messages SET content = REPLACE(content, 'vellum://', 'cadet://')
         WHERE content LIKE '%vellum://%'`,
      );
    }
    substeps["attachment links"] = linkRows;

    // "provider connections": the managed platform connection was named and
    // typed `vellum`. The renamed product's own normalizer can't revisit it
    // (its migration version is already marked applied), so the rename is
    // ours. The name only moves when `cadet` is free (a re-seeded cadet row
    // would make the PK collide).
    let connectionRows = 0;
    if (tableExists("provider_connections")) {
      connectionRows += runCounted(
        `UPDATE provider_connections SET provider = 'cadet' WHERE provider = 'vellum'`,
      );
      connectionRows += runCounted(
        `UPDATE provider_connections SET name = 'cadet'
         WHERE name = 'vellum'
           AND NOT EXISTS (SELECT 1 FROM provider_connections WHERE name = 'cadet')`,
      );
    }
    substeps["provider connections"] = connectionRows;

    db.close();

    const parts = Object.entries(substeps)
      .filter(([, n]) => n > 0)
      .map(([name, n]) => `${name}: ${n} row(s)`);
    return {
      step: "migrate-assistant-db",
      status: "completed",
      summary: parts.length > 0 ? `assistant db — ${parts.join(", ")}` : "assistant db — nothing to rewrite",
      data: { substeps, dbPath: destRel },
    };
  } catch (err) {
    const issues: StepIssue[] = [
      { severity: "error", message: `assistant db value migration failed: ${(err as Error).message}` },
    ];
    try {
      db.close();
    } catch {
      // already closed
    }
    return {
      step: "migrate-assistant-db",
      status: "failed",
      summary: `assistant db value migration failed: ${(err as Error).message}`,
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
