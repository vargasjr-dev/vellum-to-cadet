import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Run-log + lock plumbing for the detachable migration.
 *
 * The default `migrate` run detaches: the heavy work happens in a child
 * process that survives an SSH disconnect, everything it prints lands in a
 * run-log file under ~/.cadet-migration-logs/, and an exclusive lock held
 * for the duration makes a second invocation FIND the running one instead
 * of racing it. The parent prints the log path up front, so reconnecting
 * is `tail -f <path>`.
 */

/** The directory every run-log and the run lock live in. */
export function runLogDir(): string {
  return path.join(os.homedir(), ".cadet-migration-logs");
}

/** Exclusive lock file guarding one migration run. */
export function runLockPath(): string {
  return path.join(runLogDir(), "migrate.lock");
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

/** A fresh, timestamped run-log path (the file itself is created by the caller). */
export function newRunLogPath(): string {
  return path.join(runLogDir(), `migrate-${utcStamp()}.log`);
}

export interface RunLockInfo {
  /** The pid of the process that owns the run (the detached child, normally). */
  pid: number;
  startedAt: string;
  logPath: string;
}

/** True when the pid belongs to a live process (EPERM counts — it exists). */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's contents, or null when absent/unparseable. */
export async function readRunLock(lockPath: string): Promise<RunLockInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<RunLockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.logPath !== "string") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt ?? "", logPath: parsed.logPath };
  } catch {
    return null;
  }
}

/**
 * Try to take the exclusive run lock (O_EXCL). False when another
 * migration holds it; a lock whose holder pid is dead is broken and
 * re-taken — a crashed run never wedges the next one.
 */
export async function acquireRunLock(lockPath: string, info: RunLockInfo): Promise<boolean> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(info), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readRunLock(lockPath);
      if (holder && pidAlive(holder.pid)) return false;
      await fs.rm(lockPath, { force: true }); // Stale — break and retry once.
    }
  }
  return false;
}

/** Release the lock, but only when it is still ours (a re-taken lock is someone else's). */
export async function releaseRunLock(lockPath: string, pid: number): Promise<void> {
  try {
    const holder = await readRunLock(lockPath);
    if (holder?.pid !== pid) return;
    await fs.rm(lockPath, { force: true });
  } catch {
    // Best effort — the stale-lock path heals a leaked lock anyway.
  }
}
