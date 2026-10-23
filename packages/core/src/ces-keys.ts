/**
 * Offline reader for the vellum-era encrypted credential store (the "CES
 * file"). The migrator must never need the vellum daemon to learn the
 * migrated assistants' cloud identity: `keys.enc` is
 * `{version, entries: {name: {iv, tag, data}}}` with hex-encoded AES-256-GCM
 * material, and the sealing key sits BESIDE it as a 32-byte `store.key` file
 * (the "CES token") — v2 stores use that key directly, no derivation.
 * Legacy v1 stores derive the key from machine entropy via PBKDF2, which
 * only resolves when this code runs on the very machine the store was
 * sealed on — the migrator always does.
 *
 * Corrupt entries are skipped (matching the vellum store's own tolerance):
 * a half-readable store still yields the entries that decrypt cleanly.
 */

import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname, userInfo } from "node:os";
import * as path from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
/** The vellum store's production PBKDF2 iteration count. */
const PBKDF2_ITERATIONS = 100_000;

export interface CesEncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

interface CesStoreFile {
  version: number;
  salt?: string;
  entries: Record<string, unknown>;
}

/**
 * The vellum store's exact v1 entropy recipe (deprecated there, kept here
 * only so legacy stores that never migrated to v2 still read).
 */
function machineEntropy(): string {
  const parts: string[] = [];
  try {
    parts.push(hostname());
  } catch {
    parts.push("unknown-host");
  }
  try {
    parts.push(userInfo().username);
  } catch {
    parts.push("unknown-user");
  }
  parts.push(process.platform);
  parts.push(process.arch);
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

function deriveV1Key(saltHex: string): Buffer {
  return pbkdf2Sync(
    machineEntropy(),
    Buffer.from(saltHex, "hex"),
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha512",
  );
}

/** Decrypt one entry with the resolved store key. Throws when tampered. */
export function decryptCesEntry(entry: CesEncryptedEntry, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(entry.iv, "hex"),
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(entry.data, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf-8");
}

/**
 * Read + decrypt every entry of the store in `protectedDir` (the directory
 * holding `keys.enc` and its sibling `store.key`). Returns the decrypted
 * entries keyed by their store names, or an `error` describing why the
 * store could not be read at all (per-entry corruption is skipped, not
 * fatal).
 */
export async function readCesStore(
  protectedDir: string,
): Promise<{ entries: Record<string, string> } | { error: string }> {
  const keysEncPath = path.join(protectedDir, "keys.enc");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(keysEncPath, "utf8"));
  } catch (err) {
    return { error: `${keysEncPath}: could not be read (${(err as Error).message})` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: `${keysEncPath}: not a credential store` };
  }
  const store = parsed as CesStoreFile;
  if (
    typeof store.version !== "number" ||
    typeof store.entries !== "object" ||
    store.entries === null
  ) {
    return { error: `${keysEncPath}: not a credential store` };
  }

  let key: Buffer | null = null;
  if (store.version === 2) {
    try {
      const raw = await fs.readFile(path.join(protectedDir, "store.key"));
      if (raw.length === KEY_LENGTH) key = raw;
    } catch {
      key = null;
    }
    if (!key) {
      return {
        error: `${keysEncPath}: its store.key (the CES token) is missing or the wrong size — the entries cannot be decrypted offline`,
      };
    }
  } else if (store.version === 1 && typeof store.salt === "string") {
    key = deriveV1Key(store.salt);
  } else {
    return {
      error: `${keysEncPath}: unsupported store version ${String(store.version)}`,
    };
  }

  const entries: Record<string, string> = {};
  for (const [name, raw] of Object.entries(store.entries)) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as CesEncryptedEntry).iv !== "string" ||
      typeof (raw as CesEncryptedEntry).tag !== "string" ||
      typeof (raw as CesEncryptedEntry).data !== "string"
    ) {
      continue;
    }
    try {
      entries[name] = decryptCesEntry(raw as CesEncryptedEntry, key);
    } catch {
      // Corrupt/tampered entry — the vellum store skips these too.
    }
  }
  return { entries };
}
