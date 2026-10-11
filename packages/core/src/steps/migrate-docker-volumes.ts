import { promises as fs } from "node:fs";
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
import { dbVellumRows, VALUE_MIGRATED_DBS } from "./verify.js";
import type { ProcessOps, StepIssue, StepResult } from "../types.js";

/**
 * Docker deployments keep the assistant's real data in docker volumes —
 * the host-side vellum root only carries the CLI's own state. The flow is
 * split so the SAME value steps run for local and docker installs — only
 * the data surface differs (v0.0.11 run feedback: once detect said docker,
 * the host-path db steps still ran first and failed, because the files
 * were never on the host):
 *
 *   fetch-docker-volumes  — extract each instance's three volumes into a
 *                           scratch tree and apply the workspace content
 *                           transforms in place (the copy-phase analog)
 *   migrate-assistant-db / migrate-gateway-db / migrate-credentials —
 *                           the same steps as the local flow, pointed at
 *                           the extracted trees
 *   load-docker-volumes   — import the migrated trees into the cadet
 *                           volumes under the migrated instance name
 *
 * Volume names follow the same formula on both sides (vellum 0.12.6 and
 * cadet share the statefulset spec):
 *
 *   <instance>-workspace    → the workspace dir itself (config, data/, …)
 *   <instance>-gateway-sec  → the gateway security dir (db, trust rules, keys)
 *   <instance>-ces-sec      → the CES security dir (encrypted credential store)
 *
 * The vellum volumes are read under the RAW lockfile instance id
 * (`vellum-<name>`); the cadet volumes are written under the migrated
 * name (`<name>`).
 */

/** The three data volumes, vellum-side (raw instance id) and cadet-side (migrated name). */
function dockerVolumes(rawInstanceId: string, migratedName: string) {
  return [
    { kind: "workspace" as const, from: `${rawInstanceId}-workspace`, to: `${migratedName}-workspace` },
    { kind: "gateway-sec" as const, from: `${rawInstanceId}-gateway-sec`, to: `${migratedName}-gateway-sec` },
    { kind: "ces-sec" as const, from: `${rawInstanceId}-ces-sec`, to: `${migratedName}-ces-sec` },
  ];
}

/** Where fetch-docker-volumes puts a volume's tree for an instance. */
function extractedDir(
  workRoot: string,
  instanceId: string,
  kind: "workspace" | "gateway-sec" | "ces-sec",
): string {
  return path.join(workRoot, instanceId, kind);
}

/** Candidate assistant-db locations inside an extracted workspace volume. */
const ASSISTANT_DB_CANDIDATES = ["data/db/assistant.db", "workspace/data/db/assistant.db"];

/** Candidate gateway-db locations inside an extracted gateway-security volume. */
const GATEWAY_DB_CANDIDATES = ["gateway.sqlite", "gateway-security/gateway.sqlite", "data/gateway.sqlite"];

export type VolumeKind = "workspace" | "gateway-sec" | "ces-sec";

export interface DockerVolumeFlowOptions {
  dockerOps: Pick<ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable">;
  /** The lockfile-tracked docker instance ids (raw, vellum-prefixed). */
  instances: ReadonlyArray<string>;
  /** Recorded container images (locally present — the tar helper containers mount them). */
  images: ReadonlyArray<string>;
  /** Scratch root the extracted trees live under. */
  workRoot: string;
  onItem?: (item: { name: string; status: "started" | "completed" | "warning"; summary?: string }) => void;
}

/** The docker daemon unreachable warning, word-for-word in fetch and load. */
function unreachableIssue(): StepIssue {
  return {
    severity: "warning",
    message:
      "this is a docker install but `docker info` failed — the assistant dbs, gateway data, and credentials live in docker volumes that were NOT migrated. Start docker and re-run the migrator (it is idempotent).",
  };
}

/**
 * Extract every docker instance's three volumes into the scratch tree and
 * apply the workspace content transforms in place — the docker analog of
 * the copy phase, so the value steps that follow (dbs, credentials,
 * verify) run over these trees exactly as they run over host directories.
 */
export async function fetchDockerVolumes(opts: DockerVolumeFlowOptions): Promise<StepResult> {
  const step = "fetch-docker-volumes";
  if (opts.instances.length === 0) {
    return { step, status: "skipped", summary: "no docker-deployed assistants" };
  }
  if (!(await opts.dockerOps.dockerAvailable())) {
    return {
      step,
      status: "completed",
      summary: "docker daemon unreachable — volume data not fetched (see ⚠)",
      issues: [unreachableIssue()],
    };
  }

  const issues: StepIssue[] = [];
  const perInstance: string[] = [];
  for (const instanceId of opts.instances) {
    const migratedName = handleToInstanceName(instanceId);
    opts.onItem?.({ name: instanceId, status: "started" });
    try {
      let rewrittenFiles = 0;
      const extracted: string[] = [];
      for (const vol of dockerVolumes(instanceId, migratedName)) {
        const extractDir = extractedDir(opts.workRoot, instanceId, vol.kind);
        await fs.mkdir(extractDir, { recursive: true });
        await opts.dockerOps.dockerVolumeToDir(vol.from, extractDir, opts.images[0]);
        extracted.push(vol.kind);
        if (vol.kind === "workspace") {
          rewrittenFiles += await applyWorkspaceContentTransforms(extractDir);
        }
      }
      const summary = `${extracted.length} volume(s) extracted${rewrittenFiles > 0 ? `, ${rewrittenFiles} file(s) rewritten` : ""}`;
      perInstance.push(`${instanceId} → ${migratedName}: ${summary}`);
      opts.onItem?.({ name: instanceId, status: "completed", summary });
    } catch (err) {
      const message = (err as Error).message.split("\n")[0];
      issues.push({
        severity: "warning",
        message: `${instanceId}: volume extraction failed (${message}) — start docker and re-run the migrator`,
      });
      opts.onItem?.({ name: instanceId, status: "warning", summary: message });
    }
  }

  return {
    step,
    status: "completed",
    summary: `extracted the volume data of ${opts.instances.length} docker instance(s) into the scratch tree`,
    issues,
    data: { instances: perInstance },
  };
}

/**
 * Apply the sanctioned content transforms to an extracted workspace volume
 * — the same matchers the local flow's copy phase runs, over
 * volume-relative paths normalized to workspace/-prefixed state-relative
 * ones. Returns the number of files rewritten.
 */
async function applyWorkspaceContentTransforms(dir: string): Promise<number> {
  let entries: Array<{ relPath: string; absPath: string; isDirectory: boolean }>;
  try {
    entries = [...(await walkTree(dir))];
  } catch {
    return 0;
  }

  let rewritten = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (isDbArtifact(entry.relPath)) continue;
    const stateRel = `workspace/${entry.relPath}`;
    if (!isRewriteEligible(stateRel)) continue;
    try {
      const raw = await fs.readFile(entry.absPath, "utf8");
      const sanctioned = sanctionedContentTransform(stateRel, raw);
      const text = sanctioned ? sanctioned.text : applySubstitutions(raw).text;
      if (text !== raw) {
        await fs.writeFile(entry.absPath, text, "utf8");
        rewritten++;
      }
    } catch {
      // Binary or unreadable — nothing to rewrite.
    }
  }
  return rewritten;
}

/**
 * The shared migrate-assistant-db step, docker form: value-migrate every
 * extracted workspace volume's assistant db in place. Same step name and
 * engine as the local flow — only the data surface differs.
 */
export async function migrateDockerAssistantDbs(
  instances: ReadonlyArray<string>,
  workRoot: string,
  onItem?: (item: { name: string; status: "started" | "completed" | "warning"; summary?: string }) => void,
): Promise<StepResult> {
  const step = "migrate-assistant-db";
  if (instances.length === 0) {
    return { step, status: "skipped", summary: "no docker-deployed assistants" };
  }
  const issues: StepIssue[] = [];
  const perInstance: string[] = [];
  let migrated = 0;
  for (const instanceId of instances) {
    const dir = extractedDir(workRoot, instanceId, "workspace");
    onItem?.({ name: instanceId, status: "started" });
    const rel = await findFirst(dir, ASSISTANT_DB_CANDIDATES);
    const result = await migrateAssistantDbAt(dir, rel);
    issues.push(...(result.issues ?? []));
    if (result.status !== "skipped") migrated++;
    perInstance.push(`${handleToInstanceName(instanceId)}: ${result.summary}`);
    onItem?.({ name: instanceId, status: "completed", summary: result.summary });
  }
  return {
    step,
    status: migrated > 0 ? "completed" : "skipped",
    summary:
      migrated > 0
        ? `assistant db(s) value-migrated across ${migrated} extracted workspace volume(s)`
        : "no assistant db(s) in the extracted workspace volume(s)",
    issues,
    data: { instances: perInstance },
  };
}

/**
 * The shared migrate-gateway-db step, docker form: same engine, pointed at
 * the extracted gateway-security trees.
 */
export async function migrateDockerGatewayDbs(
  instances: ReadonlyArray<string>,
  workRoot: string,
  onItem?: (item: { name: string; status: "started" | "completed" | "warning"; summary?: string }) => void,
): Promise<StepResult> {
  const step = "migrate-gateway-db";
  if (instances.length === 0) {
    return { step, status: "skipped", summary: "no docker-deployed assistants" };
  }
  const issues: StepIssue[] = [];
  const perInstance: string[] = [];
  let migrated = 0;
  for (const instanceId of instances) {
    const dir = extractedDir(workRoot, instanceId, "gateway-sec");
    onItem?.({ name: instanceId, status: "started" });
    const rel = await findFirst(dir, GATEWAY_DB_CANDIDATES);
    const result = await migrateGatewayDbAt(dir, rel);
    issues.push(...(result.issues ?? []));
    if (result.status !== "skipped") migrated++;
    perInstance.push(`${handleToInstanceName(instanceId)}: ${result.summary}`);
    onItem?.({ name: instanceId, status: "completed", summary: result.summary });
  }
  return {
    step,
    status: migrated > 0 ? "completed" : "skipped",
    summary:
      migrated > 0
        ? `gateway db(s) value-migrated across ${migrated} extracted gateway volume(s)`
        : "no gateway db(s) in the extracted gateway volume(s)",
    issues,
    data: { instances: perInstance },
  };
}

/**
 * Import the migrated trees into the cadet volumes under the migrated
 * instance names. Failures on one volume record the issue and keep going:
 * volumes are independent.
 */
export async function loadDockerVolumes(opts: DockerVolumeFlowOptions): Promise<StepResult> {
  const step = "load-docker-volumes";
  if (opts.instances.length === 0) {
    return { step, status: "skipped", summary: "no docker-deployed assistants" };
  }
  if (!(await opts.dockerOps.dockerAvailable())) {
    return {
      step,
      status: "completed",
      summary: "docker daemon unreachable — the migrated volume data was NOT imported (see ⚠)",
      issues: [unreachableIssue()],
    };
  }

  const issues: StepIssue[] = [];
  const perInstance: string[] = [];
  for (const instanceId of opts.instances) {
    const migratedName = handleToInstanceName(instanceId);
    opts.onItem?.({ name: instanceId, status: "started" });
    try {
      let loaded = 0;
      for (const vol of dockerVolumes(instanceId, migratedName)) {
        const extractDir = extractedDir(opts.workRoot, instanceId, vol.kind);
        if (!(await exists(extractDir))) continue; // fetch failed for this kind — already warned
        await opts.dockerOps.dockerDirToVolume(extractDir, vol.to, opts.images[0]);
        loaded++;
      }
      const summary = `${loaded} cadet volume(s) written`;
      perInstance.push(`${instanceId} → ${migratedName}: ${summary}`);
      opts.onItem?.({ name: instanceId, status: "completed", summary });
    } catch (err) {
      const message = (err as Error).message.split("\n")[0];
      issues.push({
        severity: "warning",
        message: `${instanceId}: volume import failed (${message}) — start docker and re-run the migrator`,
      });
      opts.onItem?.({ name: instanceId, status: "warning", summary: message });
    }
  }

  return {
    step,
    status: "completed",
    summary: `imported the migrated data into ${opts.instances.length} docker instance(s)' cadet volumes`,
    issues,
    data: { instances: perInstance },
  };
}

// ---------------------------------------------------------------------------
// verify — the docker half. The extracted trees ARE what load wrote into
// the cadet volumes (a byte copy), so checking them here is checking the
// migrated volume data — without a second extraction pass. The runner
// folds these findings into the shared verify step's result.
// ---------------------------------------------------------------------------

export interface DockerVolumeVerify {
  issues: StepIssue[];
  dbsChecked: number;
  storesChecked: number;
}

/**
 * Verify the extracted volume trees: dbs free of vellum rows, credential
 * store carrying no vellum-namespace entries. Findings are warnings — same
 * contract as verify.
 */
export async function verifyDockerVolumeData(
  instances: ReadonlyArray<string>,
  workRoot: string,
): Promise<DockerVolumeVerify> {
  const issues: StepIssue[] = [];
  let dbsChecked = 0;
  let storesChecked = 0;

  for (const instanceId of instances) {
    const migratedName = handleToInstanceName(instanceId);

    const workspaceDir = extractedDir(workRoot, instanceId, "workspace");
    const assistantRel = await findFirst(workspaceDir, ASSISTANT_DB_CANDIDATES);
    if (assistantRel) {
      dbsChecked++;
      issues.push(
        ...(await dbIssues(
          path.join(workspaceDir, assistantRel),
          `${migratedName}-workspace/${assistantRel}`,
          VALUE_MIGRATED_DBS[0]!,
        )),
      );
    }

    const gatewayDir = extractedDir(workRoot, instanceId, "gateway-sec");
    const gatewayRel = await findFirst(gatewayDir, GATEWAY_DB_CANDIDATES);
    if (gatewayRel) {
      dbsChecked++;
      issues.push(
        ...(await dbIssues(
          path.join(gatewayDir, gatewayRel),
          `${migratedName}-gateway-sec/${gatewayRel}`,
          VALUE_MIGRATED_DBS[1]!,
        )),
      );
    }

    const cesDir = extractedDir(workRoot, instanceId, "ces-sec");
    if (await exists(cesDir)) {
      storesChecked++;
      const leftovers = await countVellumCredentials(cesDir);
      if (leftovers > 0) {
        issues.push({
          severity: "warning",
          message: `${migratedName}-ces-sec still holds ${leftovers} vellum-namespace credential entr${leftovers === 1 ? "y" : "ies"}`,
        });
      }
    }
  }

  return { issues, dbsChecked, storesChecked };
}

type ValueMigratedDb = (typeof VALUE_MIGRATED_DBS)[number];

/** The leftover-row check for one volume db, worded against the volume name. */
async function dbIssues(dbPath: string, label: string, spec: ValueMigratedDb): Promise<StepIssue[]> {
  const leftover = await dbVellumRows(dbPath, spec);
  if (leftover === "unreadable") {
    return [{ severity: "warning", message: `${label} is not a readable sqlite file` }];
  }
  if (leftover.total > 0) {
    return [{ severity: "warning", message: `${label} still has ${leftover.total} vellum-branded row(s)` }];
  }
  return [];
}

async function findFirst(dir: string, candidates: ReadonlyArray<string>): Promise<string | undefined> {
  for (const rel of candidates) {
    if (await exists(path.join(dir, rel))) return rel;
  }
  return undefined;
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
