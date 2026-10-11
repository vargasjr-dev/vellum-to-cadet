import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  applySubstitutions,
  formatBytes,
  isDbArtifact,
  isRewriteEligible,
  sanctionedContentTransform,
  walkTree,
} from "../fs-utils.js";
import { handleToInstanceName } from "../layout.js";
import { displayDbRel, findStateDbs } from "./migrate-assistant-db.js";
import { dbVellumRows, VALUE_MIGRATED_DBS } from "./verify.js";
import type { ProcessOps, StepIssue, StepItemEvent, StepResult } from "../types.js";

/**
 * Docker deployments keep the assistant's real data in docker volumes —
 * the host-side vellum root only carries the CLI's own state. The flow is
 * two BRACKETS around the same value steps the local flow runs (v0.0.11
 * run feedback: once detect said docker, the host-path db steps still ran
 * first and failed, because the files were never on the host):
 *
 *   fetch-docker-volumes  — extract each instance's three volumes into a
 *                           STATE-SHAPED scratch tree: one state root per
 *                           assistant, <scratch>/<instance>/workspace,
 *                           …/gateway-security, …/ces-security — the same
 *                           layout the copied cadet root carries, so the
 *                           value steps' discovery (findStateDbs) runs
 *                           unchanged against either surface
 *   value steps           — the shared migrate-assistant-db /
 *                           migrate-gateway-db / migrate-credentials steps,
 *                           pointed at the scratch root; zero
 *                           docker-awareness in any of them
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
    { kind: "workspace" as const, stateDir: "workspace", from: `${rawInstanceId}-workspace`, to: `${migratedName}-workspace` },
    { kind: "gateway-sec" as const, stateDir: "gateway-security", from: `${rawInstanceId}-gateway-sec`, to: `${migratedName}-gateway-sec` },
    { kind: "ces-sec" as const, stateDir: "ces-security", from: `${rawInstanceId}-ces-sec`, to: `${migratedName}-ces-sec` },
  ];
}

/** The three vellum-side volume names for one instance — preflight's disk guard measures these. */
export function vellumVolumeNames(rawInstanceId: string): string[] {
  return dockerVolumes(rawInstanceId, "").map((vol) => vol.from);
}

/**
 * The runtime (non-data) volumes cadet's docker hatch creates EMPTY — the
 * bootstrap/ipc socket dirs. Vellum's hatch never created them, so the
 * migrated install gets them pre-created at load time (v0.0.15 field
 * feedback: `docker volume ls` showed only the three data volumes). The
 * K8s-spec-only `-ces-data` is deliberately NOT here: the docker runtime
 * auto-creates it on the credential-executor's first boot, same as cadet's
 * own hatch; `-dockerd-data` was the removed docker-in-docker volume.
 */
export function runtimeVolumeNames(migratedName: string): string[] {
  return [`${migratedName}-socket`, `${migratedName}-assistant-ipc`, `${migratedName}-gateway-ipc`];
}

/** Compact duration for step summaries: 38s / 3m 12s / 1h 2m 3s. */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

/** Where fetch-docker-volumes materializes a volume inside the instance's state-shaped scratch tree. */
function extractedDir(workRoot: string, instanceId: string, stateDir: string): string {
  return path.join(workRoot, instanceId, stateDir);
}

export type VolumeKind = "workspace" | "gateway-sec" | "ces-sec";

export interface DockerVolumeFlowOptions {
  dockerOps: Pick<ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable" | "dockerVolumeCreate">;
  /** The lockfile-tracked docker instance ids (raw, vellum-prefixed). */
  instances: ReadonlyArray<string>;
  /** Recorded container images (locally present — the tar helper containers mount them). */
  images: ReadonlyArray<string>;
  /** Scratch root the extracted trees live under. */
  workRoot: string;
  onItem?: (item: StepItemEvent) => void;
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
  let failedInstances = 0;
  for (const instanceId of opts.instances) {
    const migratedName = handleToInstanceName(instanceId);
    opts.onItem?.({ name: instanceId, status: "started" });
    const startedAt = Date.now();
    try {
      let rewrittenFiles = 0;
      const vols = dockerVolumes(instanceId, migratedName);
      // The three volumes stream CONCURRENTLY (measured on the real
      // machine: one tar stream saturates ~0.2GB/s and the wall clock is
      // per-stream; parallel streams overlap the VM's CPU with socket
      // transfers). Each stream taps its own bytes; the item events carry
      // ONE aggregated counter — per-kind labels would fight over the
      // single nested line (v0.0.15 field feedback: two-decimal GB
      // progress for the multi-GB wait).
      const bytesByKind = new Map<string, number>();
      const totalsByKind = new Map<string, number>();
      const onVolumeProgress = (kind: string) => (bytes: number, totalBytes?: number) => {
        bytesByKind.set(kind, bytes);
        if (typeof totalBytes === "number") totalsByKind.set(kind, totalBytes);
        const sum = [...bytesByKind.values()].reduce((a, b) => a + b, 0);
        const progress: StepItemEvent["progress"] = { bytes: sum, label: "volumes" };
        if (totalsByKind.size === vols.length) {
          progress.totalBytes = [...totalsByKind.values()].reduce((a, b) => a + b, 0);
        }
        opts.onItem?.({ name: instanceId, status: "progress", progress });
      };
      await Promise.all(
        vols.map(async (vol) => {
          const extractDir = extractedDir(opts.workRoot, instanceId, vol.stateDir);
          await fs.mkdir(extractDir, { recursive: true });
          await opts.dockerOps.dockerVolumeToDir(vol.from, extractDir, opts.images[0], onVolumeProgress(vol.kind));
          if (vol.kind === "workspace") {
            rewrittenFiles += await applyWorkspaceContentTransforms(extractDir);
          }
        }),
      );
      const transferredBytes = [...bytesByKind.values()].reduce((a, b) => a + b, 0);
      const summary =
        `${vols.length} volume(s), ${formatBytes(transferredBytes)} extracted in ${fmtDuration(Date.now() - startedAt)}` +
        `${rewrittenFiles > 0 ? `, ${rewrittenFiles} file(s) rewritten` : ""}`;
      perInstance.push(`${instanceId} → ${migratedName}: ${summary}`);
      opts.onItem?.({ name: instanceId, status: "completed", summary });
    } catch (err) {
      // FATAL (v0.0.13 run feedback): a failed extraction used to be a
      // warning and the run continued "migrating" a tree that was never
      // fetched — value steps over partial data, a bogus load, and a green
      // "Migration complete" at the end. The step now fails and the runner
      // aborts before any downstream step runs.
      const message = (err as Error).message.split("\n")[0];
      failedInstances++;
      issues.push({
        severity: "error",
        message: `${instanceId}: volume extraction failed (${message}) — the scratch tree extracts onto the host's own disk (${opts.workRoot}), not the docker VM's; check free space there`,
      });
      opts.onItem?.({ name: instanceId, status: "warning", summary: message });
    }
  }

  return {
    step,
    status: failedInstances > 0 ? "failed" : "completed",
    summary:
      failedInstances > 0
        ? `volume extraction failed for ${failedInstances} of ${opts.instances.length} docker instance(s) — nothing was imported`
        : `extracted the volume data of ${opts.instances.length} docker instance(s) into the scratch tree`,
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
  let failedInstances = 0;
  for (const instanceId of opts.instances) {
    const migratedName = handleToInstanceName(instanceId);
    opts.onItem?.({ name: instanceId, status: "started" });
    const startedAt = Date.now();
    try {
      // Pre-create the runtime volumes cadet's hatch expects (see
      // runtimeVolumeNames) — best-effort, cadet recreates them on wake.
      for (const vol of runtimeVolumeNames(migratedName)) {
        try {
          await opts.dockerOps.dockerVolumeCreate?.(vol);
        } catch (err) {
          issues.push({
            severity: "warning",
            message: `could not create the runtime volume ${vol}: ${(err as Error).message} — cadet recreates it on first wake`,
          });
        }
      }
      let loaded = 0;
      const vols = dockerVolumes(instanceId, migratedName);
      const bytesByKind = new Map<string, number>();
      const totalsByKind = new Map<string, number>();
      const onVolumeProgress = (kind: string) => (bytes: number, totalBytes?: number) => {
        bytesByKind.set(kind, bytes);
        if (typeof totalBytes === "number") totalsByKind.set(kind, totalBytes);
        const sum = [...bytesByKind.values()].reduce((a, b) => a + b, 0);
        const progress: StepItemEvent["progress"] = { bytes: sum, label: "volumes" };
        if (totalsByKind.size === vols.length) {
          progress.totalBytes = [...totalsByKind.values()].reduce((a, b) => a + b, 0);
        }
        opts.onItem?.({ name: instanceId, status: "progress", progress });
      };
      await Promise.all(
        vols.map(async (vol) => {
          const extractDir = extractedDir(opts.workRoot, instanceId, vol.stateDir);
          if (!(await exists(extractDir))) return; // fetch failed for this kind — already warned
          await opts.dockerOps.dockerDirToVolume(extractDir, vol.to, opts.images[0], onVolumeProgress(vol.kind));
          loaded++;
        }),
      );
      const transferredBytes = [...bytesByKind.values()].reduce((a, b) => a + b, 0);
      const summary =
        `${loaded} cadet volume(s), ${formatBytes(transferredBytes)} written in ${fmtDuration(Date.now() - startedAt)}` +
        ` (+${runtimeVolumeNames(migratedName).length} runtime volume(s) ensured)`;
      perInstance.push(`${instanceId} → ${migratedName}: ${summary}`);
      opts.onItem?.({ name: instanceId, status: "completed", summary });
    } catch (err) {
      // FATAL (v0.0.13 run feedback): same contract as fetch — a failed
      // import leaves the cadet volumes incomplete, and continuing would
      // end the run "✔ Migration complete" with the data half-migrated.
      const message = (err as Error).message.split("\n")[0];
      failedInstances++;
      issues.push({
        severity: "error",
        message: `${instanceId}: volume import failed (${message})`,
      });
      opts.onItem?.({ name: instanceId, status: "warning", summary: message });
    }
  }

  return {
    step,
    status: failedInstances > 0 ? "failed" : "completed",
    summary:
      failedInstances > 0
        ? `volume import failed for ${failedInstances} of ${opts.instances.length} docker instance(s) — the cadet volumes are incomplete`
        : `imported the migrated data into ${opts.instances.length} docker instance(s)' cadet volumes`,
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
 * stores carrying no vellum-namespace entries. THE SAME SCAN the value
 * steps ran (findStateDbs over the state-shaped scratch root) — findings
 * are warnings, labeled by the checked path inside the tree. Same contract
 * as verify.
 */
export async function verifyDockerVolumeData(workRoot: string): Promise<DockerVolumeVerify> {
  const issues: StepIssue[] = [];
  let dbsChecked = 0;
  let storesChecked = 0;

  const { assistantDbs, gatewayDbs } = await findStateDbs(workRoot);
  for (const rel of assistantDbs) {
    dbsChecked++;
    issues.push(...(await dbIssues(path.join(workRoot, rel), displayDbRel(rel), VALUE_MIGRATED_DBS[0]!)));
  }
  for (const rel of gatewayDbs) {
    dbsChecked++;
    issues.push(...(await dbIssues(path.join(workRoot, rel), displayDbRel(rel), VALUE_MIGRATED_DBS[1]!)));
  }

  let entries: Array<{ absPath: string; relPath: string; isDirectory: boolean }>;
  try {
    entries = await walkTree(workRoot);
  } catch {
    entries = []; // Nothing was fetched (e.g. an unreachable docker daemon).
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (path.basename(entry.relPath) !== "keys.enc") continue;
    storesChecked++;
    const leftovers = await vellumCredentialEntriesIn(entry.absPath);
    if (leftovers > 0) {
      issues.push({
        severity: "warning",
        message: `${entry.relPath} still holds ${leftovers} vellum-namespace credential entr${leftovers === 1 ? "y" : "ies"}`,
      });
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
    // The breakdown names the offending tables/columns (v0.0.15 field
    // feedback: "still has 19 vellum-branded row(s)" said nothing about
    // WHERE those rows lived).
    return [
      {
        severity: "warning",
        message: `${label} still has ${leftover.total} vellum-branded row(s) — ${leftover.details.join("; ")}`,
      },
    ];
  }
  return [];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Count vellum-namespace entries in one encrypted credential store. */
async function vellumCredentialEntriesIn(keysPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(keysPath, "utf8")) as {
      entries?: Record<string, unknown>;
    };
    if (!parsed?.entries) return 0;
    return Object.keys(parsed.entries).filter((k) => k.startsWith("credential/vellum/")).length;
  } catch {
    return 0; // Unreadable — the scrub step already warned about it.
  }
}
