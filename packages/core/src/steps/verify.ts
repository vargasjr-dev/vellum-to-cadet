import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { isDbArtifact, isRewriteEligible, renameRelativePath, walkTree } from "../fs-utils.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * Post-migration verification:
 *  1. every vellum source file exists at its renamed cadet destination
 *  2. verbatim files are byte-identical (sha256)
 *  3. rewritten machine files contain no leftover vellum tokens
 *  4. the user-facing workspace is untouched byte-for-byte
 */
export async function verify(
  vellumRoot: string,
  cadetRoot: string,
): Promise<StepResult> {
  const issues: StepIssue[] = [];
  const source = await walkTree(vellumRoot);
  let checked = 0;
  let byteIdentical = 0;
  let rewrittenClean = 0;

  for (const entry of source) {
    if (entry.isDirectory) continue;
    const destRel = renameRelativePath(entry.relPath);
    const destAbs = path.join(cadetRoot, destRel);

    if (!(await exists(destAbs))) {
      issues.push({ severity: "error", path: entry.relPath, message: "missing in cadet root" });
      continue;
    }
    checked++;

    const srcBuf = await fs.readFile(entry.absPath);
    const destBuf = await fs.readFile(destAbs);
    const srcHash = createHash("sha256").update(srcBuf).digest("hex");
    const destHash = createHash("sha256").update(destBuf).digest("hex");

    if (srcHash === destHash) {
      byteIdentical++;
      continue;
    }

    // Different bytes — acceptable only if the file was supposed to be
    // rewritten AND the rewrite left no vellum tokens behind.
    if (isSupposedToBeRewritten(entry.relPath)) {
      const text = destBuf.toString("utf8");
      const leftovers = text.match(/VELLUM_|@vellumai\/|\.vellum(?![A-Za-z-])/g);
      if (leftovers && leftovers.length > 0) {
        issues.push({
          severity: "error",
          path: destRel,
          message: `${leftovers.length} leftover vellum token(s) after rewrite`,
        });
      } else {
        rewrittenClean++;
      }
    } else {
      issues.push({
        severity: "error",
        path: entry.relPath,
        message: "verbatim file differs from backup source",
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  return {
    step: "verify",
    status: errors.length > 0 ? "failed" : "completed",
    summary:
      errors.length > 0
        ? `verify failed: ${errors.length} problem(s) across ${checked} files`
        : `verified ${checked} files (${byteIdentical} byte-identical, ${rewrittenClean} rewritten clean)`,
    issues,
    data: { checked, byteIdentical, rewrittenClean },
  };
}

function isSupposedToBeRewritten(relPath: string): boolean {
  // Same predicate migrate-layout plans with — by construction, so verify
  // can never drift from the executor's classification.
  return isRewriteEligible(relPath) && !isDbArtifact(relPath);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
