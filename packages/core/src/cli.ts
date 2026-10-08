#!/usr/bin/env node
/**
 * CLI shell over the migration engine.
 *
 * Deliberately dependency-free so npx stays fast and the supply chain stays
 * boring. Runs on plain Node >= 18.17 — self-hosters don't need bun.
 */
import { createInterface } from "node:readline/promises";

import { colors, command, detail, errorText, failIcon, header, skipIcon, successIcon } from "./colors.js";
import { discoverVellumRoots, candidateRoots } from "./discover.js";
import { migrate } from "./runner.js";
import { toCadetRoot } from "./steps/detect.js";
import { EXIT_CODES, type MigrationReport, type MigrateOptions, type StepResult } from "./types.js";

interface ParsedArgs extends MigrateOptions {
  help: boolean;
  json: boolean;
  cadetRootExplicit: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    json: false,
    verbose: false,
    cadetRootExplicit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg: string = argv[i]!;
    switch (arg) {
      case "--cadet-root":
        parsed.cadetRoot = requireValue(argv[++i], arg);
        parsed.cadetRootExplicit = true;
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
  4  vellum processes still running after \`vellum sleep\`
  5  backup failed
  6  migration failed
  7  verification failed
  8  cadet root already populated (conflict)
  9  multiple candidate roots found in a non-interactive run
`;

async function resolveRoot(): Promise<string> {
  const candidates = await discoverVellumRoots();
  if (candidates.length === 0) return "";
  if (candidates.length === 1) return candidates[0]!.root;
  return await promptForRoot(candidates);
}

async function promptForRoot(
  candidates: Awaited<ReturnType<typeof discoverVellumRoots>>,
): Promise<string> {
  // Everything here goes to stderr so --json keeps stdout machine-readable.
  console.error(header("\n  Found multiple vellum installations:"));
  candidates.forEach((c, i) => {
    console.error(`    ${i + 1}. ${c.root} ${detail(`(${c.markers.slice(0, 3).join(", ")})`)}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // readline never resolves question() when stdin closes without input —
  // race it against close so piped/closed stdin fails fast instead of hanging.
  const closed = new Promise<never>((_, reject) => {
    rl.on("close", () => reject(new Error("stdin closed before a choice was made")));
  });
  try {
    for (;;) {
      const answer = (
        await Promise.race([
          rl.question(command("\n  Which one should be migrated? [1] ")),
          closed,
        ])
      ).trim();
      if (answer === "") return candidates[0]!.root;
      const idx = Number(answer);
      if (Number.isInteger(idx) && idx >= 1 && idx <= candidates.length) {
        return candidates[idx - 1]!.root;
      }
      console.error(colors.yellow("    Enter a number from the list."));
    }
  } finally {
    rl.close();
  }
}

function stepIcon(status: StepResult["status"]): string {
  return status === "completed"
    ? successIcon()
    : status === "failed"
      ? failIcon()
      : status === "skipped"
        ? skipIcon()
        : detail("·");
}

/**
 * Live step progress on stderr: a pending line the moment a step starts,
 * replaced in place by the completed line (icon + summary + issues) when it
 * finishes. Only when stderr is a TTY — piped runs and --json keep their
 * output contracts untouched.
 */
function createLiveProgress(): {
  onStepStart: (step: string) => void;
  onStepDone: (result: StepResult) => void;
  /** Clear a dangling pending line before the final summary prints. */
  finish: () => void;
} {
  const live = Boolean(process.stderr.isTTY);
  let pending = false;
  const clearPending = (): void => {
    if (live && pending) {
      // Cursor up one line, clear it.
      process.stderr.write("\u001b[1A\u001b[2K");
    }
    pending = false;
  };
  return {
    onStepStart: (step) => {
      clearPending();
      if (!live) return;
      process.stderr.write(`  ${detail("·")} ${step} …\n`);
      pending = true;
    },
    onStepDone: (result) => {
      clearPending();
      if (!live) return;
      process.stderr.write(`  ${stepIcon(result.status)} ${result.step.padEnd(20)} ${result.summary}\n`);
      for (const issue of result.issues ?? []) {
        process.stderr.write(
          `    ${issue.severity === "error" ? colors.red("!") : detail("·")} ${issue.message}\n`,
        );
      }
    },
    finish: clearPending,
  };
}

function renderHuman(report: MigrationReport, opts?: { stepsStreamedLive?: boolean }): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("  vellum → cadet migration"));
  lines.push(detail("  ─────────────────────────"));
  // In a TTY run the steps were already streamed live to stderr — repeating
  // them here would print the run twice.
  if (!opts?.stepsStreamedLive) {
    for (const step of report.steps) {
      lines.push(`  ${stepIcon(step.status)} ${step.step.padEnd(20)} ${step.summary}`);
      for (const issue of step.issues ?? []) {
        lines.push(`    ${issue.severity === "error" ? colors.red("!") : detail("·")} ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
      }
    }
    lines.push("");
  }

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
    console.error(errorText(String((err as Error).message)));
    console.error(HELP);
    return EXIT_CODES.preflightFailed;
  }

  if (parsed.help) {
    process.stdout.write(HELP);
    return EXIT_CODES.ok;
  }

  // Discover the vellum root.
  let resolved: string;
  try {
    resolved = await resolveRoot();
  } catch (err) {
    // No way to ask the user which root to migrate.
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, exitCode: EXIT_CODES.ambiguousRoot, error: (err as Error).message }, null, 2)}\n`,
      );
    } else {
      console.error(errorText(`could not determine which vellum installation to migrate: ${(err as Error).message}`));
    }
    return EXIT_CODES.ambiguousRoot;
  }
  if (resolved === "") {
    const searched = candidateRoots().map((c) => c.root).join(", ");
    const message = `no vellum installation found (searched: ${searched})`;
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, exitCode: EXIT_CODES.nothingToMigrate, searched: candidateRoots() }, null, 2)}\n`,
      );
    } else {
      console.error(errorText(message));
    }
    return EXIT_CODES.nothingToMigrate;
  }
  parsed.vellumRoot = resolved;
  if (!parsed.cadetRoot) parsed.cadetRoot = toCadetRoot(resolved);

  const live = !parsed.json && !parsed.verbose && Boolean(process.stderr.isTTY);
  const progress = createLiveProgress();
  try {
    const report = await migrate({
      ...parsed,
      onStepStart: live ? progress.onStepStart : undefined,
      onStepDone: live ? progress.onStepDone : undefined,
    });
    progress.finish();
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderHuman(report, { stepsStreamedLive: live }));
    }
    return report.exitCode;
  } catch (err) {
    progress.finish();
    console.error(errorText(`migration crashed: ${(err as Error).message}`));
    if (parsed.verbose && (err as Error).stack) {
      console.error((err as Error).stack);
    }
    return EXIT_CODES.migrationFailed;
  }
}

process.exitCode = await main();
