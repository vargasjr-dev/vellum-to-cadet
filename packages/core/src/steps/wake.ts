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
    // The install command exiting 0 is not the claim — the binary being
    // resolvable is. v0.0.9 "installed" an unrelated npm package that
    // happened to own the `cadet` name and reported success while
    // `cadet wake --all` died on ENOENT.
    const binAvailable = await ops.cadetBinAvailable();
    if (!binAvailable) {
      return {
        step: "install-cadet",
        status: "completed",
        summary: "mycadet installed — no `cadet` binary on PATH yet, wake skipped (see ⚠)",
        issues: [
          {
            severity: "warning",
            message:
              "the mycadet package is installed (`npm ls -g mycadet` shows it) but it ships no `cadet` bin yet — wake the assistants manually once the cadet CLI ships a binary",
          },
        ],
        data: { installed: true, binAvailable: false },
      };
    }
    return {
      step: "install-cadet",
      status: "completed",
      summary: "cadet CLI installed globally",
      data: { installed: true, binAvailable: true },
    };
  } catch (err) {
    return {
      step: "install-cadet",
      status: "completed",
      summary: "cadet CLI install failed — wake skipped (see ⚠)",
      issues: [
        {
          severity: "warning",
          message: `npm install -g mycadet failed: ${(err as Error).message.split("\n")[0]}`,
        },
      ],
      data: { installed: false },
    };
  }
}

export async function wakeAssistants(ops: ProcessOps, assistantCount: number, binAvailable: boolean): Promise<StepResult> {
  if (assistantCount === 0) {
    return {
      step: "wake-assistants",
      status: "skipped",
      summary: "no lockfile-tracked assistant(s) to wake",
    };
  }
  if (!binAvailable) {
    return {
      step: "wake-assistants",
      status: "skipped",
      summary: "skipped — no `cadet` binary on PATH (see install-cadet ⚠)",
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

/**
 * The cadet-login step: when the migration detected legacy vellum cloud
 * credentials (the api key / webhook secret can't be kept), the migrated
 * assistants need fresh cadet cloud credentials — `cadet login` runs the
 * browser PKCE flow and re-registers them. Interactive by design, so it
 * runs BEFORE wake with the terminal handed to the user; a failure (user
 * skips it, no browser, no network) warns and the migration still completes.
 */
export async function cadetLoginStep(
  ops: ProcessOps,
  opts: { binAvailable: boolean; detected: boolean },
): Promise<StepResult> {
  if (!opts.detected) {
    return {
      step: "cadet-login",
      status: "skipped",
      summary: "no legacy vellum platform credentials detected — login not needed",
    };
  }
  if (!opts.binAvailable) {
    return {
      step: "cadet-login",
      status: "skipped",
      summary: "skipped — no `cadet` binary on PATH (see install-cadet ⚠)",
    };
  }
  try {
    await ops.cadetLogin();
    return {
      step: "cadet-login",
      status: "completed",
      summary: "cadet login complete — fresh cloud credentials established",
    };
  } catch (err) {
    return {
      step: "cadet-login",
      status: "completed",
      summary: "cadet login did not complete (see ⚠) — run `cadet login` manually before using cloud features",
      issues: [
        {
          severity: "warning",
          message: `cadet login failed: ${(err as Error).message.split("\n")[0]}`,
        },
      ],
    };
  }
}
