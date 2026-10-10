import { describe, test } from "node:test";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { expect } from "../helpers/expect.js";
import { DEFAULT_TARGET_CTX } from "../../src/layout.js";
import { migrateRetiredArchives } from "../../src/steps/migrate-retired.js";
import type { StepItemEvent } from "../../src/types.js";

const run = promisify(execFileCb);

/**
 * The migrate-retired step streams per-archive progress: each retired
 * archive announces itself before processing and resolves exactly once —
 * "completed" with migration counts, or "warning / left as-is" when the
 * archive is unsalvageable (success is optional by design). These tests pin
 * that event contract for the CLI's nested live progress lines.
 */
describe("migrate-retired: per-archive progress events", () => {
  test("started → completed for a migrated archive, started → warning for a corrupt one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-retired-progress-"));
    const cadetRoot = path.join(root, "cadet");
    const retiredDir = path.join(cadetRoot, "retired");
    await fs.mkdir(retiredDir, { recursive: true });

    // A finished tar whose workspace log carries a vellum:// link — the
    // migration rewrites it, so the completed event carries counts.
    const scratch = path.join(root, "build", "good");
    await fs.mkdir(path.join(scratch, "workspace", "data", "logs"), { recursive: true });
    await fs.writeFile(path.join(scratch, "workspace", "data", "logs", "day.log"), "vellum://x\n");
    await run("tar", ["-czf", path.join(retiredDir, "good.tar.gz"), "-C", scratch, "."]);
    await fs.rm(path.join(root, "build"), { recursive: true, force: true });

    // A corrupt tar — must resolve as a warning, never fail the step.
    await fs.writeFile(path.join(retiredDir, "broken.tar.gz"), Buffer.from("not a tar at all"));

    const events: StepItemEvent[] = [];
    const result = await migrateRetiredArchives(cadetRoot, DEFAULT_TARGET_CTX, (item) => {
      events.push(item);
    });

    expect(result.status).toBe("completed");
    expect(events.length).toBe(4);

    // readdir order is not guaranteed — pin each archive's internal order.
    const idx = (name: string, status: StepItemEvent["status"]): number =>
      events.findIndex((e) => e.name === name && e.status === status);
    expect(idx("good", "started")).toBeGreaterThan(-1);
    expect(idx("good", "completed")).toBeGreaterThan(idx("good", "started"));
    expect(idx("broken", "started")).toBeGreaterThan(-1);
    expect(idx("broken", "warning")).toBeGreaterThan(idx("broken", "started"));

    const good = events.find((e) => e.name === "good" && e.status === "completed")!;
    expect(good.summary).toMatch(/^migrated \(\d+ content change\(s\), 0 db row\(s\)\)$/);
    const broken = events.find((e) => e.name === "broken" && e.status === "warning")!;
    expect(broken.summary).toBe("left as-is");
  });

  test("no retired directory: skipped, zero events, callback optional", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-retired-progress-"));
    const cadetRoot = path.join(root, "cadet");
    await fs.mkdir(cadetRoot, { recursive: true });

    const result = await migrateRetiredArchives(cadetRoot, DEFAULT_TARGET_CTX);
    expect(result.status).toBe("skipped");
  });

  test("a truncated tar.gz warns with the interrupted-retire hint and stays untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-retired-truncated-"));
    const cadetRoot = path.join(root, "cadet");
    const retiredDir = path.join(cadetRoot, "retired");
    await fs.mkdir(retiredDir, { recursive: true });

    // A VALID archive, then cut in half: the gzip stream ends early — the
    // signature of a retire killed mid-write.
    const scratch = path.join(root, "build", "truncated");
    await fs.mkdir(path.join(scratch, "workspace", "data", "logs"), { recursive: true });
    await fs.writeFile(path.join(scratch, "workspace", "data", "logs", "day.log"), "vellum://x\n");
    const tarPath = path.join(retiredDir, "truncated.tar.gz");
    await run("tar", ["-czf", tarPath, "-C", scratch, "."]);
    const bytes = await fs.readFile(tarPath);
    await fs.writeFile(tarPath, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const issues: StepItemEvent[] = [];
    const result = await migrateRetiredArchives(cadetRoot, DEFAULT_TARGET_CTX, (item) => {
      issues.push(item);
    });

    expect(result.status).toBe("completed"); // optional by design
    const truncated = issues.find((e) => e.name === "truncated" && e.status === "warning");
    expect(truncated?.summary).toBe("left as-is");
    const warn = result.issues?.find((i) => i.message.includes("'truncated'"));
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("archive looks truncated");
    // Cold storage is never touched on failure.
    expect((await fs.readFile(tarPath))).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
  });
});
