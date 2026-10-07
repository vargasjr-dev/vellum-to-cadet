#!/usr/bin/env node
/**
 * CLI shell over the migration engine.
 *
 * Deliberately dependency-free so npx stays fast and the supply chain stays
 * boring. Runs on plain Node >= 18.17 — self-hosters don't need bun.
 */
import { migrate } from "./runner.js";
import { EXIT_CODES, type MigrateOptions, type MigrationReport } from "./types.js";

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
      case "--remove-vellum-root":
        parsed.removeVellumRoot = true;
        break;
      case "--skip-stop-assistant":
        parsed.skipStopAssistant = true;
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

Steps: detect → preflight → stop assistant → backup → migrate → verify

Usage:
  npx migrate-vellum-assistant-to-cadet [flags]

Flags:
  --vellum-root <path>     Source root (default: ~/.vellum)
  --cadet-root <path>      Target root (default: ~/.cadet)
  --dry-run                Print the plan and touch nothing
  --remove-vellum-root     Delete ~/.vellum after a successful verify
                           (a full backup is kept either way)
  --skip-stop-assistant    Skip process termination (platform use only)
  --yes                    Non-interactive; assume yes
  --json                   Machine-readable JSON report on stdout
  --verbose                Log every step to stderr
  -h, --help               Show this help

Exit codes:
  0  success (or already migrated + verified)
  2  no vellum root found
  3  preflight failed
  4  vellum processes refused to stop
  5  backup failed
  6  migration failed
  7  verification failed
  8  cadet root already populated (conflict)

The old ~/.vellum root is never touched unless --remove-vellum-root is given;
a timestamped full backup with sha256 manifests is written first either way.
`;

function renderHuman(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  vellum → cadet migration");
  lines.push("  ─────────────────────────");
  for (const step of report.steps) {
    const icon =
      step.status === "completed"
        ? "✔"
        : step.status === "failed"
          ? "✖"
          : step.status === "skipped"
            ? "–"
            : "·";
    lines.push(`  ${icon} ${step.step.padEnd(20)} ${step.summary}`);
    for (const issue of step.issues ?? []) {
      lines.push(`    ${issue.severity === "error" ? "!" : "·"} ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
    }
  }
  lines.push("");
  if (report.ok) {
    lines.push("  ✔ Migration complete. Your assistant data now lives in:");
    lines.push(`    ${report.detect.cadetRoot}`);
    if (report.backupPath) {
      lines.push(`    A full backup of the vellum root is at: ${report.backupPath}`);
    }
    lines.push("  Next: install/launch the cadet assistant and sign in.");
  } else {
    lines.push("  ✖ Migration did not complete. Nothing was deleted.");
    if (report.backupPath) {
      lines.push(`    Your data is safe: ${report.backupPath}`);
    }
    lines.push(`    Exit code: ${report.exitCode}`);
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
