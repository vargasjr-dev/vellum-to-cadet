import { cadetDiscoveryPatterns, discoveryPatterns } from "../process.js";
import { readLockfileAssistants } from "./detect.js";
import type { DetectInfo, ProcessOps, StepResult } from "../types.js";

/**
 * Put the vellum assistants to sleep before touching their data.
 *
 * The migrator has no custom stop logic: it asks the vellum CLI to sleep
 * its own assistants and hopes. A previous custom SIGTERM/SIGKILL
 * implementation killed unrelated processes matching the discovery
 * patterns — never again. Whatever survives the sleep is reported and
 * fails the run; we never signal processes ourselves.
 *
 * The vellum CLI has no sleep-all flag, so the migrator iterates the
 * lockfile — the same record `vellum ps` is derived from — and sleeps
 * each tracked assistant individually. A cadet root's assistants can be
 * running in several instances at once; leaving one awake would fail the
 * re-check below.
 */
export async function stopAssistant(
  detect: DetectInfo,
  ops: ProcessOps,
  verbose = false,
  graceMs = 5_000,
): Promise<StepResult> {
  const running = detect.runningProcesses;
  if (running.length === 0) {
    return { step: "stop-assistant", status: "skipped", summary: "no running vellum processes" };
  }

  const issues: Array<{ severity: "warning" | "error"; message: string }> = [];
  const targets = await readLockfileAssistants();
  if (targets.length === 0) {
    // Lockless or unreadable install — the CLI's own default resolution
    // is the best we can do; the re-check below decides.
    try {
      await ops.vellumSleep();
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).message ?? String(err);
      issues.push({
        severity: "warning",
        message: `\`vellum sleep\` failed (${message}) — is the vellum CLI on PATH? Continuing; the re-check below decides.`,
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
          message: `\`vellum sleep ${identifier}\` failed (${message}) — continuing with the remaining assistants; the re-check below decides.`,
        });
        if (verbose) console.error(`vellum sleep ${identifier} failed: ${message}`);
      }
    }
  }

  await sleep(graceMs);

  const stillRunning = await ops.find(discoveryPatterns());
  if (stillRunning.length > 0) {
    return {
      step: "stop-assistant",
      status: "failed",
      summary: `${stillRunning.length} vellum process(es) still running after \`vellum sleep\` — stop the assistant and retry`,
      issues: [
        ...issues,
        ...stillRunning.map((p) => ({
          severity: "error" as const,
          message: `pid ${p.pid}: ${p.command}`,
        })),
      ],
    };
  }

  return {
    step: "stop-assistant",
    status: "completed",
    summary:
      targets.length > 0
        ? `\`vellum sleep\` accepted for ${targets.length} lockfile-tracked assistant(s); no vellum processes remain`
        : "`vellum sleep` accepted; no vellum processes remain",
    issues,
  };
}

/**
 * Repair-mode counterpart: stop every CADET assistant before mutating the
 * cadet roots. Same contract — the cadet CLI's own sleep command does the
 * stopping (`cadet sleep --all` covers every assistant under the root); we
 * only re-discover and report survivors.
 */
export async function stopCadet(
  ops: ProcessOps,
  verbose = false,
  graceMs = 5_000,
): Promise<StepResult> {
  const running = await ops.find(cadetDiscoveryPatterns());
  if (running.length === 0) {
    return { step: "stop-cadet", status: "skipped", summary: "no running cadet processes" };
  }

  const issues: Array<{ severity: "warning" | "error"; message: string }> = [];
  try {
    await ops.cadetSleep();
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).message ?? String(err);
    issues.push({
      severity: "warning",
      message: `\`cadet sleep --all\` failed (${message}) — is the cadet CLI on PATH? Continuing; the re-check below decides.`,
    });
    if (verbose) console.error(`cadet sleep --all failed: ${message}`);
  }

  await sleep(graceMs);

  const stillRunning = await ops.find(cadetDiscoveryPatterns());
  if (stillRunning.length > 0) {
    return {
      step: "stop-cadet",
      status: "failed",
      summary: `${stillRunning.length} cadet process(es) still running after \`cadet sleep --all\` — stop the assistants and retry`,
      issues: [
        ...issues,
        ...stillRunning.map((p) => ({
          severity: "error" as const,
          message: `pid ${p.pid}: ${p.command}`,
        })),
      ],
    };
  }

  return {
    step: "stop-cadet",
    status: "completed",
    summary: "`cadet sleep --all` accepted; no cadet processes remain",
    issues,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
