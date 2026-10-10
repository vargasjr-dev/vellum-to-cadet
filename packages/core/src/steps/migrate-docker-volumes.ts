import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applySubstitutions,
  isDbArtifact,
  isRewriteEligible,
  sanctionedContentTransform,
  walkTree,
} from "../fs-utils.js";
import { handleToInstanceName } from "../layout.js";
import { migrateAssistantDbAt, migrateGatewayDbAt } from "./migrate-assistant-db.js";
import { scrubLegacyCredentials } from "./scrub-credentials.js";
import { dbVellumRows, VALUE_MIGRATED_DBS } from "./verify.js";
import type { ProcessOps, StepIssue, StepResult } from "../types.js";

/**
 * Docker deployments keep the assistant's real data in docker volumes —
 * the host-side vellum root only carries the CLI's own state. The v0.0.10
 * run feedback: every data step (assistant db, gateway db, credentials)
 * failed against a docker install because the files were never on the
 * host, and verify never looked at the volumes either.
 *
 * This step moves that data for real. Volume names follow the same formula
 * on both sides (vellum 0.12.6 and cadet share the statefulset spec):
 *
 *   <instance>-workspace    → the workspace dir itself (config, data/, …)
 *   <instance>-gateway-sec  → the gateway security dir (db, trust rules, keys)
 *   <instance>-ces-sec      → the CES security dir (encrypted credential store)
 *
 * The vellum volumes are read under the RAW lockfile instance id
 * (`vellum-<name>`); the cadet volumes are written under the migrated
 * name (`<name>`). Extraction and import go through temp containers
 * (`docker create` + `docker cp`), so nothing needs to be running.
 */

/** The three data volumes, vellum-side (raw instance id) and cadet-side (migrated name). */
function dockerVolumes(rawInstanceId: string, migratedName: string) {
  return [
    { kind: "workspace" as const, from: `${rawInstanceId}-workspace`, to: `${migratedName}-workspace` },
    { kind: "gateway-sec" as const, from: `${rawInstanceId}-gateway-sec`, to: `${migratedName}-gateway-sec` },
    { kind: "ces-sec" as const, from: `${rawInstanceId}-ces-sec`, to: `${migratedName}-ces-sec` },
  ];
}

/** State-relative form of a volume-relative path, for the transform matchers. */
function stateRelFor(kind: "workspace" | "gateway-sec" | "ces-sec", rel: string): string {
  if (kind === "workspace") return `workspace/${rel}`;
  if (kind === "gateway-sec") return `protected/${rel}`;
  return `protected/${rel}`;
}

export interface DockerVolumeStepOptions {
  ops: ProcessOps;
  dockerOps: Pick<ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable">;
  /** The lockfile-tracked docker instance ids (raw, vellum-prefixed). */
  instances: ReadonlyArray<string>;
  /** Recorded container images (locally present — the temp containers mount them). */
  images: ReadonlyArray<string>;
  onItem?: (item: { name: string; status: "started" | "completed" | "warning"; summary?: string }) => void;
}

/**
 * Migrate every docker instance's volume data: extract → value-migrate →
 * import into the cadet volumes under the migrated instance name. A docker
 * daemon that is not reachable warns (the migration still completes — the
 * host-root data was migrated; the volumes need a follow-up run) but a
 * failure on one volume records the issue and keeps going: volumes are
 * independent.
 */
export async function migrateDockerVolumes(opts: DockerVolumeStepOptions): Promise<StepResult> {
  const step = "migrate-docker-volumes";
  if (opts.instances.length === 0) {
    return { step, status: "skipped", summary: "no docker-deployed assistants" };
  }
  if (!(await opts.dockerOps.dockerAvailable())) {
    return {
      step,
      status: "completed",
      summary: "docker daemon unreachable — volume data not migrated (see ⚠)",
      issues: [
        {
          severity: "warning",
          message:
            "this is a docker install but `docker info` failed — the assistant dbs, gateway data, and credentials live in docker volumes that were NOT migrated. Start docker and re-run the migrator (it is idempotent).",
        },
      ],
    };
  }

  const issues: StepIssue[] = [];
  const perInstance: string[] = [];
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-volumes-"));

  for (const instanceId of opts.instances) {
    const migratedName = handleToInstanceName(instanceId);
    opts.onItem?.({ name: instanceId, status: "started" });
    const helperImage = opts.images[0];
    try {
      let assistantDb = false;
      let gatewayDb = false;
      let credentials = false;

      for (const vol of dockerVolumes(instanceId, migratedName)) {
        const extractDir = path.join(workRoot, `${instanceId}-${vol.kind}`);
        await fs.mkdir(extractDir, { recursive: true });
        await opts.dockerOps.dockerVolumeToDir(vol.from, extractDir, helperImage);

        if (vol.kind === "workspace") {
          assistantDb = await rewriteExtractedTree(extractDir, "workspace", issues);
        } else if (vol.kind === "gateway-sec") {
          gatewayDb = await rewriteGatewayVolume(extractDir, issues);
        } else {
          credentials = await scrubVolumeCredentials(extractDir, issues);
        }

        await opts.dockerOps.dockerDirToVolume(extractDir, vol.to, helperImage);
      }

      const summary = [
        assistantDb ? "assistant db ✓" : "no assistant db",
        gatewayDb ? "gateway db ✓" : "no gateway db",
        credentials ? "credentials scrubbed" : "no vellum credentials",
      ].join(", ");
      perInstance.push(`${instanceId} → ${migratedName} (${summary})`);
      opts.onItem?.({ name: instanceId, status: "completed", summary });
    } catch (err) {
      const message = (err as Error).message.split("\n")[0];
      issues.push({
        severity: "warning",
        message: `${instanceId}: volume data migration failed (${message}) — start docker and re-run the migrator`,
      });
      opts.onItem?.({ name: instanceId, status: "warning", summary: message });
    }
  }

  return {
    step,
    status: "completed",
    summary: `${opts.instances.length} docker instance(s): volume data migrated into the cadet volumes`,
    issues,
    data: { instances: perInstance },
  };
}

/**
 * Apply the sanctioned content transforms + find and rewrite the assistant
 * db in an extracted workspace volume. Returns true when an assistant db
 * was found (and rewritten).
 */
async function rewriteExtractedTree(
  dir: string,
  prefix: "workspace" | "protected",
  issues: StepIssue[],
): Promise<boolean> {
  let dbRel: string | null = null;
  let entries: Array<{ relPath: string; absPath: string; isDirectory: boolean }>;
  try {
    entries = [...(await walkTree(dir))];
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (isDbArtifact(entry.relPath)) continue;
    const stateRel = `${prefix}/${entry.relPath}`;
    if (!isRewriteEligible(stateRel)) continue;
    try {
      const raw = await fs.readFile(entry.absPath, "utf8");
      const sanctioned = sanctionedContentTransform(stateRel, raw);
      const text = sanctioned ? sanctioned.text : applySubstitutions(raw).text;
      if (text !== raw) await fs.writeFile(entry.absPath, text, "utf8");
    } catch {
      // Binary or unreadable — nothing to rewrite.
    }
  }

  // The assistant db: data/db/assistant.db under the workspace root.
  const candidates = ["data/db/assistant.db", "workspace/data/db/assistant.db"];
  for (const rel of candidates) {
    try {
      await fs.access(path.join(dir, rel));
      dbRel = rel;
      break;
    } catch {
      // Not here.
    }
  }
  if (dbRel) {
    const result = await migrateAssistantDbAt(dir, dbRel);
    issues.push(...(result.issues ?? []));
    return true;
  }
  return false;
}

/**
 * Rewrite the gateway db inside an extracted gateway-security volume
 * (vellum's combined protected dir). Everything else in the volume —
 * trust rules, signing keys, backup key — is security material and stays
 * byte-for-byte. Returns true when a gateway db was found.
 */
async function rewriteGatewayVolume(dir: string, issues: StepIssue[]): Promise<boolean> {
  const candidates = ["gateway.sqlite", "gateway-security/gateway.sqlite", "data/gateway.sqlite"];
  for (const rel of candidates) {
    try {
      await fs.access(path.join(dir, rel));
    } catch {
      continue;
    }
    const result = await migrateGatewayDbAt(dir, rel);
    issues.push(...(result.issues ?? []));
    return true;
  }
  return false;
}

/** Scrub the legacy vellum platform credentials from an extracted CES volume. */
async function scrubVolumeCredentials(dir: string, issues: StepIssue[]): Promise<boolean> {
  const { scrub, issues: scrubIssues } = await scrubLegacyCredentials(dir);
  issues.push(...scrubIssues);
  return scrub.detected;
}

// ---------------------------------------------------------------------------
// verify-docker-volumes — the destination-side check. The main verify step
// only walks the host filesystem; a docker install's real data lives in the
// cadet volumes, so verify must look there too (v0.0.10 run feedback).
// ---------------------------------------------------------------------------

export interface VerifyDockerVolumesOptions {
  ops: ProcessOps;
  dockerOps: Pick<ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable">;
  instances: ReadonlyArray<string>;
  images: ReadonlyArray<string>;
  onItem?: (item: { name: string; status: "started" | "completed" | "warning"; summary?: string }) => void;
}

/**
 * Verify the migrated cadet volumes: re-extract each one and check the dbs
 * are free of vellum rows and the credential store carries no vellum-
 * namespace entries. Findings are warnings — same contract as verify.
 */
export async function verifyDockerVolumes(opts: VerifyDockerVolumesOptions): Promise<StepResult> {
  const step = "verify-docker-volumes";
  if (opts.instances.length === 0) {
    return { step, status: "skipped", summary: "no docker-deployed assistants" };
  }
  if (!(await opts.dockerOps.dockerAvailable())) {
    return {
      step,
      status: "completed",
      summary: "docker daemon unreachable — the cadet volumes could not be verified (see ⚠)",
      issues: [
        { severity: "warning", message: "could not verify the migrated docker volume data: `docker info` failed" },
      ],
    };
  }

  const issues: StepIssue[] = [];
  let dbsChecked = 0;
  let storesChecked = 0;
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-verify-"));
  const helperImage = opts.images[0];

  for (const instanceId of opts.instances) {
    const migratedName = handleToInstanceName(instanceId);
    opts.onItem?.({ name: migratedName, status: "started" });
    try {
      for (const vol of dockerVolumes(instanceId, migratedName)) {
        const extractDir = path.join(workRoot, `${migratedName}-${vol.kind}`);
        await fs.mkdir(extractDir, { recursive: true });
        await opts.dockerOps.dockerVolumeToDir(vol.to, extractDir, helperImage);

        if (vol.kind === "workspace") {
          for (const rel of ["data/db/assistant.db", "workspace/data/db/assistant.db"]) {
            const dbPath = path.join(extractDir, rel);
            if (!(await exists(dbPath))) continue;
            dbsChecked++;
            const leftover = await dbVellumRows(dbPath, VALUE_MIGRATED_DBS[0]!);
            if (leftover === "unreadable") {
              issues.push({ severity: "warning", message: `${vol.to}/${rel} is not a readable sqlite file` });
            } else if (leftover.total > 0) {
              issues.push({
                severity: "warning",
                message: `${vol.to}/${rel} still has ${leftover.total} vellum-branded row(s)`,
              });
            }
            break;
          }
        } else if (vol.kind === "gateway-sec") {
          for (const rel of ["gateway.sqlite", "gateway-security/gateway.sqlite", "data/gateway.sqlite"]) {
            const dbPath = path.join(extractDir, rel);
            if (!(await exists(dbPath))) continue;
            dbsChecked++;
            const leftover = await dbVellumRows(dbPath, VALUE_MIGRATED_DBS[1]!);
            if (leftover === "unreadable") {
              issues.push({ severity: "warning", message: `${vol.to}/${rel} is not a readable sqlite file` });
            } else if (leftover.total > 0) {
              issues.push({
                severity: "warning",
                message: `${vol.to}/${rel} still has ${leftover.total} vellum-branded row(s)`,
              });
            }
            break;
          }
        } else {
          const leftovers = await countVellumCredentials(extractDir);
          if (leftovers > 0) {
            issues.push({
              severity: "warning",
              message: `${vol.to} still holds ${leftovers} vellum-namespace credential entr${leftovers === 1 ? "y" : "ies"}`,
            });
          }
          storesChecked++;
        }
      }
      opts.onItem?.({ name: migratedName, status: "completed", summary: "volume data clean" });
    } catch (err) {
      const message = (err as Error).message.split("\n")[0];
      issues.push({
        severity: "warning",
        message: `${migratedName}: could not verify the volume data (${message})`,
      });
      opts.onItem?.({ name: migratedName, status: "warning", summary: message });
    }
  }

  return {
    step,
    status: "completed",
    summary: `${dbsChecked} volume db(s) free of vellum rows, ${storesChecked} credential store(s) clean`,
    issues,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Count vellum-namespace entries across every keys.enc under a tree. */
async function countVellumCredentials(dir: string): Promise<number> {
  let count = 0;
  let entries: Array<{ absPath: string; relPath: string; isDirectory: boolean }>;
  try {
    entries = [...(await walkTree(dir))];
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (path.basename(entry.relPath) !== "keys.enc") continue;
    try {
      const parsed = JSON.parse(await fs.readFile(entry.absPath, "utf8")) as {
        entries?: Record<string, unknown>;
      };
      if (!parsed?.entries) continue;
      count += Object.keys(parsed.entries).filter((k) => k.startsWith("credential/vellum/")).length;
    } catch {
      // Unreadable — the scrub step already warned about it.
    }
  }
  return count;
}
