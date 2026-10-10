import { promises as fs } from "node:fs";
import * as path from "node:path";

import { walkTree } from "../fs-utils.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * Legacy vellum platform credentials — the cloud api key and webhook secret
 * the migrated assistants still hold — must not survive the migration: we
 * can't keep them, and `cadet login` establishes fresh cloud credentials
 * instead (the login step runs later, before the assistants wake).
 *
 * The encrypted credential store (keys.enc) records its ENTRY NAMES in
 * plaintext — only the values are sealed ({version, entries: {key:
 * {iv, tag, data}}}) — so the migration deletes the vellum-namespace
 * entries structurally, without decrypting anything and without touching
 * any other stored credential. The CES vault copy (ces-data/) is sealed
 * behind the credential-executor's own encryption and is NOT touched here;
 * the cadet CLI's credential injection deletes vellum:* vault keys at the
 * next login, so the two sides meet.
 */

/** The vault-key namespace every vellum cloud credential lives under. */
const VELLUM_CREDENTIAL_PREFIX = "credential/vellum/";

export interface CredentialScrub {
  storesScrubbed: number;
  entriesRemoved: number;
  /** True when any vellum-namespace credential was found (and removed). */
  detected: boolean;
}

/** Walk the live cadet tree (never the retired cold storage) for keys.enc. */
export async function scrubLegacyCredentials(cadetRoot: string): Promise<{
  scrub: CredentialScrub;
  issues: StepIssue[];
}> {
  const scrub: CredentialScrub = { storesScrubbed: 0, entriesRemoved: 0, detected: false };
  const issues: StepIssue[] = [];
  let tree;
  try {
    tree = await walkTree(cadetRoot);
  } catch {
    return { scrub, issues };
  }

  for (const entry of tree) {
    if (entry.isDirectory) continue;
    const segments = entry.relPath.split("/");
    if (segments.includes("retired")) continue; // Cold storage keeps its copy.
    if (segments[segments.length - 1] !== "keys.enc") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(entry.absPath, "utf8"));
    } catch (err) {
      issues.push({
        severity: "warning",
        message: `${entry.relPath}: not readable JSON (${(err as Error).message}) — left as-is`,
      });
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).entries !== "object" ||
      (parsed as Record<string, unknown>).entries === null
    ) {
      continue; // Not the expected store shape — leave it alone.
    }
    const entries = (parsed as Record<string, unknown>).entries as Record<string, unknown>;

    let removed = 0;
    for (const key of Object.keys(entries)) {
      if (key.startsWith(VELLUM_CREDENTIAL_PREFIX)) {
        delete entries[key];
        removed++;
      }
    }
    if (removed === 0) continue;
    try {
      await fs.writeFile(entry.absPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      scrub.storesScrubbed++;
      scrub.entriesRemoved += removed;
      scrub.detected = true;
    } catch (err) {
      issues.push({
        severity: "warning",
        message: `${entry.relPath}: could not rewrite (${(err as Error).message}) — the vellum credentials are still in it`,
      });
    }
  }
  return { scrub, issues };
}

/** The migrate-credentials step: detect + remove legacy platform credentials. */
export async function migrateCredentialsStep(cadetRoot: string): Promise<StepResult> {
  const { scrub, issues } = await scrubLegacyCredentials(cadetRoot);
  if (!scrub.detected) {
    return {
      step: "migrate-credentials",
      status: issues.length > 0 ? "completed" : "skipped",
      summary:
        issues.length > 0
          ? "legacy vellum platform credentials not found in the readable stores (see ⚠)"
          : "no legacy vellum platform credentials found",
      issues,
      data: { ...scrub },
    };
  }
  return {
    step: "migrate-credentials",
    status: "completed",
    summary: `removed ${scrub.entriesRemoved} legacy vellum platform credential(s) from ${scrub.storesScrubbed} encrypted store(s) — \`cadet login\` issues fresh ones`,
    issues,
    data: { ...scrub },
  };
}
