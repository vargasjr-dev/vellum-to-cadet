#!/usr/bin/env node
/**
 * npx shim: `npx migrate-vellum-assistant-to-cadet` resolves THIS package,
 * which hands off to the real CLI in @mycadet/vellum.
 *
 * The CLI is bun-native (the database migration steps run on bun:sqlite), so
 * it cannot load under node. Re-exec it with bun; when bun is missing, print
 * actionable copy instead of node's ERR_UNSUPPORTED_ESM_URL_SCHEME.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const bun = process.platform === "win32" ? "bun.exe" : "bun";
const cliPath = createRequire(import.meta.url).resolve("@mycadet/vellum/cli");

const probe = spawnSync(bun, ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.error("The migrator runs on bun (https://bun.sh), which was not found on your PATH.");
  console.error("Install it and re-run this command:");
  console.error("  curl -fsSL https://bun.sh/install | bash");
  process.exit(1);
}

const run = spawnSync(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (run.error) {
  console.error(`Failed to launch bun: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
