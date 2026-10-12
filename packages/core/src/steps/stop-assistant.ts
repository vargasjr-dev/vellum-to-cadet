import { readLockfileAssistants } from "../discover.js";
import type { ProcessOps, StepResult } from "../types.js";

/**
 * Put the vellum assistants to sleep before touching their data.
 *
 * The migrator has no custom stop logic and no post-sleep validation: it
 * asks the vellum CLI to sleep its own assistants and trusts that. We
 * never signal processes ourselves, and we deliberately do NOT re-discover
 * survivors afterward — pattern-matching process lists cannot tell the
 * assistant's own components from look-alikes (a browser's bundled
 * credential-executor helpers matched and failed runs on a machine where
 * the assistant was long asleep).
 *
 * The vellum CLI has no sleep-all flag, so the migrator iterates the
 * lockfile — the same record `vellum ps` is derived from — and sleeps
 * each tracked assistant individually. A lockless or unreadable install
 * falls back to the CLI's own default resolution (one bare sleep).
 */
export async function stopAssistant(
  ops: ProcessOps,
  verbose = false,
  graceMs = 5_000,
): Promise<StepResult> {
  const issues: Array<{ severity: "warning" | "error"; message: string }> = [];
  const targets = await readLockfileAssistants();
  if (targets.length === 0) {
    // Lockless or unreadable install — the CLI's own default resolution
    // is the best we can do.
    try {
      await ops.vellumSleep();
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).message ?? String(err);
      issues.push({
        severity: "warning",
        message: `\`vellum sleep\` failed (${message}) — is the vellum CLI on PATH? Continuing.`,
      });
      if (verbose) console.error(`vellum sleep failed: ${message}`);
    }
  } else {
    for (const { identifier } of targets) {
      try {
        await ops.vellumSleep(identifier);
      } catch (err) {
        const message = (err as NodeJS.ErrnoException).message ?? String(err);
        issues.push({
          severity: "warning",
          message: `\`vellum sleep ${identifier}\` failed (${message}) — continuing with the remaining assistants.`,
        });
        if (verbose) console.error(`vellum sleep ${identifier} failed: ${message}`);
      }
    }
  }

  // Give the CLI's own drain a moment before we start copying files.
  await sleep(graceMs);

  return {
    step: "stop-assistant",
    status: "completed",
    summary:
      targets.length > 0
        ? `\`vellum sleep\` accepted for ${targets.length} lockfile-tracked assistant(s)`
        : "`vellum sleep` accepted",
    issues,
  };
}

/**
 * Repair-mode counterpart: stop every CADET assistant before mutating the
 * cadet roots — `cadet sleep --all` covers every assistant under the root.
 * Same contract: the cadet CLI's own sleep command does the stopping and
 * we trust it, with no survivor re-check.
 */
export async function stopCadet(
  ops: ProcessOps,
  verbose = false,
  graceMs = 5_000,
): Promise<StepResult> {
  const issues: Array<{ severity: "warning" | "error"; message: string }> = [];
  try {
    await ops.cadetSleep();
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).message ?? String(err);
    issues.push({
      severity: "warning",
      message: `\`cadet sleep --all\` failed (${message}) — is the cadet CLI on PATH? Continuing.`,
    });
    if (verbose) console.error(`cadet sleep --all failed: ${message}`);
  }

  await sleep(graceMs);

  return {
    step: "stop-cadet",
    status: "completed",
    summary: "`cadet sleep --all` accepted",
    issues,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
