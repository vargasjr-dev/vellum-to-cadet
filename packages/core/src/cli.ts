#!/usr/bin/env node
/**
 * CLI shell over the migration engine.
 *
 * Deliberately dependency-free so npx stays fast and the supply chain stays
 * boring. Runs on plain Node >= 18.17 — self-hosters don't need bun.
 */
import { createInterface } from "node:readline/promises";

import { colors, command, detail, failIcon, header, skipIcon, successIcon } from "./colors.js";
import { discoverVellumRoots, candidateRoots } from "./discover.js";
import { migrate } from "./runner.js";
import { DEFAULT_CADET_ROOT } from "./steps/detect.js";
import { EXIT_CODES, type MigrationReport, type MigrateOptions } from "./types.js";

interface ParsedArgs extends MigrateOptions {
  help: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg: string = argv[i]!;
    switch (arg) {
      case "--vellum-root":
        parsed.vellumRoot = requireValue(argv[++i], arg);
        break;
      case "--cadet-root":
        parsed.cadetRoot = requireValue(argv[++i], arg);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--yes":
        parsed.yes = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown flag: ${arg}`);
        }
    }
  }
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`flag ${flag} requires a value`);
  }
  return value;
}

const HELP = `migrate-vellum-assistant-to-cadet

Migrate a vellum assistant workspace to cadet.

Steps: discover → detect → preflight → stop assistant → backup → migrate → verify

Usage:
  npx migrate-vellum-assistant-to-cadet [flags]

Flags:
  --vellum-root <path>     Override source root (discovered automatically
                           when omitted)
  --cadet-root <path>      Target root (default: ~/.cadet)
  --dry-run                Print the plan and touch nothing
  --yes                    Non-interactive; assume yes
  --json                   Machine-readable JSON report on stdout
  --verbose                Log every step to stderr
  -h, --help               Show this help

The vellum root is a read-only source of truth: nothing in it is ever
modified or deleted. A timestamped full backup with sha256 manifests is
written next to the cadet root before anything is migrated.

Exit codes:
  0  success (or already migrated + verified)
  2  no vellum root found
  3  preflight failed
  4  vellum processes refused to stop
  5  backup failed
  6  migration failed
  7  verification failed
  8  cadet root already populated (conflict)
  9  multiple candidate roots found in a non-interactive run
`;

async function resolveRoot(parsed: ParsedArgs): Promise<string | { ambiguous: string[] }> {
  if (parsed.vellumRoot) return parsed.vellumRoot;

  const candidates = await discoverVellumRoots();
  if (candidates.length === 0) return "";
  if (candidates.length === 1) return candidates[0]!.root;

  // Multiple plausible roots: ask when interactive, fail loudly otherwise.
  if (!parsed.json && process.stdin.isTTY) {
    return await promptForRoot(candidates);
  }
  return { ambiguous: candidates.map((c) => c.root) };
}

async function promptForRoot(
  candidates: Awaited<ReturnType<typeof discoverVellumRoots>>,
): Promise<string> {
  console.log(header("\n  Found multiple vellum installations:"));
  candidates.forEach((c, i) => {
    console.log(`    ${i + 1}. ${c.root} ${detail(`(${c.markers.slice(0, 3).join(", ")})`)}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(command("\n  Which one should be migrated? [1] "))).trim();
      if (answer === "") return candidates[0]!.root;
      const idx = Number(answer);
      if (Number.isInteger(idx) && idx >= 1 && idx <= candidates.length) {
        return candidates[idx - 1]!.root;
      }
      console.log(colors.yellow("    Enter a number from the list."));
    }
  } finally {
    rl.close();
  }
}

function renderHuman(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("  vellum → cadet migration"));
  lines.push(detail("  ─────────────────────────"));
  for (const step of report.steps) {
    const icon =
      step.status === "completed"
        ? successIcon()
        : step.status === "failed"
          ? failIcon()
          : step.status === "skipped"
            ? skipIcon()
            : detail("·");
    lines.push(`  ${icon} ${step.step.padEnd(20)} ${step.summary}`);
    for (const issue of step.issues ?? []) {
      lines.push(`    ${issue.severity === "error" ? colors.red("!") : detail("·")} ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
    }
  }
  lines.push("");

  if (report.ok) {
    lines.push(`  ${successIcon()} ${colors.green("Migration complete.")} Your assistant data now lives in:`);
    lines.push(`    ${command(report.detect.cadetRoot)}`);
    if (report.backupPath) {
      lines.push(`    ${detail(`A full backup of the vellum root is at ${report.backupPath}`)}`);
    }
    lines.push("");
    lines.push(`  ${header("Optional next steps")}`);
    lines.push(`    · Install and launch the cadet assistant, then sign in`);
    lines.push(`    · Once you've confirmed everything is there, delete the old copy:`);
    lines.push(`      ${command(`rm -rf ${report.detect.vellumRoot}`)}`);
  } else {
    lines.push(`  ${failIcon()} ${colors.red("Migration did not complete.")} ${detail("Nothing was deleted.")}`);
    if (report.backupPath) {
      lines.push(`    ${detail(`Your data is safe: ${report.backupPath}`)}`);
    }
    lines.push(`    ${detail(`Exit code: ${report.exitCode}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    console.error(HELP);
    return EXIT_CODES.preflightFailed;
  }

  if (parsed.help) {
    process.stdout.write(HELP);
    return EXIT_CODES.ok;
  }

  // Discover the vellum root unless explicitly overridden.
  const resolved = await resolveRoot(parsed);
  if (typeof resolved !== "string") {
    const message = [
      "multiple vellum installations found — pass --vellum-root with one of:",
      ...resolved.ambiguous.map((r) => `  ${r}`),
    ].join("\n");
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, exitCode: EXIT_CODES.ambiguousRoot, candidates: resolved.ambiguous }, null, 2)}\n`,
      );
    } else {
      console.error(message);
    }
    return EXIT_CODES.ambiguousRoot;
  }
  if (resolved === "") {
    const searched = candidateRoots().map((c) => c.root).join(", ");
    const message = `no vellum installation found (searched: ${searched}). Docker users: pass --vellum-root pointing at your mounted .vellum directory.`;
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, exitCode: EXIT_CODES.nothingToMigrate, searched: candidateRoots() }, null, 2)}\n`,
      );
    } else {
      console.error(message);
    }
    return EXIT_CODES.nothingToMigrate;
  }
  parsed.vellumRoot = resolved;
  if (!parsed.cadetRoot) parsed.cadetRoot = DEFAULT_CADET_ROOT;

  try {
    const report = await migrate(parsed);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderHuman(report));
    }
    return report.exitCode;
  } catch (err) {
    console.error(`migration crashed: ${(err as Error).message}`);
    if (parsed.verbose && (err as Error).stack) {
      console.error((err as Error).stack);
    }
    return EXIT_CODES.migrationFailed;
  }
}

process.exitCode = await main();
