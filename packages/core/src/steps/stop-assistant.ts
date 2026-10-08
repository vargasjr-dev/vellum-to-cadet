import type { DetectInfo, ProcessKiller, StepResult } from "../types.js";

/**
 * Put the vellum assistant to sleep before touching its data.
 * SIGTERM first, grace period, then SIGKILL for holdouts.
 */
export async function stopAssistant(
  detect: DetectInfo,
  killer: ProcessKiller,
  verbose = false,
  termGraceMs = 5_000,
): Promise<StepResult> {
  const running = detect.runningProcesses;
  if (running.length === 0) {
    return { step: "stop-assistant", status: "skipped", summary: "no running vellum processes" };
  }

  const killed: number[] = [];
  const survived: Array<{ pid: number; command: string }> = [];

  for (const proc of running) {
    try {
      await killer.terminate(proc.pid);
      killed.push(proc.pid);
    } catch (err) {
      survived.push(proc);
      if (verbose) console.error(`terminate(${proc.pid}) failed: ${(err as Error).message}`);
    }
  }

  await sleep(termGraceMs);

  // Re-discover: whatever is still alive gets SIGKILL.
  const stillRunning = await killer.find(
    // Re-check with the same broad pattern set the detector used.
    ["vellum"],
  );

  for (const proc of stillRunning) {
    if (!killed.includes(proc.pid)) continue;
    try {
      await killer.kill(proc.pid);
    } catch (err) {
      if (verbose) console.error(`kill(${proc.pid}) failed: ${(err as Error).message}`);
      survived.push(proc);
    }
  }

  if (survived.length > 0) {
    return {
      step: "stop-assistant",
      status: "failed",
      summary: `${survived.length} vellum process(es) refused to stop — close the assistant and retry`,
      issues: survived.map((p) => ({
        severity: "error" as const,
        message: `pid ${p.pid}: ${p.command}`,
      })),
    };
  }

  return {
    step: "stop-assistant",
    status: "completed",
    summary: `stopped ${killed.length} vellum process(es): ${killed.join(", ")}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
