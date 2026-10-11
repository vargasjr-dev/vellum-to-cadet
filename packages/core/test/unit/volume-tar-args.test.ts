import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { volumeTarCreateArgs } from "../../src/process.js";
import { expect } from "../helpers/expect.js";

/**
 * Spawn tar and settle on its close-code — promisified execFile rejects
 * stdio options, so this rides a spawn + close-code promise.
 */
function runTar(args: string[], input?: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdio: Array<"ignore" | "pipe"> =
      input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = spawn("tar", args, { stdio });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    if (input !== undefined) child.stdin?.end(input);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}

async function absent(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return false;
  } catch {
    return true;
  }
}

describe("volumeTarCreateArgs", () => {
  test("the volume stream survives a live daemon socket — excluded, not fatal", async () => {
    // The workspace volume carries the daemon's own IPC socket
    // (procs/<name>/ipc.sock — util/platform.ts getProcDir) — live
    // runtime state that once failed the whole fetch with
    // `tar: ./procs/routes/ipc.sock: socket ignored` (exit 1). Node
    // UNLINKS a socket file when its server closes, so the fixture
    // server STAYS LISTENING while tar runs, closed in the finally.
    const src = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-tar-src-"));
    await fs.mkdir(path.join(src, "procs/routes"), { recursive: true });
    await fs.writeFile(path.join(src, "keep.txt"), "data\n");
    const socketPath = path.join(src, "procs/routes/ipc.sock");
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const created = await runTar(volumeTarCreateArgs(src));
      expect(created.code).toBe(0);
      expect(created.stderr.trim()).toBe(""); // no "socket ignored" warning either

      const dest = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-tar-dest-"));
      const extracted = await runTar(["-x", "-C", dest], created.stdout);
      expect(extracted.code).toBe(0);

      await fs.access(path.join(dest, "keep.txt")); // regular files survive
      // no socket entry — runtime state does not migrate
      expect(await absent(path.join(dest, "procs/routes/ipc.sock"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
