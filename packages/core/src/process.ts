import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MIGRATION_CLI_MARKER, VELLUM_PROCESS_PATTERNS } from "./layout.js";
import type { ProcessKiller } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Default process discovery/termination backed by pgrep/pkill-style shell
 * tools. Kept behind the ProcessKiller seam so tests can inject a recorder.
 *
 * Discovery results never include our own ancestry: the migration must be
 * able to run from a directory whose path merely contains "vellum" (a dev
 * checkout, a tmpdir) without killing the shell or editor that launched it.
 */
export const defaultProcessKiller: ProcessKiller = {
  async find(patterns) {
    const found: Array<{ pid: number; command: string }> = [];
    const seen = new Set<number>();
    const protectedPids = await ownAncestryPids();
    const allPatterns = patterns.length > 0 ? patterns : [...VELLUM_PROCESS_PATTERNS];

    for (const pattern of allPatterns) {
      try {
        const { stdout } = await execFileAsync("pgrep", ["-f", pattern, "-l"]);
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const spaceIdx = trimmed.indexOf(" ");
          const pid = Number(spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx));
          const command = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
          if (!Number.isFinite(pid) || protectedPids.has(pid)) continue;
          // Belt and suspenders: never kill anything invoking our own bin.
          if (command.includes(MIGRATION_CLI_MARKER)) continue;
          if (seen.has(pid)) continue;
          seen.add(pid);
          found.push({ pid, command });
        }
      } catch {
        // pgrep exits 1 when nothing matches — that's fine.
      }
    }
    return found;
  },

  async terminate(pid) {
    process.kill(pid, "SIGTERM");
  },

  async kill(pid) {
    process.kill(pid, "SIGKILL");
  },
};

/** Patterns used for discovery (specific assistant process signatures). */
export function discoveryPatterns(): string[] {
  return [...VELLUM_PROCESS_PATTERNS];
}

/** Self + every ancestor pid, so we never terminate the process tree we run in. */
async function ownAncestryPids(): Promise<Set<number>> {
  const pids = new Set<number>([process.pid]);
  let pid = process.ppid;
  // Hard bound: pid chains are short; loops would indicate a broken /proc.
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    pids.add(pid);
    pid = await parentPid(pid);
  }
  pids.add(1); // init never gets killed by us either.
  return pids;
}

async function parentPid(pid: number): Promise<number> {
  try {
    if (process.platform !== "win32") {
      const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)]);
      const ppid = Number(stdout.trim());
      if (Number.isFinite(ppid) && ppid > 0) return ppid;
    }
  } catch {
    // Fall through — treat as top of the chain.
  }
  return 1;
}
