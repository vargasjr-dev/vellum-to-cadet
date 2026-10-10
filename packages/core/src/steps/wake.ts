import type { ProcessOps, StepResult } from "../types.js";

/**
 * Post-migration setup: the migration moved the user's assistants to the
 * cadet root, so when the migrated lockfile tracked any, install the cadet
 * CLI globally and wake everything it knows about. These steps are
 * conveniences — a failure (no network, npm permissions) warns but never
 * fails the completed migration.
 */

export async function installCadetCli(ops: ProcessOps, assistantCount: number): Promise<StepResult> {
  if (assistantCount === 0) {
    return {
      step: "install-cadet",
      status: "skipped",
      summary: "no lockfile-tracked assistant(s) — cadet CLI not installed",
    };
  }
  try {
    await ops.installCadet();
    return {
      step: "install-cadet",
      status: "completed",
      summary: "cadet CLI installed globally",
      data: { installed: true },
    };
  } catch (err) {
    return {
      step: "install-cadet",
      status: "completed",
      summary: "cadet CLI install failed — wake skipped (see ⚠)",
      issues: [
        {
          severity: "warning",
          message: `npm install -g cadet failed: ${(err as Error).message.split("\n")[0]}`,
        },
      ],
      data: { installed: false },
    };
  }
}

export async function wakeAssistants(ops: ProcessOps, assistantCount: number, installOk: boolean): Promise<StepResult> {
  if (assistantCount === 0) {
    return {
      step: "wake-assistants",
      status: "skipped",
      summary: "no lockfile-tracked assistant(s) to wake",
    };
  }
  if (!installOk) {
    return {
      step: "wake-assistants",
      status: "skipped",
      summary: "skipped — the cadet CLI is not installed (see install-cadet ⚠)",
    };
  }
  try {
    await ops.cadetWakeAll();
    return {
      step: "wake-assistants",
      status: "completed",
      summary: `woke ${assistantCount} assistant(s) via \`cadet wake --all\``,
    };
  } catch (err) {
    return {
      step: "wake-assistants",
      status: "completed",
      summary: "wake failed (see ⚠) — run `cadet wake --all` manually",
      issues: [
        {
          severity: "warning",
          message: `cadet wake --all failed: ${(err as Error).message.split("\n")[0]}`,
        },
      ],
    };
  }
}
