import { cadetDiscoveryPatterns, discoveryPatterns } from "../process.js";
import type { DetectInfo, ProcessOps, StepResult } from "../types.js";

/**
 * Put the vellum assistant to sleep before touching its data.
 *
 * The migrator has no custom stop logic: it asks the vellum CLI to sleep
 * its own assistant (`vellum sleep`) and hopes. A previous custom
 * SIGTERM/SIGKILL implementation killed unrelated processes matching the
 * discovery patterns — never again. Whatever survives the sleep is
 * reported and fails the run; we never signal processes ourselves.
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
    summary: "`vellum sleep` accepted; no vellum processes remain",
    issues,
  };
}

/**
 * Repair-mode counterpart: stop the CADET assistant before mutating the
 * cadet root. Same contract — the cadet CLI's own sleep command does the
 * stopping; we only re-discover and report survivors.
 */
export async function stopCadet(
  cadetRoot: string,
  ops: ProcessOps,
  verbose = false,
  graceMs = 5_000,
): Promise<StepResult> {
  void cadetRoot; // the CLI's sleep discovers its own assistant
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
      message: `\`cadet sleep\` failed (${message}) — is the cadet CLI on PATH? Continuing; the re-check below decides.`,
    });
    if (verbose) console.error(`cadet sleep failed: ${message}`);
  }

  await sleep(graceMs);

  const stillRunning = await ops.find(cadetDiscoveryPatterns());
  if (stillRunning.length > 0) {
    return {
      step: "stop-cadet",
      status: "failed",
      summary: `${stillRunning.length} cadet process(es) still running after \`cadet sleep\` — stop the assistant and retry`,
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
    summary: "`cadet sleep` accepted; no cadet processes remain",
    issues,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
