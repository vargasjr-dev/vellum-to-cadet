import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { statfs as statfsPromises } from "node:fs/promises";
import { promises as fs } from "node:fs";

import { pathExists } from "./detect.js";
import { vellumVolumeNames } from "./migrate-docker-volumes.js";
import { formatBytes } from "../fs-utils.js";
import { cadetInstallFixCommands } from "./wake.js";
import type { DetectInfo, ProcessOps, StepIssue, StepResult } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Copy + headroom factor for every disk guard below. 1.5 (v0.0.14 run
 * feedback): extraction pays per-file metadata overhead `du` never sees
 * (inode and b-tree blocks over millions of node_modules files) — the
 * scratch absorbed ~20%+ beyond the measured du on the real run, and two
 * orphaned scratch corpses on top exhausted the disk. The old 1.2 passed
 * its guard and died mid-extract anyway.
 */
const COPY_HEADROOM = 1.5;

/**
 * Scratch dirs younger than this are never swept — a --dry-run holds no
 * run lock (so a concurrent real migration's live scratch must be left
 * alone), and freshly-created dirs must survive parallel test runs.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Preflight: everything that must be true before we touch a single byte.
 * Failures here are fatal (exit code 3) — no partial state has been created.
 */
export async function preflight(
  detect: DetectInfo,
  opts?: {
    skipDiskSpaceCheck?: boolean;
    dryRun?: boolean;
    dockerOps?: Pick<ProcessOps, "dockerAvailable" | "dockerVolumeSize" | "dockerDiskFree">;
    npmOps?: Pick<ProcessOps, "npmGlobalRoot" | "npmGlobalRootWritable">;
  },
): Promise<StepResult> {
  const issues: StepIssue[] = [];

  if (!detect.vellumRootExists) {
    return {
      step: "preflight",
      status: "failed",
      summary: `No vellum root found at ${detect.vellumRoot} — nothing to migrate`,
      issues: [{ severity: "error", message: "vellum root does not exist" }],
    };
  }

  // Orphan scratch sweep (v0.0.14 run feedback): a hard-killed run never
  // reaches its cleanup, and its vtc-volumes-* scratch tree stays on the
  // host disk — quietly eating the next run's disk budget (two corpses
  // held an entire Data volume's worth of free space). Swept BEFORE the
  // disk checks below so the freed space counts. A real run holds the run
  // lock here, so every old-enough match is a corpse; a dry run holds no
  // lock and only reports.
  const orphans = await orphanScratchDirs();
  if (orphans.length > 0) {
    const details: string[] = [];
    const unremoved: string[] = [];
    for (const dir of orphans) {
      const bytes = await dirDuBytes(dir);
      details.push(`${path.basename(dir)}${bytes === null ? "" : ` (${formatBytes(bytes)})`}`);
      if (opts?.dryRun) continue;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        unremoved.push(dir);
      }
    }
    if (opts?.dryRun) {
      issues.push({
        severity: "info",
        message: `found ${orphans.length} orphaned scratch dir(s) left by earlier failed runs (dry-run: not removed): ${details.join(", ")}`,
      });
    } else {
      issues.push({
        severity: "info",
        message:
          unremoved.length === 0
            ? `removed ${orphans.length} orphaned scratch dir(s) left by earlier failed runs: ${details.join(", ")}`
            : `removed ${orphans.length - unremoved.length} of ${orphans.length} orphaned scratch dir(s): ${details.join(", ")}`,
      });
      for (const dir of unremoved) {
        issues.push({
          severity: "warning",
          message: `could not remove orphaned scratch dir ${dir} — remove it by hand to reclaim the space`,
        });
      }
    }
  }

  if (!opts?.skipDiskSpaceCheck && detect.rootSizeBytes > 0) {
    const free = await freeBytesFor(detect.vellumRoot);
    if (free !== null && free < detect.rootSizeBytes * COPY_HEADROOM) {
      issues.push({
        severity: "error",
        message: `insufficient disk space: need ~${formatBytes(Math.ceil(detect.rootSizeBytes * COPY_HEADROOM))} (copy + headroom), have ${formatBytes(Math.floor(free))}`,
      });
    } else if (free === null) {
      issues.push({ severity: "warning", message: "could not determine free disk space — continuing" });
    }
  }

  // Docker installs keep the real data in volumes on the daemon's own
  // filesystem, and load-docker-volumes writes a second, full copy of every
  // volume while the vellum originals stay put (the untouched source of
  // truth). When an assistant's data is more than ~half the daemon's disk,
  // that copy cannot fit — the exact way the real runs died mid-load.
  // Measure it here, before a single byte moves.
  //
  // FAILS CLOSED (v0.0.13 run feedback): the old guard stood down with a
  // warning whenever a measurement failed — and the 60s du cap reliably
  // failed on a big volume — so a doomed run started, streamed for 15
  // minutes, and died on disk space the guard had been asked about.
  // Unmeasurable now means error; --skip-disk-space-check is the way out.
  if (!opts?.skipDiskSpaceCheck && opts?.dockerOps && detect.docker.instances.length > 0) {
    const dockerOps = opts.dockerOps;
    if (await dockerOps.dockerAvailable()) {
      const free = await dockerOps.dockerDiskFree?.();
      if (free === undefined) {
        issues.push({
          severity: "error",
          message:
            "could not determine the docker daemon's free disk space — refusing to migrate without verifying the volume copy fits; check the docker daemon, or pass --skip-disk-space-check to proceed anyway",
        });
      } else {
        const totalBytes = await dockerVolumeBytes(dockerOps, detect.docker.instances, detect.docker.images[0]);
        if (totalBytes === null) {
          issues.push({
            severity: "error",
            message:
              "could not measure the docker volume sizes (the size probe timed out or failed) — refusing to migrate without verifying the copy fits; check the docker daemon, or pass --skip-disk-space-check to proceed anyway",
          });
        } else {
          if (free < totalBytes * COPY_HEADROOM) {
            issues.push({
              severity: "error",
              message: `insufficient docker disk space: need ~${formatBytes(Math.ceil(totalBytes * COPY_HEADROOM))} (copy + headroom) for the ${formatBytes(totalBytes)} of docker volumes, have ${formatBytes(Math.floor(free))} — free space or grow the docker VM's disk (colima: colima start --edit and raise disk)`,
            });
          }
          // The HOST side needs room too: fetch extracts every volume into
          // a scratch tree under os.tmpdir() and load re-reads it — the
          // daemon's free disk says nothing about THAT disk (v0.0.13 run
          // feedback: the extraction died mid-stream on the host disk the
          // old guard never looked at).
          const hostFree = await freeBytesFor(os.tmpdir());
          if (hostFree === null) {
            // Fail closed, same as the daemon-side checks above: an
            // unmeasurable host disk must not stand the guard down (the
            // v0.0.14 run still died on exactly this disk mid-extract).
            issues.push({
              severity: "error",
              message: `could not determine the host's free disk space for the volume scratch directory under ${os.tmpdir()} — refusing to migrate without verifying the volume copy fits; check the host disk, or pass --skip-disk-space-check to proceed anyway`,
            });
          } else if (hostFree < totalBytes * COPY_HEADROOM) {
            issues.push({
              severity: "error",
              message: `insufficient host disk space: the migration extracts ~${formatBytes(Math.ceil(totalBytes * COPY_HEADROOM))} (copy + headroom) of docker volumes into a scratch directory under ${os.tmpdir()}, have ${formatBytes(Math.floor(hostFree))} free there — free space on the host disk`,
            });
          }
        }
      }
    }
  }

  // The cadet root may sit several levels deep (an instance dir under the
  // XDG data root) — probe the nearest existing ancestor for writability
  // without creating anything (dry runs must write nothing).
  let probe = detect.cadetRootExists ? detect.cadetRoot : path_parent(detect.cadetRoot);
  while (!(await pathExists(probe)) && probe !== path.dirname(probe)) {
    probe = path.dirname(probe);
  }
  try {
    await fs.access(probe);
  } catch {
    issues.push({
      severity: "error",
      message: `cannot write to ${probe}`,
    });
  }

  // Early heads-up for the post-migration convenience install (field report:
  // an Ubuntu user met npm's root-owned global prefix only at the very end of
  // a long migration). The migration itself never needs a global install, so
  // this warns — it does not fail.
  if (detect.assistantHandles.length > 0) {
    const npmRoot = (await opts?.npmOps?.npmGlobalRoot?.()) ?? null;
    const npmWritable = (await opts?.npmOps?.npmGlobalRootWritable?.()) ?? null;
    if (npmRoot !== null && npmWritable === false) {
      issues.push({
        severity: "warning",
        message: `npm cannot write its global directory (${npmRoot}) — the post-migration \`cadet\` CLI install may fail (bun installs are unaffected). Afterwards run ${cadetInstallFixCommands()}, then \`cadet wake --all\`.`,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  return {
    step: "preflight",
    status: errors.length > 0 ? "failed" : "completed",
    summary:
      errors.length > 0
        ? `${errors.length} preflight error(s)`
        : `ready: vellum root ${formatBytes(detect.rootSizeBytes)}, cadet root clear`,
    issues,
  };
}

function path_parent(p: string): string {
  const parts = p.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

async function freeBytesFor(within: string): Promise<number | null> {
  try {
    const stats = await statfsPromises(within);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Stale `vtc-volumes-*` scratch trees in os.tmpdir() — the corpses of
 * hard-killed runs (SIGKILL never reaches cleanup). Dirs younger than
 * ORPHAN_MIN_AGE_MS are skipped: a --dry-run holds no run lock, so a
 * concurrent real migration's live scratch must be left alone (and test
 * runs create fresh fixtures here too). An unreadable tmpdir means
 * nothing to sweep.
 */
async function orphanScratchDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("vtc-volumes-")) continue;
    const dir = path.join(os.tmpdir(), entry.name);
    const stats = await fs.stat(dir).catch(() => null);
    if (stats && Date.now() - stats.mtimeMs >= ORPHAN_MIN_AGE_MS) matches.push(dir);
  }
  return matches.sort();
}

/**
 * Size of a scratch tree via `du -sk` — the same measurement class the
 * disk guards compare against. Null when du fails or times out (the
 * sweep then reports the name without a size rather than blocking).
 */
async function dirDuBytes(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", dir], { timeout: 60_000 });
    const blocks = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(blocks) ? blocks * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Sum the vellum-side volume sizes across every docker instance — the data
 * the load step duplicates onto the daemon's disk. Null when any volume
 * cannot be measured (the guard then stands down with a warning).
 */
async function dockerVolumeBytes(
  dockerOps: Pick<ProcessOps, "dockerVolumeSize">,
  instances: readonly string[],
  image?: string,
): Promise<number | null> {
  let total = 0;
  for (const instanceId of instances) {
    for (const volume of vellumVolumeNames(instanceId)) {
      const size = await dockerOps.dockerVolumeSize?.(volume, image);
      if (size === undefined) return null;
      total += size;
    }
  }
  return total;
}

