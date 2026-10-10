import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CADET_PROCESS_PATTERNS, MIGRATION_CLI_MARKER, VELLUM_PROCESS_PATTERNS } from "./layout.js";
import type { ProcessOps } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Default process discovery + stop, backed by pgrep and the vellum CLI's
 * own sleep command. Kept behind the ProcessOps seam so tests can inject a
 * recorder.
 *
 * Discovery results never include our own ancestry: the migration must be
 * able to run from a directory whose path merely contains "vellum" (a dev
 * checkout, a tmpdir) without counting the shell or editor that launched it.
 */
export const defaultProcessOps: ProcessOps = {
  async find(patterns) {
    return defaultFind(patterns);
  },

  async vellumVersion() {
    try {
      const { stdout } = await execFileAsync("vellum", ["--version"]);
      // First line only, accepting both "0.12.6" and "vellum 0.12.6". If it
      // doesn't look like a version at all (an unrelated binary answered),
      // fall back to the marker files.
      const line = stdout.split("\n")[0]?.trim().replace(/^vellum\s+/i, "") ?? "";
      return /^v?\d/.test(line) ? line : null;
    } catch {
      // No CLI on PATH (or it refused) — marker-file detection is the fallback.
      return null;
    }
  },

  async vellumSleep(assistant?: string) {
    // Stopping the assistant is the vellum CLI's own logic — its sleep
    // command knows how its processes are organized. We deliberately do
    // NOT reimplement signal escalation here: custom process killing has
    // hit unrelated processes before.
    await execFileAsync("vellum", assistant ? ["sleep", assistant] : ["sleep"]);
  },

  async cadetSleep() {
    // Same contract, cadet side: repair mutates the cadet root, so it is
    // the cadet CLI's sleep command that owns stopping — --all covers
    // every assistant under the root, not just one.
    await execFileAsync("cadet", ["sleep", "--all"]);
  },

  async installCadet() {
    await execFileAsync("npm", ["install", "-g", "cadet"]);
  },

  async cadetWakeAll() {
    await execFileAsync("cadet", ["wake", "--all"]);
  },
};

async function defaultFind(patterns: string[]) {
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
          // Belt and suspenders: never touch anything invoking our own bin.
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
}

/** Patterns used for discovery (specific assistant process signatures). */
export function discoveryPatterns(): string[] {
  return [...VELLUM_PROCESS_PATTERNS];
}

/**
 * Cadet-side discovery — the same component signatures after the rebrand
 * (credential-executor kept its name). Used by repair mode, which stops
 * and inspects the cadet assistant, never the vellum one.
 */
export function cadetDiscoveryPatterns(): string[] {
  return [...CADET_PROCESS_PATTERNS];
}

/** Self + every ancestor pid, so our own process tree is never counted. */
async function ownAncestryPids(): Promise<Set<number>> {
  const pids = new Set<number>([process.pid]);
  let pid = process.ppid;
  // Hard bound: pid chains are short; loops would indicate a broken /proc.
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    pids.add(pid);
    pid = await parentPid(pid);
  }
  pids.add(1); // init is never counted either.
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
