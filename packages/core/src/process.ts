import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { Transform } from "node:stream";
import { promisify } from "node:util";

import { CADET_PROCESS_PATTERNS, MIGRATION_CLI_MARKER, VELLUM_PROCESS_PATTERNS } from "./layout.js";
import { walkTree } from "./fs-utils.js";
import type { ProcessOps } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * The image the docker volume ops mount for their tar helper containers.
 * The vellum sandbox images are guaranteed present on a docker install
 * (its containers ran from them) and carry `tar` — pass a recorded entry
 * image when you have one; this fallback covers the images-less call
 * sites.
 */
const VOLUME_HELPER_IMAGE = "vellumai/vellum-assistant:latest";

/**
 * Wall-clock cap for one docker volume transfer. A docker daemon that
 * accepts a request and never answers must not hang the migration (the
 * v0.0.11 run sat on a never-started extract container until the user's
 * SSH session died) — the children get killed and the step reports a
 * warning instead. The cap is generous: v0.0.12 run feedback showed a real
 * multi-GB volume copy can stream far longer than the old 10-minute cap,
 * and transfers now report byte progress — slow is visible, a true hang
 * still gets cut loose.
 */
const VOLUME_STREAM_TIMEOUT_MS = 3_600_000;

/**
 * Wait for a pipeline of child processes (stdout piped into the next
 * child's stdin) to finish. Rejects on a nonzero exit, a spawn failure,
 * or the timeout — on timeout every child is killed first so nothing
 * keeps running.
 */
function settleStreams(children: ChildProcess[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = [];
    let stderrLength = 0;
    let pending = children.length;
    let failure: Error | null = null;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      settle(new Error(`${what}: timed out after ${Math.round(VOLUME_STREAM_TIMEOUT_MS / 1000)}s`));
    }, VOLUME_STREAM_TIMEOUT_MS);
    for (const child of children) {
      let closed = false;
      const markClosed = (): void => {
        if (closed) return;
        closed = true;
        if (--pending === 0) settle(failure ?? undefined);
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrLength < 4096) {
          stderrChunks.push(chunk);
          stderrLength += chunk.length;
        }
      });
      child.on("error", (err) => {
        failure ??= new Error(`${what}: ${(err as Error).message}`);
        markClosed();
      });
      child.on("close", (code) => {
        if (code !== 0 && !failure) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().split("\n").pop() ?? "";
          failure = new Error(`${what}: exited ${code}${stderr ? ` — ${stderr}` : ""}`);
        }
        markClosed();
      });
    }
  });
}

/** Minimum interval between progress emits — the stream is throttled at the source. */
const PROGRESS_EVERY_MS = 300;

/**
 * A pass-through that counts tar-stream bytes and reports them onward —
 * piped between the docker side and the host tar side of a volume
 * transfer. Emits at most once per PROGRESS_EVERY_MS plus a guaranteed
 * final flush, so callers can forward straight to the renderer.
 */
function byteProgressTap(
  onProgress: (bytes: number, totalBytes?: number) => void,
  totalBytes?: number,
): Transform {
  let transferred = 0;
  let lastEmit = 0;
  const emit = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_EVERY_MS) return;
    lastEmit = now;
    onProgress(transferred, totalBytes);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      transferred += chunk.length;
      emit();
      cb(null, chunk);
    },
    flush(cb) {
      emit(true);
      cb();
    },
  });
}

/**
 * A volume's content size, from `du -sk` inside a throwaway container.
 * The progress denominator; any failure just means the progress line
 * shows bytes-so-far without a percentage.
 */
async function dockerVolumeSize(volume: string, image?: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/data`,
        "--entrypoint",
        "du",
        image ?? VOLUME_HELPER_IMAGE,
        "-sk",
        "/data",
      ],
      { timeout: 60_000 },
    );
    const blocks = Number(stdout.trim().split(/\s/)[0]);
    return Number.isFinite(blocks) && blocks >= 0 ? blocks * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The docker daemon's free disk bytes, from `df` inside a throwaway
 * container — docker volumes live on the daemon's own filesystem (under
 * colima, a VM disk), which host-side statfs cannot see. Any failure just
 * means the preflight disk guard can't run.
 */
async function dockerDiskFree(image?: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "--entrypoint", "df", image ?? VOLUME_HELPER_IMAGE, "-k", "-P", "/"],
      { timeout: 15_000 },
    );
    return parseDfAvail(stdout);
  } catch {
    return undefined;
  }
}

/** The `Avail` column (1K blocks → bytes) of a `df -k -P` output — the row whose mount point is `/`. */
export function parseDfAvail(stdout: string): number | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 4 && fields[fields.length - 1] === "/") {
      const blocks = Number(fields[fields.length - 3]);
      return Number.isFinite(blocks) && blocks >= 0 ? blocks * 1024 : undefined;
    }
  }
  return undefined;
}

/** A host directory's size — the import direction's progress denominator. */
async function dirSizeBytes(dir: string): Promise<number | undefined> {
  try {
    let total = 0;
    for (const entry of await walkTree(dir)) {
      if (entry.isDirectory) continue;
      total += (await fsPromises.stat(entry.absPath)).size;
    }
    return total;
  } catch {
    return undefined;
  }
}

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

  async dockerVolumeToDir(volume, destDir, image, onProgress) {
    // Stream the volume out as a tar archive: `docker run --rm` starts a
    // real container that tars the mounted volume to stdout, and the host
    // untars the stream into destDir. No bind mounts of host tmpdirs (the
    // macOS/Colima virtiofs share does not expose /var/folders, where
    // os.tmpdir() resolves), and --rm removes the container even when the
    // stream fails — nothing left behind in `docker ps -a` (v0.0.11 run
    // feedback: the old create+cp dance left a never-started container
    // behind and hung the run until the SSH session died; now a stuck
    // stream is killed by the settle timeout and reported as a warning).
    // Byte progress (v0.0.12 run feedback): size the volume up front for
    // the denominator, then count the tar stream as it flows — a big
    // volume copy reports steady progress instead of hanging silently.
    const totalBytes = onProgress ? await dockerVolumeSize(volume, image) : undefined;
    const src = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/data`,
        "--entrypoint",
        "tar",
        image ?? VOLUME_HELPER_IMAGE,
        "-c",
        "-C",
        "/data",
        ".",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const untar = spawn("tar", ["-x", "-C", destDir], { stdio: ["pipe", "ignore", "pipe"] });
    if (onProgress) {
      src.stdout!.pipe(byteProgressTap(onProgress, totalBytes)).pipe(untar.stdin!);
    } else {
      src.stdout!.pipe(untar.stdin!);
    }
    await settleStreams([src, untar], `extract ${volume}`);
  },

  async dockerDirToVolume(srcDir, volume, image, onProgress) {
    // Idempotent by itself: `docker volume create` on an existing name is a
    // no-op. Import streams the host dir's tar into the mounted volume —
    // same --rm contract, nothing left behind. Byte progress mirrors the
    // extract direction: the tree's own size is the denominator.
    await execFileAsync("docker", ["volume", "create", volume], { timeout: 15_000 });
    const totalBytes = onProgress ? await dirSizeBytes(srcDir) : undefined;
    const tar = spawn("tar", ["-c", "-C", srcDir, "."], { stdio: ["ignore", "pipe", "pipe"] });
    const load = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "-v",
        `${volume}:/data`,
        "--entrypoint",
        "tar",
        image ?? VOLUME_HELPER_IMAGE,
        "-x",
        "-C",
        "/data",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    if (onProgress) {
      tar.stdout!.pipe(byteProgressTap(onProgress, totalBytes)).pipe(load.stdin!);
    } else {
      tar.stdout!.pipe(load.stdin!);
    }
    await settleStreams([tar, load], `import into ${volume}`);
  },

  async dockerAvailable() {
    try {
      // A daemon that never answers must not hang detection either.
      await execFileAsync("docker", ["info"], { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  },

  async dockerVolumeSize(volume: string, image?: string) {
    return dockerVolumeSize(volume, image);
  },

  async dockerDiskFree(image?: string) {
    return dockerDiskFree(image);
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
