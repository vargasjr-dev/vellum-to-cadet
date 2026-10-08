import * as path from "node:path";

import { statfs as statfsPromises } from "node:fs/promises";
import { promises as fs } from "node:fs";

import { pathExists } from "./detect.js";
import { formatBytes } from "../fs-utils.js";
import type { DetectInfo, StepIssue, StepResult } from "../types.js";

/**
 * Preflight: everything that must be true before we touch a single byte.
 * Failures here are fatal (exit code 3) — no partial state has been created.
 */
export async function preflight(
  detect: DetectInfo,
  opts?: { skipDiskSpaceCheck?: boolean },
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

