import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MIGRATION_CLI_MARKER, VELLUM_PROCESS_FALLBACK, VELLUM_PROCESS_PATTERNS } from "./layout.js";
import type { ProcessKiller } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Default process discovery/termination backed by pgrep/pkill-style shell
 * tools. Kept behind the ProcessKiller seam so tests can inject a recorder.
 */
export const defaultProcessKiller: ProcessKiller = {
  async find(patterns) {
    const found: Array<{ pid: number; command: string }> = [];
    const seen = new Set<number>();
    const myPid = process.pid;

    const allPatterns = [...patterns, VELLUM_PROCESS_FALLBACK];
    for (const pattern of allPatterns) {
      try {
        const { stdout } = await execFileAsync("pgrep", ["-f", pattern, "-l"]);
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const spaceIdx = trimmed.indexOf(" ");
          const pid = Number(spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx));
          const command = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
          if (!Number.isFinite(pid) || pid === myPid) continue;
          // Never kill our own CLI — its argv contains the word "vellum".
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

/** Patterns used for discovery (specific names first, fallback included). */
export function discoveryPatterns(): string[] {
  return [...VELLUM_PROCESS_PATTERNS];
}
