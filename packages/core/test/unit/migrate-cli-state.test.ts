import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateCliState } from "../../src/steps/migrate-cli-state.js";

test("legacy root carries shared XDG archives/logs into the global Cadet roots, preserving existing files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-cli-state-"));
  const previous = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME };
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  async function put(rel: string, value: string) {
    const dest = path.join(tmp, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, value);
  }
  try {
    await put("data/vellum/retired/assistant.tar.gz", "retired");
    await put("data/vellum/backups/assistant.tar.gz", "backup");
    await put("data/vellum/upgrade-logs/upgrade.log", "upgrade");
    await put("config/vellum/logs/hatch.log", "hatch");
    await put("config/vellum/logs/retire.log", "retire");
    await put("data/cadet/backups/assistant.tar.gz", "existing cadet backup");
    const root = path.join(tmp, ".vellum");
    await fs.mkdir(root);
    const destination = path.join(tmp, "data/cadet/assistants/assistant");
    const result = await migrateCliState(root, destination);
    assert.equal(result.data?.copied, 4);
    assert.equal(await fs.readFile(path.join(tmp, "data/cadet/retired/assistant.tar.gz"), "utf8"), "retired");
    assert.equal(await fs.readFile(path.join(tmp, "data/cadet/backups/assistant.tar.gz"), "utf8"), "existing cadet backup");
    assert.equal(await fs.readFile(path.join(tmp, "config/cadet/logs/retire.log"), "utf8"), "retire");
    assert.equal((await migrateCliState(root, destination)).data?.copied, 0);
    await assert.rejects(fs.stat(path.join(destination, "retired")), { code: "ENOENT" });
  } finally {
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.config;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
