import type { SqliteDatabase } from "../sqlite.js";

const PRINCIPAL_COLUMNS = new Set([
  "principal_id", "guardian_principal_id", "decided_by_principal_id", "actor_principal_id",
  "guardian_external_user_id", "decided_by_external_user_id", "requester_external_user_id",
]);

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Rewrite identity references together; signed access tokens cannot be rewritten. */
export function migratePrincipalIds(db: SqliteDatabase): { rows: number; revoked: number } {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  let rows = 0;
  let revoked = 0;
  db.exec("SAVEPOINT migrate_principal_ids");
  try {
    for (const { name } of tables) {
      const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      const update = (sql: string): number => {
        db.exec(sql);
        return (db.prepare("SELECT changes() AS n").get() as { n: number }).n;
      };
      if (name === "actor_token_records" && names.has("guardian_principal_id") && names.has("status")) {
        // The JWT still names the old principal. Opaque refresh tokens remain
        // usable and mint a correctly named access token on the next rotation.
        revoked += update(`UPDATE actor_token_records SET status = 'revoked' WHERE guardian_principal_id GLOB 'vellum-principal-*' AND status != 'revoked'`);
      }
      for (const column of names) {
        if (!PRINCIPAL_COLUMNS.has(column)) continue;
        rows += update(`UPDATE ${quoted(name)} SET ${quoted(column)} = substr(${quoted(column)}, 8) WHERE ${quoted(column)} GLOB 'vellum-principal-*'`);
      }
      // The desktop channel uses the principal as its synthetic address;
      // other providers' external addresses must remain untouched.
      if (name === "contact_channels" && names.has("address") && names.has("type")) {
        rows += update(`UPDATE contact_channels SET address = substr(address, 8) WHERE type IN ('vellum', 'cadet') AND address GLOB 'vellum-principal-*'`);
      }
    }
    db.exec("RELEASE SAVEPOINT migrate_principal_ids");
    return { rows, revoked };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT migrate_principal_ids");
    db.exec("RELEASE SAVEPOINT migrate_principal_ids");
    throw error;
  }
}
