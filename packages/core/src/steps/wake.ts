import type { ProcessOps, StepResult, SudoRetryAsk } from "../types.js";

/**
 * Post-migration setup: the migration moved the user's assistants to the
 * cadet root, so when the migrated lockfile tracked any, install the cadet
 * CLI globally and wake everything it knows about. These steps are
 * conveniences — a failure (no network, npm permissions) warns but never
 * fails the completed migration.
 */

/**
 * The actionable fix fragment for an npm global install blocked by
 * permissions — shared by the preflight heads-up (before the migration)
 * and the install-cadet failure warning (at the end of one).
 */
export function cadetInstallFixCommands(): string {
  return process.platform === "win32"
    ? "`npm install -g mycadet` from an elevated terminal"
    : "`sudo npm install -g mycadet` (or switch npm to a version manager like nvm, which never needs sudo)";
}

export async function installCadetCli(
  ops: ProcessOps,
  assistantCount: number,
  opts?: { retryAsSudo?: SudoRetryAsk },
): Promise<StepResult> {
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
    const { version, detail } = await ops.cadetVersion();
    return {
      step: "install-cadet",
      status: "completed",
      summary: `cadet installed globally${version ? ` (${version})` : ""}`,
      data: {
        installed: true,
        binAvailable: true,
        version,
        ...(version === null && detail ? { versionUnavailableReason: detail } : {}),
      },
    };
  } catch (err) {
    // The node exec error's message is "Command failed: npm install -g
    // mycadet" (with the stderr appended) — npm's actual diagnosis lives on
    // err.stderr. Surface the REASON and the fix, not the command echo
    // (field report: an Ubuntu user got the bare command line and no idea
    // the migration itself had succeeded).
    const execErr = err as Error & { stderr?: string | Buffer; code?: string | number };
    const stderr = typeof execErr.stderr === "string" ? execErr.stderr : execErr.stderr?.toString();
    const haystack = `${stderr ?? ""} ${execErr.message}`;
    const detail = [stderr, execErr.message]
      .find((s) => s && s.trim().length > 0)
      ?.trim()
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("Command failed:"))
      .join(" — ");
    const npmRoot = await ops.npmGlobalRoot();
    const permission = /EACCES|EPERM|permission denied/i.test(haystack);

    // The permission wall is the one failure we can offer to fix: the ask
    // reports the wall itself, and an accepted retry runs the sudo install on
    // the user's own terminal — the detached worker has no TTY for sudo's
    // password prompt, so the launcher (which does) runs it.
    if (permission && opts?.retryAsSudo) {
      const outcome = await opts.retryAsSudo({ npmRoot });
      if (outcome.ok) {
        const binAvailable = await ops.cadetBinAvailable();
        if (!binAvailable) {
          return {
            step: "install-cadet",
            status: "completed",
            summary: "mycadet installed via sudo — no `cadet` binary on PATH yet, wake skipped (see ⚠)",
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
        const { version, detail: versionDetail } = await ops.cadetVersion();
        return {
          step: "install-cadet",
          status: "completed",
          summary: `cadet installed globally via sudo${version ? ` (${version})` : ""}`,
          data: {
            installed: true,
            binAvailable: true,
            version,
            ...(version === null && versionDetail ? { versionUnavailableReason: versionDetail } : {}),
          },
        };
      }
      return {
        step: "install-cadet",
        status: "completed",
        summary: "cadet CLI install failed — wake skipped (see ⚠)",
        issues: [
          {
            severity: "warning",
            message: `npm could not install mycadet into its global directory${npmRoot ? ` (${npmRoot})` : ""} — permission denied (${outcome.detail ?? "retry declined"}). The manual fix: ${cadetInstallFixCommands()}, then \`cadet wake --all\`.`,
          },
        ],
        data: { installed: false },
      };
    }

    let message: string;
    if (permission) {
      message = `npm could not install mycadet into its global directory${npmRoot ? ` (${npmRoot})` : ""} — permission denied. Your assistants are migrated; finish the setup manually: ${cadetInstallFixCommands()}, then run \`cadet wake --all\` to start them.`;
    } else if (execErr.code === "ENOENT" || /spawn .*ENOENT/i.test(execErr.message)) {
      message = "npm was not found on PATH — install Node.js/npm, then run `npm install -g mycadet` and `cadet wake --all` to start your migrated assistants.";
    } else {
      message = `npm install -g mycadet failed: ${detail ?? "unknown reason (re-run with --verbose)"}`;
    }
    return {
      step: "install-cadet",
      status: "completed",
      summary: "cadet CLI install failed — wake skipped (see ⚠)",
      issues: [{ severity: "warning", message }],
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
      summary: "cadet wake --all failed",
      issues: [
        {
          severity: "warning",
          message: (detail ?? "unknown reason (re-run with --verbose)").replace(/^Error:\s*/, "").replace(/docker exited with code \d+\s*[—–-]\s*(?:Error response from daemon:\s*)?/g, "").replace(/(failed to resolve reference "[^"]+"): \S+: not found/g, "$1: not found"),
        },
      ],
    };
  }
}

/** Establish fresh cloud credentials before wake, including detached runs. */
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
