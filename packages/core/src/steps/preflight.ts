import * as os from "node:os";
import * as path from "node:path";

import { statfs as statfsPromises } from "node:fs/promises";
import { promises as fs } from "node:fs";

import { pathExists } from "./detect.js";
import { vellumVolumeNames } from "./migrate-docker-volumes.js";
import { formatBytes } from "../fs-utils.js";
import type { DetectInfo, ProcessOps, StepIssue, StepResult } from "../types.js";

/**
 * Preflight: everything that must be true before we touch a single byte.
 * Failures here are fatal (exit code 3) — no partial state has been created.
 */
export async function preflight(
  detect: DetectInfo,
  opts?: {
    skipDiskSpaceCheck?: boolean;
    dockerOps?: Pick<ProcessOps, "dockerAvailable" | "dockerVolumeSize" | "dockerDiskFree">;
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

  if (!opts?.skipDiskSpaceCheck && detect.rootSizeBytes > 0) {
    const free = await freeBytesFor(detect.vellumRoot);
    if (free !== null && free < detect.rootSizeBytes * 1.2) {
      issues.push({
        severity: "error",
        message: `insufficient disk space: need ~${formatBytes(Math.ceil(detect.rootSizeBytes * 1.2))} (copy + headroom), have ${formatBytes(Math.floor(free))}`,
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
          if (free < totalBytes * 1.2) {
            issues.push({
              severity: "error",
              message: `insufficient docker disk space: need ~${formatBytes(Math.ceil(totalBytes * 1.2))} (copy + headroom) for the ${formatBytes(totalBytes)} of docker volumes, have ${formatBytes(Math.floor(free))} — free space or grow the docker VM's disk (colima: colima start --edit and raise disk)`,
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
          } else if (hostFree < totalBytes * 1.2) {
            issues.push({
              severity: "error",
              message: `insufficient host disk space: the migration extracts ~${formatBytes(Math.ceil(totalBytes * 1.2))} (copy + headroom) of docker volumes into a scratch directory under ${os.tmpdir()}, have ${formatBytes(Math.floor(hostFree))} free there — free space on the host disk`,
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

