import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
  acquireRunLock,
  newRunLogPath,
  pidAlive,
  readRunLock,
  releaseRunLock,
  runLockPath,
  runLogDir,
} from "../../src/run-log.js";
import { expect } from "../helpers/expect.js";

/** A pid that is definitely dead: spawn a process, wait for it to exit. */
async function deadPid(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => resolve(child.pid!));
  });
}

describe("run-log paths", () => {
  test("newRunLogPath lands in ~/.cadet-migration-logs with a timestamped name", () => {
    const p = newRunLogPath();
    expect(path.dirname(p)).toBe(runLogDir());
    expect(path.basename(p)).toMatch(/^migrate-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.log$/);
  });

  test("the lock lives beside the logs", () => {
    expect(path.dirname(runLockPath())).toBe(runLogDir());
    expect(path.basename(runLockPath())).toBe("migrate.lock");
  });
});

describe("run lock", () => {
  test("acquires a free lock, records its info, releases it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlock-"));
    const lockPath = path.join(dir, "migrate.lock");
    const info = { pid: process.pid, startedAt: "t0", logPath: "migrate-x.log" };

    expect(await acquireRunLock(lockPath, info)).toBe(true);
    expect(await readRunLock(lockPath)).toEqual(info);

    await releaseRunLock(lockPath, process.pid);
    expect(await readRunLock(lockPath)).toBe(null);
  });

  test("refuses when the holder is alive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlock-"));
    const lockPath = path.join(dir, "migrate.lock");

    expect(await acquireRunLock(lockPath, { pid: process.pid, startedAt: "t0", logPath: "a.log" })).toBe(true);
    expect(await acquireRunLock(lockPath, { pid: process.pid, startedAt: "t1", logPath: "b.log" })).toBe(false);
    // The original holder's record is intact.
    expect((await readRunLock(lockPath))?.logPath).toBe("a.log");
  });

  test("breaks a stale lock whose holder pid is dead", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlock-"));
    const lockPath = path.join(dir, "migrate.lock");
    const pid = await deadPid();

    await fs.writeFile(lockPath, JSON.stringify({ pid, startedAt: "t0", logPath: "a.log" }));
    expect(pidAlive(pid)).toBe(false);
    expect(await acquireRunLock(lockPath, { pid: process.pid, startedAt: "t1", logPath: "b.log" })).toBe(true);
    expect((await readRunLock(lockPath))?.logPath).toBe("b.log");
  });

  test("release only removes our own lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlock-"));
    const lockPath = path.join(dir, "migrate.lock");
    const pid = await deadPid();

    await fs.writeFile(lockPath, JSON.stringify({ pid, startedAt: "t0", logPath: "a.log" }));
    await releaseRunLock(lockPath, process.pid);
    expect(await readRunLock(lockPath)).not.toBe(null); // someone else's — untouched
    await releaseRunLock(lockPath, pid);
    expect(await readRunLock(lockPath)).toBe(null); // ours (matched pid) — gone
  });

  test("readRunLock returns null on garbage or absence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlock-"));
    const lockPath = path.join(dir, "migrate.lock");

    expect(await readRunLock(lockPath)).toBe(null);
    await fs.writeFile(lockPath, "not json at all");
    expect(await readRunLock(lockPath)).toBe(null);
  });
});
