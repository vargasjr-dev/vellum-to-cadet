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
    // The installed cadet's own version — the lockfile conversion derives
    // the docker entries' container image refs from it (the images are
    // tagged per cadet release).
    const version = await ops.cadetVersion();
    return {
      step: "install-cadet",
      status: "completed",
      summary: `cadet CLI installed globally${version ? ` (v${version})` : ""}`,
      data: { installed: true, binAvailable: true, version },
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
    // The node exec error's message is just "Command failed: cadet wake
    // --all" — the actual reason (docker's stderr, the daemon's refusal)
    // lives on err.stderr. Surface it, or the user is told the command
    // failed by being told the command failed (v0.0.10 run feedback).
    const execErr = err as Error & { stderr?: string | Buffer };
    const detail = [
      typeof execErr.stderr === "string" ? execErr.stderr : execErr.stderr?.toString(),
      execErr.message,
    ]
      .find((s) => s && s.trim().length > 0)
      ?.trim()
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("Command failed:"))
      .join(" — ");
    return {
      step: "wake-assistants",
      status: "completed",
      summary: "wake failed (see ⚠) — run `cadet wake --all` manually",
      issues: [
        {
          severity: "warning",
          message: `cadet wake --all failed: ${detail ?? "unknown reason (re-run with --verbose)"}`,
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
  opts: { binAvailable: boolean; detected: boolean; interactive?: boolean },
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
  if (opts.interactive === false) {
    // The detached child has no terminal — the browser PKCE flow cannot
    // run here, and attempting it just fails (v0.0.15 field run: "cadet
    // login failed: cadet login exited 1" with no reason). Skip with the
    // instruction instead.
    return {
      step: "cadet-login",
      status: "skipped",
      summary:
        "the migration runs detached, so `cadet login` (an interactive browser flow) did not run — run `cadet login` in your terminal before using cloud features",
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
