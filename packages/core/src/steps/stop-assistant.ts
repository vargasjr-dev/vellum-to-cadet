import { discoveryPatterns } from "../process.js";
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
  const containers = detect.docker.runningContainers;
  if (running.length === 0 && containers.length === 0) {
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

  // Docker topology: `vellum sleep` stops containers itself when the CLI is
  // present; if any survived (CLI missing, daemon hiccup), stop them the same
  // way the CLI does. We still never signal host processes ourselves.
  let stoppedContainers: string[] = [];
  let stillUpContainers = containers;
  if (containers.length > 0 && ops.dockerPs) {
    stillUpContainers = await aliveContainers(ops, containers);
    if (stillUpContainers.length > 0 && ops.dockerStop) {
      try {
        await ops.dockerStop(stillUpContainers);
      } catch (err) {
        issues.push({
          severity: "warning",
          message: `docker stop failed (${(err as Error).message})`,
        });
      }
      await sleep(graceMs);
      stillUpContainers = await aliveContainers(ops, containers);
      stoppedContainers = containers.filter((name) => !stillUpContainers.includes(name));
    } else {
      stoppedContainers = containers;
    }
  }

  if (stillUpContainers.length > 0) {
    return {
      step: "stop-assistant",
      status: "failed",
      summary: `${stillUpContainers.length} docker container(s) still running — stop them and retry`,
      issues: [
        ...issues,
        ...stillUpContainers.map((name) => ({
          severity: "error" as const,
          message: `container ${name}`,
        })),
      ],
    };
  }

  const containerNote =
    containers.length > 0 ? `; ${containers.length} docker container(s) stopped` : "";
  return {
    step: "stop-assistant",
    status: "completed",
    summary: `\`vellum sleep\` accepted; no vellum processes remain${containerNote}`,
    issues,
    data: stoppedContainers.length > 0 ? { stoppedContainers } : undefined,
  };
}

async function aliveContainers(ops: ProcessOps, names: string[]): Promise<string[]> {
  try {
    const running = new Set(await ops.dockerPs!());
    return names.filter((name) => running.has(name));
  } catch {
    // docker unreachable — treat the known containers as still up.
    return names;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
