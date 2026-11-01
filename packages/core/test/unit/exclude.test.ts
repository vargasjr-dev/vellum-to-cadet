import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect } from "../helpers/expect.js";
import { matchesExclude } from "../../src/fs-utils.js";
import { buildCopyPlan } from "../../src/steps/migrate-layout.js";

describe("matchesExclude", () => {
  test("matches by basename at any depth", () => {
    expect(matchesExclude("assistants/velly/.vellum/logs/assistant-logs.db", ["assistant-logs.db"])).toBe(true);
    expect(matchesExclude("assistant-logs.db", ["assistant-logs.db"])).toBe(true);
    expect(matchesExclude("assistants/velly/.vellum/state/assistant.db", ["assistant-logs.db"])).toBe(false);
  });

  test("matches the full source-relative path", () => {
    expect(matchesExclude("assistants/velly/workspace/cache/blob.bin", ["assistants/velly/workspace/cache/blob.bin"])).toBe(true);
    expect(matchesExclude("other/cache/blob.bin", ["assistants/velly/workspace/cache/blob.bin"])).toBe(false);
  });

  test("* stays in one segment, ** crosses segments", () => {
    expect(matchesExclude("logs/nested/assistant-logs.db", ["logs/**/*.db"])).toBe(true);
    expect(matchesExclude("assistant-logs.db", ["logs/**/*.db"])).toBe(false);
    expect(matchesExclude("workspace/a/b.txt", ["workspace/*.txt"])).toBe(false);
    expect(matchesExclude("workspace/a.txt", ["workspace/*.txt"])).toBe(true);
  });

  test("a trailing / prunes a directory subtree", () => {
    expect(matchesExclude("assistants/velly/workspace/cache/deep/blob.bin", ["cache/"])).toBe(true);
    expect(matchesExclude("assistants/velly/workspace/cache", ["cache/"])).toBe(true);
    expect(matchesExclude("assistants/velly/workspace/caches/blob.bin", ["cache/"])).toBe(false);
  });

  test("dots are literal, ? is one in-segment char", () => {
    expect(matchesExclude("state/db.dev.db", ["db?dev.db"])).toBe(true);
    // ? is ONE character — two stray chars don't match.
    expect(matchesExclude("state/dbxydev.db", ["db?dev.db"])).toBe(false);
    // A pattern naming an intermediate directory prunes what's inside it.
    expect(matchesExclude("state/a.b/db", ["a.b"])).toBe(true);
    expect(matchesExclude("state/axb/db", ["a.b"])).toBe(false);
  });

  test("multiple patterns are OR-ed", () => {
    expect(matchesExclude("x/assistant-logs.db", ["*.tmp", "assistant-logs.db"])).toBe(true);
    expect(matchesExclude("x/thing.tmp", ["*.tmp", "assistant-logs.db"])).toBe(true);
    expect(matchesExclude("x/thing.bin", ["*.tmp", "assistant-logs.db"])).toBe(false);
  });
});

describe("buildCopyPlan --exclude", () => {
  async function makeRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vellum-exclude-"));
    await fs.mkdir(path.join(root, "assistants/vellum-velly/.vellum/logs"), { recursive: true });
    await fs.mkdir(path.join(root, "assistants/vellum-velly/.vellum/.vellum-assistant"), { recursive: true });
    await fs.mkdir(path.join(root, "assistants/vellum-velly/workspace/cache/deep"), { recursive: true });
    await fs.writeFile(path.join(root, "assistants/vellum-velly/.vellum/logs/assistant-logs.db"), "LOGDB");
    await fs.writeFile(path.join(root, "assistants/vellum-velly/.vellum/.vellum-assistant/version"), "0.12.6");
    await fs.writeFile(path.join(root, "assistants/vellum-velly/workspace/plain.txt"), "hi");
    await fs.writeFile(path.join(root, "assistants/vellum-velly/workspace/cache/deep/blob.bin"), "blob");
    return root;
  }

  test("excludes matching verbatim files and reports them", async () => {
    const root = await makeRoot();
    const { actions, excluded } = await buildCopyPlan(root, ["assistant-logs.db"]);
    expect(actions.map((a) => a.src)).not.toContain("assistants/vellum-velly/.vellum/logs/assistant-logs.db");
    const logs = excluded.find((e) => e.src.endsWith("assistant-logs.db"));
    expect(logs?.bytes).toBe("LOGDB".length);
  });

  test("never excludes rewrite-category files, markers, or lockfiles", async () => {
    const root = await makeRoot();
    // workspace/config.json is the rewrite-eligible config contract; the
    // marker + lockfile names are protected outright. Even a glob that
    // matches their basenames is ignored.
    await fs.writeFile(path.join(root, "assistants/vellum-velly/workspace/config.json"), "{}");
    await fs.writeFile(path.join(root, ".vellum.lock.json"), "{}");
    const { actions, excluded } = await buildCopyPlan(root, ["config.json", "version", "*.json"]);
    expect(actions.map((a) => a.src)).toContain("assistants/vellum-velly/workspace/config.json");
    expect(actions.map((a) => a.src)).toContain("assistants/vellum-velly/.vellum/.vellum-assistant/version");
    expect(actions.map((a) => a.src)).toContain(".vellum.lock.json");
    expect(excluded).toHaveLength(0);
  });

  test("rename-only content IS excludable (content untouched, only the path moves)", async () => {
    const root = await makeRoot();
    // A state-dir blob: content rides untouched, the instance-dir rename
    // moves its path — rename-only, so the user may skip it.
    const blob = path.join(root, "assistants/vellum-velly/.vellum/cache/blob.bin");
    await fs.mkdir(path.dirname(blob), { recursive: true });
    await fs.writeFile(blob, "blob");
    const { actions, excluded } = await buildCopyPlan(root, ["blob.bin"]);
    expect(actions.map((a) => a.src)).not.toContain("assistants/vellum-velly/.vellum/cache/blob.bin");
    expect(excluded.map((e) => e.src)).toContain("assistants/vellum-velly/.vellum/cache/blob.bin");
  });

  test("a trailing-/ pattern prunes the whole subtree", async () => {
    const root = await makeRoot();
    const { actions, excluded } = await buildCopyPlan(root, ["cache/"]);
    const srcs = actions.map((a) => a.src);
    expect(srcs).not.toContain("assistants/vellum-velly/workspace/cache/deep/blob.bin");
    expect(srcs.some((s) => s.startsWith("assistants/vellum-velly/workspace/cache/"))).toBe(false);
    expect(excluded.some((e) => e.src.endsWith("blob.bin"))).toBe(true);
  });

  test("no patterns → the plan is complete and nothing is excluded", async () => {
    const root = await makeRoot();
    const { actions, excluded } = await buildCopyPlan(root);
    expect(excluded).toHaveLength(0);
    expect(actions.map((a) => a.src)).toContain("assistants/vellum-velly/.vellum/logs/assistant-logs.db");
  });
});
