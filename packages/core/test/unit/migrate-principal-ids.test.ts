import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateGatewayDbAt } from "../../src/steps/migrate-assistant-db.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migratePrincipalIds } from "../../src/steps/migrate-principal-ids.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE contacts (principal_id TEXT UNIQUE, role TEXT);
    CREATE TABLE actor_token_records (guardian_principal_id TEXT, status TEXT, token_hash TEXT);
    CREATE TABLE actor_refresh_token_records (guardian_principal_id TEXT, status TEXT, token_hash TEXT);
    CREATE TABLE contact_channels (type TEXT, address TEXT);
    CREATE TABLE guardian_requests (guardian_principal_id TEXT, decided_by_principal_id TEXT, guardian_external_user_id TEXT);
    INSERT INTO contacts VALUES ('vellum-principal-123', 'guardian'), ('cadet-principal-456', 'contact');
    INSERT INTO actor_token_records VALUES ('vellum-principal-123', 'active', 'access-hash');
    INSERT INTO actor_refresh_token_records VALUES ('vellum-principal-123', 'active', 'refresh-hash');
    INSERT INTO contact_channels VALUES ('cadet', 'vellum-principal-123'), ('telegram', 'vellum-principal-123');
    INSERT INTO guardian_requests VALUES ('vellum-principal-123', 'vellum-principal-123', 'vellum-principal-123');
  `);
  return db;
}

test("strips only the legacy prefix, preserves refresh credentials, and is idempotent", () => {
  const db = fixture();
  try {
    assert.deepEqual(migratePrincipalIds(db), { rows: 7, revoked: 1 });
    assert.deepEqual(db.prepare("SELECT principal_id FROM contacts ORDER BY principal_id").all().map((r) => r.principal_id), ['cadet-principal-456', 'principal-123']);
    assert.deepEqual({ ...db.prepare("SELECT * FROM actor_refresh_token_records").get() }, { guardian_principal_id: 'principal-123', status: 'active', token_hash: 'refresh-hash' });
    assert.equal(db.prepare("SELECT status FROM actor_token_records").get()?.status, 'revoked');
    assert.deepEqual(db.prepare("SELECT address FROM contact_channels ORDER BY type").all().map((r) => r.address), ['principal-123', 'vellum-principal-123']);
    assert.deepEqual(migratePrincipalIds(db), { rows: 0, revoked: 0 });
  } finally { db.close(); }
});

test("a uniqueness collision rolls back identity references and token revocation together", () => {
  const db = fixture();
  try {
    db.exec("INSERT INTO contacts VALUES ('principal-123', 'contact')");
    assert.throws(() => migratePrincipalIds(db), /UNIQUE constraint/);
    assert.equal(db.prepare("SELECT status FROM actor_token_records").get()?.status, 'active');
    assert.equal(db.prepare("SELECT guardian_principal_id FROM actor_refresh_token_records").get()?.guardian_principal_id, 'vellum-principal-123');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE principal_id = 'vellum-principal-123'").get()?.n, 1);
  } finally { db.close(); }
});

test("the gateway migration applies the rename and reports access-token recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "principal-migration-"));
  const rel = "gateway-security/gateway.sqlite";
  await fs.mkdir(path.join(root, "gateway-security"));
  const db = new DatabaseSync(path.join(root, rel));
  db.exec(`CREATE TABLE contacts (principal_id TEXT);
    CREATE TABLE actor_token_records (guardian_principal_id TEXT, status TEXT);
    INSERT INTO contacts VALUES ('vellum-principal-123');
    INSERT INTO actor_token_records VALUES ('vellum-principal-123', 'active');`);
  db.close();
  try {
    const result = await migrateGatewayDbAt(root, rel);
    assert.equal(result.status, "completed");
    assert.ok(result.issues?.some((issue) => issue.message.includes("cadet login")));
    const read = new DatabaseSync(path.join(root, rel));
    try { assert.equal(read.prepare("SELECT principal_id FROM contacts").get()?.principal_id, "principal-123"); }
    finally { read.close(); }
    const repeated = await migrateGatewayDbAt(root, rel);
    assert.ok(repeated.summary.includes("nothing to rewrite"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
