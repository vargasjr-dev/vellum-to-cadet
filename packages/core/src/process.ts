import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { CADET_PROCESS_PATTERNS, MIGRATION_CLI_MARKER, VELLUM_PROCESS_PATTERNS } from "./layout.js";
import type { ProcessOps } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * The image the docker volume ops mount for their temp containers. The
 * vellum sandbox images are guaranteed present on a docker install (its
 * containers ran from them) — pass a recorded entry image when you have
 * one; this fallback covers the images-less call sites.
 */
const VOLUME_HELPER_IMAGE = "vellumai/vellum-assistant:latest";

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
    // The cadet CLI's npm package is `mycadet` (scoped siblings aside, that
    // is the name on npm — `cadet` is an unrelated third-party package, and
    // installing IT is how v0.0.9 "installed" something that shipped no
    // cadet binary).
    await execFileAsync("npm", ["install", "-g", "mycadet"]);
  },

  async cadetWakeAll() {
    await execFileAsync("cadet", ["wake", "--all"]);
  },

  async cadetLogin() {
    // Interactive by design: the browser PKCE flow. stdio inherit so the
    // user sees the browser handoff and any prompts — resolves when the
    // flow finishes; a nonzero exit rejects.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cadet", ["login"], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`cadet login exited ${code ?? "without a code"}`)),
      );
    });
  },

  async cadetBinAvailable() {
    try {
      await execFileAsync("cadet", ["--version"]);
    } catch (err) {
      // ENOENT is the only signal that the binary is absent; any other
      // failure (bad flags, nonzero exit) still proves it resolves.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    }
    return true;
  },

  async cadetVersion() {
    try {
      const { stdout } = await execFileAsync("cadet", ["--version"]);
      // First line only, accepting both "0.12.7" and "cadet 0.12.7". A
      // non-version answer (an unrelated binary owns the name) yields null
      // so the lockfile conversion never writes image refs derived from it.
      const line = stdout.split("\n")[0]?.trim().replace(/^cadet\s+/i, "") ?? "";
      return /^v?\d/.test(line) ? line.replace(/^v/, "") : null;
    } catch {
      return null;
    }
  },

  async dockerVolumeToDir(volume, destDir, image) {
    // docker cp cannot read a volume directly — mount it into a
    // never-started temp container and cp out of that. The image must be
    // locally present (docker create never pulls): the recorded entry
    // images are the reliable choice on a docker install.
    const container = `vtc-extract-${randomBytes(4).toString("hex")}`;
    await execFileAsync("docker", ["create", "--name", container, "-v", `${volume}:/data`, image ?? VOLUME_HELPER_IMAGE]);
    try {
      await execFileAsync("docker", ["cp", `${container}:/data/.`, destDir]);
    } finally {
      await execFileAsync("docker", ["rm", "--force", container]).catch(() => {});
    }
  },

  async dockerDirToVolume(srcDir, volume, image) {
    // Idempotent by itself: `docker volume create` on an existing name is a
    // no-op. Same temp-container trick, in the other direction.
    await execFileAsync("docker", ["volume", "create", volume]);
    const container = `vtc-import-${randomBytes(4).toString("hex")}`;
    await execFileAsync("docker", ["create", "--name", container, "-v", `${volume}:/data`, image ?? VOLUME_HELPER_IMAGE]);
    try {
      await execFileAsync("docker", ["cp", `${srcDir}/.`, `${container}:/data`]);
    } finally {
      await execFileAsync("docker", ["rm", "--force", container]).catch(() => {});
    }
  },

  async dockerAvailable() {
    try {
      await execFileAsync("docker", ["info"]);
      return true;
    } catch {
      return false;
    }
  },

  async npmGlobalRoot() {
    try {
      const { stdout } = await execFileAsync("npm", ["root", "-g"]);
      const root = stdout.trim();
      return root.length > 0 ? root : null;
    } catch {
      return null;
    }
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
