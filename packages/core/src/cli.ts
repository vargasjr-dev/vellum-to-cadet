#!/usr/bin/env node
/**
 * CLI shell over the migration engine.
 *
 * Deliberately dependency-free so npx stays fast and the supply chain stays
 * boring. Runs on plain Node >= 22.13 (node:sqlite) — self-hosters need nothing but node.
 */
import { createInterface } from "node:readline/promises";

import { colors, command, detail, errorText, failIcon, forceColor, header, skipIcon, successIcon, warnText } from "./colors.js";
import { errPath } from "./steps/migrate-layout.js";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync as fsExistsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverVellumRoots, searchedLocations, readRawVellumLockfile } from "./discover.js";
import { sniffBundleKind } from "./export-tar.js";
import { DEFAULT_VELLUM_ROOT } from "./steps/detect.js";
import { formatBytes, formatProgress } from "./fs-utils.js";
import { handleToInstanceName } from "./layout.js";
import { migrate, repair } from "./runner.js";
import { renderUninstallHuman, runUninstall } from "./uninstall.js";
import { cadetDataRoot } from "./steps/migrate-cli-state.js";
import { vellumVolumeNames } from "./steps/migrate-docker-volumes.js";
import {
  acquireRunLock,
  newRunLogPath,
  pidAlive,
  readRunLock,
  releaseRunLock,
  runLockPath,
  type RunLockInfo,
} from "./run-log.js";
import { EXIT_CODES, type ConfirmMigrationInfo, type MigrationReport, type MigrateOptions, type StepIssue, type StepItemEvent, type StepResult } from "./types.js";

interface ParsedArgs extends MigrateOptions {
  help: boolean;
  json: boolean;
  cadetRootExplicit: boolean;
  /** True when invoked as `repair [flags]` (post-migration fix-up mode). */
  repair: boolean;
  /** True when invoked as `uninstall [flags]` (point of no return). */
  uninstall: boolean;
  /** Run in this process (opt out of detaching — no relay, live TTY progress). */
  foreground: boolean;
  /** --internal-run: this process IS the detached migration (its stdio is the run-log). */
  internalRun: boolean;
  /** The run-log path handed down by the detaching parent (--run-log). */
  runLog?: string;
  /** The lock file handed down by the detaching parent (--internal-lock). */
  internalLock?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    json: false,
    verbose: false,
    cadetRootExplicit: false,
    repair: false,
    uninstall: false,
    foreground: false,
    internalRun: false,
  };
  const positionals: string[] = [];
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
      case "-y":
        parsed.yes = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--no-wake":
        parsed.noWake = true;
        break;
      case "--exclude":
        (parsed.exclude ??= []).push(requireValue(argv[++i], arg));
        break;
      case "--foreground":
        parsed.foreground = true;
        break;
      // Internal: the detaching parent hands these to the detached child.
      case "--run-log":
        parsed.runLog = requireValue(argv[++i], arg);
        break;
      case "--internal-run":
        parsed.internalRun = true;
        break;
      case "--internal-lock":
        parsed.internalLock = requireValue(argv[++i], arg);
        break;
      case "--bundle":
        parsed.bundlePath = requireValue(argv[++i], arg);
        break;
      case "--internal-vellum-root":
        parsed.vellumRoot = requireValue(argv[++i], arg);
        break;
      case "--internal-fresh-root":
        parsed.freshRoot = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown flag: ${arg}`);
        }
        positionals.push(arg);
    }
  }
  if (positionals[0] === "repair") {
    parsed.repair = true;
    positionals.shift();
  }
  if (positionals[0] === "uninstall") {
    parsed.uninstall = true;
    positionals.shift();
  }
  const root = positionals[0];
  if (root !== undefined) {
    if (positionals.length > 1) throw new Error(`unexpected extra argument: ${positionals[1]}`);
    parsed.cadetRoot = root;
    parsed.cadetRootExplicit = true;
  }
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`flag ${flag} requires a value`);
  }
  return value;
}

const UNINSTALL_HELP = `migrate-vellum-assistant-to-cadet uninstall

Permanently deletes every vellum installation on this machine (data is
unrecoverable — the cadet assistant and migration backups are safe) and
removes the migrator itself; run with --dry-run to list what would go,
--yes to skip the DELETE confirmation.

Exit codes: 0 success · 10 not confirmed · 11 deletion failed
`;

const HELP = `migrate-vellum-assistant-to-cadet

Migrate a vellum assistant workspace to cadet.

Steps: discover → detect → preflight → stop assistant → migrate → lockfile → retired → verify → install cadet → wake assistants

Usage:
  npx migrate-vellum-assistant-to-cadet [flags]
  npx migrate-vellum-assistant-to-cadet repair [flags]
  npx migrate-vellum-assistant-to-cadet uninstall [flags]

Flags:
  --cadet-root <path>      Target root (default: ~/.cadet)
  --bundle <path>          Restore an assistant backup into the vellum root first (as a
                           new assistant), then migrate it like any other — a legacy
                           .vbundle or a vellum.ai/export tar (its three volumes at the
                           archive's top level); additive, the root's own assistants
                           are untouched. With no vellum installation found, the
                           bundle BOOTSTRAPS one: a fresh modern root is created and
                           the bundle restores into it as its first assistant
  --dry-run                Print the plan and touch nothing
  -y, --yes                Non-interactive; assume yes (skips the pre-migration
                           confirmation)
  --json                   Machine-readable JSON report on stdout
  --verbose                Log every step to stderr
  --no-wake                Do everything except the final wake — install, register, and
                           migrate, but leave the assistant(s) asleep ("cadet wake --all"
                           when you're ready)
  --exclude <glob>         Skip matching files from the copy (repeatable). Matches the
                           source-relative path or basename: "*.db", "assistant-logs.db",
                           "logs/" prunes a directory. Structural files are never skipped
  --foreground             Run in this process (default: detached — survives
                           disconnects; logs: ~/.cadet-migration-logs/)
  -h, --help               Show this help

Repair mode re-runs the idempotent value steps (content rewrites + db value
migrations) against EVERY migrated cadet root on the machine — for when a
migration bug is found after the cadet assistants have been in use. It takes
no path: the roots self-discover via their migration manifests (it only
repairs roots this migrator created), stops all cadet assistants with
\`cadet sleep --all\`, takes a fresh timestamped backup of each root, then
verifies in place. No layout copy, no renames, no vellum-root involvement.

The vellum root is a read-only source of truth: nothing in it is ever
modified or deleted, and nothing is copied out for backup — the untouched
original IS the backup. (Repair mode, which mutates a cadet root in place,
does take a timestamped backup of that root first.)

Exit codes:
  0  success (or already migrated + verified)
  2  no vellum root found (a --bundle run instead bootstraps a fresh root)
  3  preflight failed
  5  backup failed
  6  migration failed
  7  verification failed
  8  cadet root already populated (conflict)
  9  multiple candidate roots found in a non-interactive run
`;

/** Thrown when a --bundle bootstrap fails before any root is created. */
class BundleBootstrapError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Root resolution for migration runs: plain discovery (resolveRoot), plus
 * bundle bootstrapping — with --bundle and NO discovered installation, the
 * archive itself becomes the install. Vargas's direction, from a user run
 * that died exit-2 on a machine that had never run vellum: "we would have
 * untarred the .tar bundle into a modern vellum workspace, before
 * proceeding with the rest of the migration". The fresh root lands at
 * VELLUM_DATA_DIR when the discovery env names one, else the default
 * ~/.vellum; the bundle restores into it as its first assistant (modern
 * layout, see extract-bundle's freshRoot) and the rest of the migrator
 * proceeds unchanged. The archive is sniffed HERE so garbage fails before
 * anything is created. Returns root:"" only when there is no root AND no
 * bundle — the caller's no-root report stands for that case.
 */
async function resolveRootForRun(
  parsed: ParsedArgs,
): Promise<{ root: string; fresh: false } | { root: string; fresh: true; kind: string }> {
  const candidates = await discoverVellumRoots();
  if (candidates.length === 1) return { root: candidates[0]!.root, fresh: false };
  if (candidates.length > 1) return { root: await promptForRoot(candidates), fresh: false };
  if (!parsed.bundlePath) return { root: "", fresh: false };
  const kind = await sniffBundleKind(parsed.bundlePath);
  if (kind === "unknown") {
    throw new BundleBootstrapError(
      EXIT_CODES.migrationFailed,
      "--bundle: unrecognized archive — expected a .vbundle assistant backup or a vellum.ai/export tar " +
        "(the archive's contents don't parse as a tar)",
    );
  }
  return { root: process.env["VELLUM_DATA_DIR"] || DEFAULT_VELLUM_ROOT, fresh: true, kind };
}

/** The bootstrap notice (stderr — --json keeps stdout machine-readable). */
function printBootstrapNotice(root: string, kind: string): void {
  console.error(
    detail(
      `no vellum installation found — bootstrapping a fresh vellum root from the ` +
        `${kind === "vbundle" ? ".vbundle backup" : "vellum.ai/export tar"} at ${root}`,
    ),
  );
}

/**
 * The no-root failure report. The searched list names EVERY location
 * discovery looked at — the root dirs (legacy env/home + the modern XDG
 * root) and every lockfile path; a report listing only the legacy home
 * root reads like the modern layout and the docker-tracked installs were
 * never looked for. When a vellum lockfile EXISTS, the message says so:
 * a docker-tracked install keeps its record there, and its root directory
 * on disk may be missing or carry no trusted marker.
 */
async function noRootReport(): Promise<{ message: string; searched: string[] }> {
  const searched = await searchedLocations();
  const lockfile = await readRawVellumLockfile();
  const message = lockfile
    ? `found a vellum lockfile (${lockfile.path}) but no vellum root directory on disk (searched: ${searched.join(", ")})`
    : `no vellum installation found (searched: ${searched.join(", ")})`;
  return { message, searched };
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
 * finishes. Steps can stream nested items (e.g. each retired archive) that
 * open their own pending line under the step and resolve in place.
 *
 * Live when stderr is a TTY, and FORCED live for the detached run-log
 * child (v0.0.13 run feedback: append-only log lines made the relayed
 * view print every step twice and every progress tick as a new line).
 * The child's stderr IS the run-log file, but the parent relays those
 * bytes to a real terminal — so the child renders the same cursor-math
 * stream a TTY would get, the relay replays it in place, and a later
 * `tail -f` of the log does the same. Piped runs and --json keep their
 * output contracts untouched (live stays off).
 */
function createLiveProgress(force = false): {
  onStepStart: (step: string) => void;
  onStepDone: (result: StepResult) => void;
  onStepItem: (step: string, item: StepItemEvent) => void;
  /** Clear a dangling pending line before the final summary prints. */
  finish: () => void;
} {
  const live = force || Boolean(process.stderr.isTTY);
  let pending = false;
  let openItems = 0; // nested item lines still pending
  let itemLines = 0; // nested item lines written for the current step
  let lastProgressSummary = "";
  const eraseLines = (n: number): void => {
    for (let i = 0; i < n; i++) process.stderr.write("\u001b[1A\u001b[2K");
  };
  const resetItems = (): void => {
    openItems = 0;
    itemLines = 0;
  };
  const clearPending = (): void => {
    if (live && pending) {
      // Erase the pending step line and every nested line below it.
      eraseLines(1 + itemLines);
    }
    pending = false;
    resetItems();
  };
  return {
    onStepStart: (step) => {
      clearPending();
      if (!live) return;
      process.stderr.write(`  ${detail("·")} ${step} …\n`);
      pending = true;
    },
    onStepItem: (step, item) => {
      if (!live || !pending) return;
      if (item.status === "progress" && item.progress) {
        const summary = progressSummary(item.progress);
        if (summary === lastProgressSummary) return;
        lastProgressSummary = summary;
        // The open item's line is the last one written — rewrite it
        // in place with the fresh counts.
        process.stderr.write("\u001b[1A\u001b[2K");
        process.stderr.write(`    ${detail("·")} ${item.name} … ${summary}\n`);
        return;
      }
      if (item.status === "started") {
        process.stderr.write(`    ${detail("·")} ${item.name} …\n`);
        openItems++;
        itemLines++;
        return;
      }
      if (openItems === 0) return;
      // Resolve the open item's line: rewritten in place.
      process.stderr.write("\u001b[1A\u001b[2K");
      const icon = item.status === "completed" ? colors.green("✓") : colors.yellow("⚠");
      process.stderr.write(`    ${icon} ${item.name}${item.summary ? ` ${item.summary}` : ""}\n`);
      openItems--;
    },
    onStepDone: (result) => {
      if (live && pending) {
        // Rewrite the pending step line above the already-resolved nested
        // lines (they stay on screen), then hop back down past them. A
        // multi-line summary (the nested detect output) pushes those lines
        // further down by its extra lines — hop accordingly.
        const nested = itemLines;
        const extra = result.summary.split("\n").length - 1;
        process.stderr.write(`\u001b[${nested + 1}A\u001b[2K`);
        process.stderr.write(stepLines(result).join("\n") + "\n");
        process.stderr.write(`\u001b[${nested + extra}B\r`);
      } else {
        if (!live) return;
        // No pending line to rewrite — write the completed line fresh.
        process.stderr.write(stepLines(result).join("\n") + "\n");
      }
      pending = false;
      resetItems();
      for (const issue of result.issues ?? []) {
        process.stderr.write(`    ${issueIcon(issue.severity)} ${issue.message}\n`);
      }
    },
    finish: clearPending,
  };
}

/** A step's display lines: the step line, then the summary's continuation lines. */
function stepLines(result: StepResult): string[] {
  const [original, ...rest] = result.summary.split("\n");
  let first = original;
  if (result.step === "migrate-lockfile") {
    const match = original?.match(/wrote the cadet lockfile at ([^;(]+)(.*)/);
    if (match) {
      first = `wrote the cadet lockfile at ${match[1]!.trim().replace(os.homedir() + path.sep, "~/")}`;
      if (match[2]?.trim()) rest.push(`    · ${match[2].trim().replace(/^;\s*/, "")}`);
    }
  }
  const lines = [`  ${stepIcon(result.status)} ${result.step === "migrate-lockfile" ? "" : result.step.padEnd(20) + " "}${first ?? ""}`];
  // Continuation lines carry their own indent (the detect summary's
  // per-assistant branches) — write them verbatim.
  lines.push(...rest);
  return lines;
}

/** Nested bullet for a step issue: red ! for errors, yellow ⚠ for warnings, dim · for info. */
function issueIcon(severity: StepIssue["severity"]): string {
  return severity === "error" ? colors.red("!") : severity === "warning" ? colors.yellow("⚠") : detail("·");
}

/** `1.2GB/4.0GB (30%)` with an optional volume label. */
function progressSummary(p: NonNullable<StepItemEvent["progress"]>): string {
  const size = formatProgress(p.bytes, p.totalBytes);
  return p.label ? `${p.label} ${size}` : size;
}

/** Already-running banner: who owns the run lock, and how to watch it. */
function printAlreadyRunning(lock: RunLockInfo): void {
  console.error(warnText(`  ⚠ a migration is already running (pid ${lock.pid}${lock.startedAt ? `, started ${lock.startedAt}` : ""})`));
  console.error(`    logs: ${lock.logPath}`);
  console.error(`    ${detail("follow along:")} tail -f ${lock.logPath}`);
}

/** The started line: the header, then the pid + run-log as nested bullets. */
function printStarted(pid: number, logPath: string): void {
  process.stdout.write(`  ${successIcon()} ${"started".padEnd(20)} Begun Vellum to Cadet migration\n`);
  process.stdout.write(`    ${detail("·")} pid ${pid}\n`);
  process.stdout.write(`    ${detail("·")} logs: ${logPath}\n`);
}

/**
 * The pre-migration confirmation screen (v0.0.15 field feedback): the
 * assistants about to sleep, the bytes moving, and — when the cadet root
 * already exists — the note that lets the user clear it FIRST.
 */
function renderConfirmPrompt(info: ConfirmMigrationInfo): string {
  const lines: string[] = [];
  lines.push(`\n  ${warnText("⚠ About to migrate:")}`);
  if (info.assistants.length > 0) {
    for (const assistant of info.assistants) {
      lines.push(
        `    ${detail("·")} assistant ${assistant.name}${assistant.docker ? " (docker)" : ""} — will be put to sleep`,
      );
    }
  } else {
    lines.push(`    ${detail("·")} no lockfile-tracked assistants found`);
  }
  lines.push(`    ${detail("·")} vellum root: ${info.vellumRoot} (${formatBytes(info.rootSizeBytes)} on disk)`);
  if (info.dockerVolumeCount > 0) {
    const size = info.dockerVolumeBytes !== null ? ` (~${formatBytes(info.dockerVolumeBytes)})` : "";
    lines.push(
      `    ${detail("·")} docker volumes: ${info.dockerVolumeCount} to fetch${size} — extracted to a scratch dir on this Mac, then imported into new cadet volumes`,
    );
  }
  if (info.retiredCount > 0) {
    lines.push(`    ${detail("·")} ${info.retiredCount} retired assistant archive(s) migrate too`);
  }
  if (info.cadetRootExists) {
    lines.push(
      `    ${detail("·")} cadet root ${cadetDataRoot(info.cadetRoot)} ALREADY EXISTS — its data will be updated in place; delete it first for a clean start`,
    );
  } else {
    lines.push(`    ${detail("·")} cadet root: ${cadetDataRoot(info.cadetRoot)}`);
  }
  lines.push("");
  lines.push(`  Press ${command("Enter")} to continue, Ctrl-C to cancel (skip this prompt with --yes).`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Print the confirmation screen and wait for Enter. Ctrl-C aborts the
 * process (the shell's exit code carries it). A CLOSED stdin — piped and
 * cron runs — resolves as PROCEED: the interactive terminal is the case
 * that waits; question() on an already-closed input never settles, which
 * wedged the whole run (caught by the smoke).
 */
async function promptConfirmMigration(info: ConfirmMigrationInfo): Promise<boolean> {
  process.stderr.write(renderConfirmPrompt(info));
  if (!process.stdin.readable) return true;
  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.on("close", () => settle(true));
    rl.question("")
      .then(() => settle(true))
      .catch(() => settle(true));
  });
}

/**
 * The install-cadet sudo retry: report the permission wall, then ask
 * (Vargas's followup on the error-surface PR — instead of telling the user to
 * run the sudo install themselves, we offer to do it). Reachable only from a
 * process with the user's terminal: sudo's password prompt needs the TTY, so
 * the detached worker asks its attached launcher over IPC and the LAUNCHER
 * (or a foreground run, same process) spawns the sudo install.
 */
function renderSudoRetryPrompt(info: { npmRoot: string | null }): string {
  const lines = [
    "",
    warnText("⚠ the cadet CLI install hit a permission wall"),
    `    ${detail("·")} npm could not install mycadet into its global directory${info.npmRoot ? ` (${info.npmRoot})` : ""} — permission denied.`,
    `    ${detail("·")} Your assistants are migrated; they just need the cadet CLI to start.`,
    "",
    `  Would you like us to try installing ${command("\`mycadet\`")} again as sudo? (You may be asked for your password.)`,
    `  ${command("Enter")} = yes · ${command("n")} = no (the manual fix prints with the results)`,
    "",
  ];
  return lines.join("\n");
}

async function promptSudoRetry(info: { npmRoot: string | null }): Promise<{ ok: boolean; detail?: string }> {
  process.stderr.write(renderSudoRetryPrompt(info));
  if (!process.stdin.readable) {
    return { ok: false, detail: "no terminal to answer the retry prompt" };
  }
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.on("close", () => settle("n"));
    rl.question("")
      .then((a) => settle(a.trim().toLowerCase()))
      .catch(() => settle("n"));
  });
  if (answer.startsWith("n")) return { ok: false, detail: "you declined the sudo retry" };
  return runSudoInstall();
}

function runSudoInstall(): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["npm", "install", "-g", "mycadet"], { stdio: "inherit" });
    child.on("error", (err) => resolve({ ok: false, detail: `sudo could not start: ${err.message}` }));
    child.on("close", (code) =>
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, detail: `sudo npm install -g mycadet exited ${code ?? "without a code"}` },
      ),
    );
  });
}

/**
 * The default `migrate` flow (v0.0.12 run feedback: the SSH session died
 * mid fetch-docker-volumes and took the migration with it). The heavy work
 * runs in a DETACHED child that survives disconnects; this process
 * resolves the vellum root while the terminal is still attached (a
 * multi-root prompt needs stdin, which the detached child will not have),
 * takes the run lock and relays the child's log to stdout until it exits.
 * The child logs started, detect, and preflight, then asks this launcher
 * to confirm through IPC before continuing independently.
 * With the session gone, the log file is the migration's tail-able record.
 */
async function detachedMigrate(parsed: ParsedArgs): Promise<number> {
  const lockPath = runLockPath();

  // An already-running migration wins: point at it and get out.
  const existing = await readRunLock(lockPath);
  if (existing && pidAlive(existing.pid)) {
    printAlreadyRunning(existing);
    return EXIT_CODES.alreadyRunning;
  }

  // Resolve the vellum root HERE — interactively, while stdin still works.
  // --bundle bootstraps: no installation found → the archive becomes one.
  let resolved: string;
  let fresh = false;
  try {
    const resolution = await resolveRootForRun(parsed);
    resolved = resolution.root;
    if (resolution.fresh) {
      fresh = true;
      parsed.freshRoot = true;
      printBootstrapNotice(resolution.root, resolution.kind);
    }
  } catch (err) {
    if (err instanceof BundleBootstrapError) {
      console.error(errorText(err.message));
      return err.exitCode;
    }
    console.error(errorText(`could not determine which vellum installation to migrate: ${(err as Error).message}`));
    return EXIT_CODES.ambiguousRoot;
  }
  if (resolved === "") {
    const { message } = await noRootReport();
    console.error(errorText(message));
    return EXIT_CODES.nothingToMigrate;
  }
  parsed.vellumRoot = resolved;

  const logPath = newRunLogPath();
  const startedAt = new Date().toISOString();
  if (!(await acquireRunLock(lockPath, { pid: process.pid, startedAt, logPath }))) {
    const holder = await readRunLock(lockPath);
    if (holder) printAlreadyRunning(holder);
    return EXIT_CODES.alreadyRunning;
  }

  // Re-exec this same entry fully detached. Both the published alias shim
  // and dist/cli.js are plain node entry points; --internal-run stops the
  // child from detaching again. The log file doubles as the child's
  // stdout + stderr, so every line the child prints lands in the log.
  const entry = process.argv[1];
  if (!entry) {
    console.error(errorText("could not resolve the CLI entry point to detach"));
    await releaseRunLock(lockPath, process.pid);
    return EXIT_CODES.migrationFailed;
  }
  const logFd = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      entry,
      ...process.argv.slice(2),
      "--internal-run",
      "--run-log",
      logPath,
      "--internal-lock",
      lockPath,
      "--internal-vellum-root",
      resolved,
      ...(fresh ? ["--internal-fresh-root"] : []),
    ],
    { detached: true, stdio: ["ignore", logFd, logFd, "ipc"] },
  );
  child.unref();
  const relayed = relayChild(logPath, child);

  // The child outlives this process (that is the point) — the lock must
  // name IT, so a re-run while the relay is dead still finds the owner.
  await fsPromises.writeFile(
    lockPath,
    JSON.stringify({ pid: child.pid ?? process.pid, startedAt, logPath } satisfies RunLockInfo),
  );

  const code = await relayed;
  await releaseRunLock(lockPath, child.pid ?? -1);
  return code;
}

/**
 * Relay the detached child's run-log to this process's stdout until the
 * child exits — the caller sees the migration as if it ran in-process,
 * while the child itself is immune to the SSH session dying. Reads by
 * byte offset (the file is appended by another process) with a final
 * drain after the child closes.
 */
async function relayChild(logPath: string, child: ChildProcess): Promise<number> {
  child.on(
    "message",
    async (message: { type?: string; info?: ConfirmMigrationInfo & { npmRoot?: string | null } }) => {
      if (message.type === "confirm" && message.info) {
        await drainLog();
        const confirmed = await promptConfirmMigration(message.info);
        if (child.connected) child.send({ type: "confirmed", confirmed });
        return;
      }
      if (message.type === "ask-sudo" && message.info) {
        await drainLog();
        const outcome = await promptSudoRetry({ npmRoot: message.info.npmRoot ?? null });
        if (child.connected) child.send({ type: "sudo-result", ok: outcome.ok, detail: outcome.detail });
      }
    },
  );
  // The relayed bytes are the child's terminal stream (cursor math + color,
  // see createLiveProgress). A real terminal renders them as if the
  // migration ran in-process; when THIS process's stdout is not a terminal
  // (piped runs), strip the escape sequences so the piped contract stays
  // plain text.
  const plain = !process.stdout.isTTY;
  const ansi = /\u001b\[[0-9;]*[A-Za-z]|\r/g;
  const decoder = new TextDecoder("utf8"); // stream mode holds split multibyte chars
  let carry = ""; // a trailing partial escape sequence, finished by the next chunk
  let exitCode: number | null = null;
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(EXIT_CODES.migrationFailed));
    child.on("close", (code) => resolve(code ?? EXIT_CODES.migrationFailed));
  });
  let offset = 0;
  let draining = Promise.resolve();
  for (;;) {
    await drainLog();
    if (exitCode !== null) {
      flushCarry();
      return exitCode;
    }
    const winner = await Promise.race([
      exited.then((code) => ({ done: true as const, code })),
      new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 200)),
    ]);
    if (winner.done) exitCode = winner.code;
  }

  function flushCarry(): void {
    if (!carry) return;
    process.stdout.write(plain ? carry.replace(ansi, "") : carry);
    carry = "";
  }

  function drainLog(): Promise<void> {
    draining = draining.then(readLogOnce);
    return draining;
  }

  async function readLogOnce(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await fsPromises.open(logPath, "r");
      const { size } = await handle.stat();
      if (size <= offset) return;
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset += buffer.length;
      const chunk = carry + decoder.decode(buffer, { stream: true });
      carry = "";
      // Hold back a trailing partial escape sequence (the ESC may have
      // landed in this chunk, its terminator in the next).
      let out = chunk;
      const lastEsc = chunk.lastIndexOf("\u001b");
      if (lastEsc !== -1 && !/[A-Za-z]/.test(chunk.slice(lastEsc + 1))) {
        out = chunk.slice(0, lastEsc);
        carry = chunk.slice(lastEsc);
      }
      process.stdout.write(plain ? out.replace(ansi, "") : out);
    } catch {
      // The log file may not exist yet (child still spinning up).
    } finally {
      await handle?.close();
    }
  }
}

/** Sync exit-handler lock release — 'exit' handlers must not await. */
function releaseLockOnExit(lockPath: string): void {
  process.on("exit", () => {
    try {
      const holder = JSON.parse(readFileSync(lockPath, "utf8")) as RunLockInfo;
      if (holder.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // Nothing to release (never acquired, or already broken by a re-run).
    }
  });
}

/**
 * Mirror every stdout/stderr write into the run-log (--foreground mode).
 * Cursor-movement escapes are stripped so the file reads as clean lines —
 * a disconnect kills a foreground run, but not its record.
 */
function teeProcessOutput(logPath: string): void {
  const stripCursorCodes = (chunk: string | Uint8Array): string => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return text.replace(/\u001b\[\d*[A-K]/g, "");
  };
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (chunk: string | Uint8Array, cb?: () => void) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      try {
        appendFileSync(logPath, stripCursorCodes(chunk));
      } catch {
        // The log is best-effort — never block the run on it.
      }
      const cb = [...rest].reverse().find((r): r is () => void => typeof r === "function");
      return original(chunk, cb);
    }) as typeof stream.write;
  }
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
      if (step.quiet) continue;
      lines.push(...stepLines(step));
      for (const issue of step.issues ?? []) {
        lines.push(`    ${issueIcon(issue.severity)} ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
      }
    }
    lines.push("");
  }

  if (report.ok) {
    if (report.mode === "repair") {
      lines.push(
        `  ${successIcon()} ${colors.green("Repair complete.")} The cadet root was re-verified in place:`,
      );
      lines.push(`    ${command(report.detect.cadetRoot)}`);
      lines.push(`    ${detail(`Total time: ${humanDuration(report.durationMs)}`)}`);
      if (report.backupPath) {
        lines.push(`    ${detail(`A full backup of the cadet root is at ${report.backupPath}`)}`);
      }
      lines.push(...nextStepLines(report));
      lines.push("");
      return lines.join("\n");
    }
    lines.push(`  ${successIcon()} ${colors.green("Migration complete.")} Your assistant data now lives in:`);
    // Docker assistants keep their data in the cadet DOCKER VOLUMES — the
    // root line names the cadet root itself, never a local instance dir
    // (v0.0.15 field feedback: "I do not expect local assistant data if
    // it's a docker assistant").
    const dockerInstances = report.detect.docker.instances;
    if (dockerInstances.length > 0) {
      lines.push(`    ${command(cadetDataRoot(report.detect.cadetRoot))}`);
      for (const instance of dockerInstances) {
        lines.push(
          `    ${detail(`· docker volumes: cadet-${handleToInstanceName(instance)}-{workspace,gateway-sec,ces-sec}`)}`,
        );
      }
    } else {
      lines.push(`    ${command(report.detect.cadetRoot)}`);
    }
    lines.push(`    ${detail(`Total time: ${humanDuration(report.durationMs)}`)}`);
    lines.push(...nextStepLines(report));
    lines.push("");
    lines.push(`  Once you've confirmed your Cadet is online, you can optionally delete vellum for good:`);
    lines.push(`      ${command(`npx migrate-vellum-assistant-to-cadet uninstall`)}`);
  } else {
    lines.push(`  ${failIcon()} ${colors.red("Migration did not complete.")} ${detail("Nothing was deleted.")}`);
    lines.push(`    ${detail(`Your data is safe: the vellum root at ${report.detect.vellumRoot} was not modified.`)}`);
    lines.push(`    ${detail(`Exit code: ${report.exitCode}`)}`);
    lines.push(`    ${detail(`Total time: ${humanDuration(report.durationMs)}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * End-of-run follow-ups (e.g. the speech cutover's "add an API key"
 * reminders), rendered as ⚠ warnings under their own "Next steps" block so
 * they stay on screen after the step stream scrolls away.
 */
function nextStepLines(report: MigrationReport): string[] {
  const steps = report.nextSteps ?? [];
  if (steps.length === 0) return [];
  const lines = [`  ${issueIcon("warning")} ${colors.yellow("Next steps:")}`];
  for (const step of steps) {
    lines.push(`    ${issueIcon("warning")} ${step}`);
  }
  return lines;
}

/** Wall-clock duration, human-formatted: 1h 2m 3s / 4m 12s / 38s. */
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** First node version where node:sqlite is no longer experimental (v25.7 made it a release candidate). */
const RECOMMENDED_NODE_MAJOR = 26;

/** The nvm shell shim, when the machine has one. */
function nvmShim(): string | null {
  const candidates = [
    process.env.NVM_DIR ? `${process.env.NVM_DIR}/nvm.sh` : null,
    `${os.homedir()}/.nvm/nvm.sh`,
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (fsExistsSync(candidate)) return candidate;
  }
  return null;
}

function nvmBash(shim: string, script: string): string {
  return `source '${shim}' >/dev/null 2>&1 && ${script}`;
}

/**
 * Older nodes print a node:sqlite experimental warning (it stops being
 * experimental in v25.7). Rather than asking the user to fix it: when the
 * machine has nvm, save the running version, install the recommended one,
 * and re-exec this CLI under it — the previous version is restored at the
 * end of the script (it is never uninstalled, and nvm's default alias is
 * never re-pointed). Without nvm, fall back to a one-line recommendation.
 */
function ensureRecommendedNode(): void {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (major >= RECOMMENDED_NODE_MAJOR) return;
  if (process.env.CADET_NVM_SWAPPED) return; // Already running on the swap.

  const shim = nvmShim();
  if (!shim) {
    console.error(
      warnText(
        `  ⚠ node ${process.versions.node} — node ${RECOMMENDED_NODE_MAJOR}+ is recommended.`,
      ),
    );
    return;
  }

  const previous = process.versions.node;
  console.error(
    detail(
      `  · node ${previous} is older than recommended — installing node ${RECOMMENDED_NODE_MAJOR} via nvm…`,
    ),
  );
  // Stream nvm's own install output instead of swallowing it: the first
  // download is slow, and silence after the "installing…" line reads as a
  // hang. fd 2 keeps --json's stdout machine-readable.
  const installed = spawnSync("bash", ["-c", nvmBash(shim, `nvm install ${RECOMMENDED_NODE_MAJOR}`)], {
    stdio: ["ignore", 2, 2],
  });
  let nodeBin = "";
  if (installed.status === 0) {
    try {
      const out = execFileSync(
        "bash",
        ["-c", nvmBash(shim, `nvm which ${RECOMMENDED_NODE_MAJOR}`)],
        { encoding: "utf8" },
      );
      nodeBin = out.trim().split("\n").filter(Boolean).pop() ?? "";
    } catch {
      // Fall through to the recommendation.
    }
  }
  if (!nodeBin || !fsExistsSync(nodeBin)) {
    console.error(
      warnText(
        `  ⚠ node ${previous} — node ${RECOMMENDED_NODE_MAJOR}+ is recommended (nvm install failed; continuing).`,
      ),
    );
    return;
  }

  const entry = process.argv[1];
  if (!entry) return;
  try {
    const result = spawnSync(nodeBin, [entry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, CADET_NVM_SWAPPED: previous },
    });
    // End of script: restore the previous node version.
    spawnSync("bash", [
      "-c",
      nvmBash(shim, `nvm use ${previous} >/dev/null 2>&1 || true`),
    ]);
    process.exit(result.status ?? 1);
  } catch {
    console.error(
      warnText(
        `  ⚠ could not re-exec under node ${RECOMMENDED_NODE_MAJOR}; continuing on ${previous}.`,
      ),
    );
  }
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
    process.stdout.write(parsed.uninstall ? UNINSTALL_HELP : HELP);
    return EXIT_CODES.ok;
  }
  // One check, AFTER the help branch: --help must not install a node
  // version, and a single call means a no-nvm machine never prints the
  // recommendation twice.
  ensureRecommendedNode();

  // Repair mode: re-run the idempotent value steps against every already-
  // migrated cadet root. Deliberately SKIPS all vellum-root discovery —
  // and takes NO path: the roots self-discover via their migration
  // manifests, so there is no root argument to get wrong.
  if (parsed.repair) {
    if (parsed.cadetRoot) {
      console.error(
        errorText(
          "repair self-discovers migrated cadet roots; pass no root — every root the migrator created is repaired",
        ),
      );
      return EXIT_CODES.preflightFailed;
    }
    const live = !parsed.json && !parsed.verbose && Boolean(process.stderr.isTTY);
    const progress = createLiveProgress();
    try {
      const report = await repair({
        dryRun: parsed.dryRun,
        verbose: parsed.verbose,
        onStepStart: live ? progress.onStepStart : undefined,
        onStepDone: live ? progress.onStepDone : undefined,
        onStepItem: live ? progress.onStepItem : undefined,
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
      console.error(errorText(`repair crashed: ${(err as Error).message}`));
      if (parsed.verbose && (err as Error).stack) {
        console.error((err as Error).stack);
      }
      return EXIT_CODES.migrationFailed;
    }
  }

  // Uninstall mode: the point of no return. Skips root resolution —
  // discovery inside runUninstall finds and gates every target itself.
  if (parsed.uninstall) {
    if (parsed.cadetRoot) {
      console.error(errorText("uninstall takes no root — it removes every vellum installation it finds"));
      return EXIT_CODES.preflightFailed;
    }
    try {
      const report = await runUninstall({
        dryRun: parsed.dryRun,
        yes: parsed.yes,
        json: parsed.json,
        verbose: parsed.verbose,
      });
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(renderUninstallHuman(report));
      }
      return report.exitCode;
    } catch (err) {
      console.error(errorText(`uninstall crashed: ${(err as Error).message}`));
      if (parsed.verbose && (err as Error).stack) {
        console.error((err as Error).stack);
      }
      return EXIT_CODES.uninstallFailed;
    }
  }

  if (parsed.bundlePath && (parsed.repair || parsed.uninstall)) {
    console.error(errorText("--bundle applies to migration runs only"));
    return EXIT_CODES.migrationFailed;
  }
  if (parsed.bundlePath) {
    let stat: Awaited<ReturnType<typeof fsPromises.stat>> | null = null;
    try {
      stat = await fsPromises.stat(parsed.bundlePath);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) {
      console.error(errorText(`--bundle: no such file: ${parsed.bundlePath}`));
      return EXIT_CODES.migrationFailed;
    }
    if (parsed.bundlePath.endsWith(".enc")) {
      console.error(
        errorText(
          "--bundle: encrypted .vbundle.enc backups are not supported — the keys that " +
            "encrypted them are gone with the old install; restore the unencrypted export",
        ),
      );
      return EXIT_CODES.migrationFailed;
    }
  }

  // The default run DETACHES (v0.0.12 run feedback: the SSH session died
  // mid fetch-docker-volumes and took the migration with it). --json
  // (scripts parse this process's stdout), --dry-run (read-only, quick),
  // --foreground (opt back into the old in-process behavior) and
  // --internal-run (this IS the detached child) stay here.
  if (!parsed.json && !parsed.dryRun && !parsed.foreground && !parsed.internalRun) {
    return await detachedMigrate(parsed);
  }

  // Foreground runs tee everything into a run-log too — a disconnect
  // kills the run, but not its record.
  if (parsed.foreground && !parsed.json && !parsed.runLog) {
    parsed.runLog = newRunLogPath();
    teeProcessOutput(parsed.runLog);
  }

  // Discover the vellum root — except for the detached child, which was
  // handed the resolved one (discovery ran in the parent, where prompts
  // still had a terminal).
  let resolved: string;
  if (parsed.internalRun && parsed.vellumRoot) {
    resolved = parsed.vellumRoot;
  } else {
    try {
      const resolution = await resolveRootForRun(parsed);
      resolved = resolution.root;
      if (resolution.fresh) {
        parsed.freshRoot = true;
        if (!parsed.json) printBootstrapNotice(resolution.root, resolution.kind);
      }
    } catch (err) {
      if (err instanceof BundleBootstrapError) {
        if (parsed.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, exitCode: err.exitCode, error: err.message }, null, 2)}\n`,
          );
        } else {
          console.error(errorText(err.message));
        }
        return err.exitCode;
      }
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
      const { message, searched } = await noRootReport();
      if (parsed.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, exitCode: EXIT_CODES.nothingToMigrate, searched }, null, 2)}\n`,
        );
      } else {
        console.error(errorText(message));
      }
      return EXIT_CODES.nothingToMigrate;
    }
  }
  parsed.vellumRoot = resolved;

  // The run lock: one migration at a time. The detached child's parent
  // already took it (the path was handed down via --internal-lock); every
  // other real run takes it here and releases it on exit. --dry-run
  // touches nothing and skips it.
  if (!parsed.dryRun) {
    const lockPath = parsed.internalLock ?? runLockPath();
    if (parsed.internalRun) {
      releaseLockOnExit(lockPath);
    } else {
      const acquired = await acquireRunLock(lockPath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        logPath: parsed.runLog ?? "(in-process run)",
      });
      if (!acquired) {
        const holder = await readRunLock(lockPath);
        if (parsed.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, exitCode: EXIT_CODES.alreadyRunning, error: `a migration is already running (pid ${holder?.pid ?? "unknown"})` }, null, 2)}\n`,
          );
        } else if (holder) {
          printAlreadyRunning(holder);
        }
        return EXIT_CODES.alreadyRunning;
      }
      releaseLockOnExit(lockPath);
    }
  }

  // The started line: the detach flow prints it from the parent; a
  // foreground run prints it here (its own pid, its own log path).
  if ((parsed.foreground || parsed.internalRun) && !parsed.json && parsed.runLog) {
    printStarted(process.pid, parsed.runLog);
  }

  // The detached child renders its full TTY-grade stream (cursor math +
  // forced color) into the run-log: the parent relays those bytes to the
  // real terminal, so the live view rewrites in place like an in-process
  // run, and `tail -f` replays the same stream after a disconnect.
  const logMode = parsed.internalRun === true;
  if (logMode) forceColor();
  if (parsed.internalRun && parsed.yes && process.connected) process.disconnect?.();
  const live = !parsed.json && !parsed.verbose && (logMode || Boolean(process.stderr.isTTY));
  const progress = createLiveProgress(logMode);
  try {
    const report = await migrate({
      ...parsed,
      // Confirmation follows detect and preflight. The detached worker
      // delegates the terminal prompt to its attached launcher through IPC.
      confirm:
        parsed.internalRun && !parsed.yes && process.send
          ? (info) => new Promise<boolean>((resolve) => {
              const disconnect = () => resolve(false);
              process.once("disconnect", disconnect);
              process.once("message", (message: { type?: string; confirmed?: boolean }) => {
                process.removeListener("disconnect", disconnect);
                resolve(message.type === "confirmed" && message.confirmed === true);
              });
              process.send!({ type: "confirm", info });
            })
          : !parsed.json && !parsed.yes && Boolean(process.stdin.isTTY)
            ? (info) => promptConfirmMigration(info)
            : undefined,
      // Same relay for the install-cadet sudo retry (the launcher owns the
      // TTY sudo's password prompt needs). A declined/no-terminal answer
      // resolves not-ok and the step warning keeps the manual fix.
      retryInstallAsSudo:
        parsed.internalRun && !parsed.yes && process.send
          ? (info) => new Promise<{ ok: boolean; detail?: string }>((resolve) => {
              const disconnect = () => resolve({ ok: false, detail: "the launcher went away before the answer" });
              process.once("disconnect", disconnect);
              process.once("message", (message: { type?: string; ok?: boolean; detail?: string }) => {
                process.removeListener("disconnect", disconnect);
                resolve(
                  message.type === "sudo-result" && message.ok === true
                    ? { ok: true }
                    : { ok: false, detail: message.detail ?? "the retry did not succeed" },
                );
              });
              process.send!({ type: "ask-sudo", info });
            })
          : !parsed.json && !parsed.yes && Boolean(process.stdin.isTTY)
            ? (info) => promptSudoRetry(info)
            : undefined,
      onStepStart: live ? progress.onStepStart : undefined,
      onStepDone: live ? progress.onStepDone : undefined,
      onStepItem: live ? progress.onStepItem : undefined,
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
    console.error(errorText(`migration crashed: ${(err as Error).message}${errPath(err)}`));
    if (parsed.verbose && (err as Error).stack) {
      console.error((err as Error).stack);
    }
    return EXIT_CODES.migrationFailed;
  } finally {
    // The IPC channel stays open through the run so mid-run prompts (the
    // pre-migration confirm, the install-cadet sudo retry) can reach the
    // attached launcher; the run is over — close it or the process never
    // exits.
    if (parsed.internalRun && process.connected) process.disconnect?.();
  }
}

process.exitCode = await main();
