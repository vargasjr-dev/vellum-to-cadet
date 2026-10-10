import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultProcessOps } from "./process.js";
import { EXIT_CODES, type ExitCode, type ProcessOps } from "./types.js";

/**
 * `uninstall` — the point of no return, on purpose.
 *
 * Migration and repair are conservative: the vellum root is a read-only
 * source of truth and everything is backed up first. Uninstall is the
 * command you run AFTER you've confirmed your cadet assistant is whole and
 * you want vellum gone for good. It:
 *
 *   1. asks the vellum CLI to put any running assistants to sleep — the
 *      CLI's own command, never pattern-matched process killing (pgrep
 *      guessing at what "belongs" to vellum is how unrelated processes die)
 *   2. deletes every vellum installation on the machine — the legacy home
 *      root, the modern XDG data roots, the XDG config dirs (including
 *      env-suffixed siblings), and the old home-level lockfiles
 *   3. removes the migrator itself (its npx cache entry)
 *
 * It NEVER touches the cadet side: no cadet root, no migration manifests,
 * and the migration backups in ~/.cadet-migration-backups are kept as the
 * last-resort safety net (deleting those is a decision for the user, by
 * hand). The confirmation demands the word DELETE be typed — --yes is the
 * non-interactive escape hatch.
 */

export interface UninstallOptions {
  /** List what would be deleted; touch nothing. */
  dryRun?: boolean;
  /** Non-interactive: skip the DELETE confirmation. */
  yes?: boolean;
  /** Machine-readable report (the CLI handles stdout routing). */
  json?: boolean;
  verbose?: boolean;
  /** Test seam: override process discovery and the stop command. */
  processOps?: ProcessOps;
}

export interface UninstallTarget {
  path: string;
  /** Why this path is on the list (shown to the user). */
  origin: string;
  kind: "dir" | "file";
  /**
   * True when the path is only deleted because discovery's marker gate
   * confirmed it (env-override roots can point anywhere; a non-vellum
   * directory must never be deleted because an env var said so).
   */
  markerGated: boolean;
  /** The marker that qualified a markerGated target. */
  marker?: string;
}

export interface UninstallTargetResult extends UninstallTarget {
  deleted: boolean;
  reason?: string;
}

export interface UninstallReport {
  ok: boolean;
  exitCode: ExitCode;
  mode: "uninstall";
  dryRun: boolean;
  /** True when `vellum sleep` was invoked (best-effort, best when it works). */
  slept: boolean;
  targets: UninstallTargetResult[];
  /** The npx cache entry removed for the migrator itself, if any. */
  selfRemoved: string | null;
  /** Where the migration backups live — always kept. */
  backupsKept: string | null;
  startedAt: string;
  finishedAt: string;
}

/** $HOME-first, mirroring discover.ts. */
function home(): string {
  const fromEnv = process.env["HOME"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return os.homedir();
}

function xdgHome(envVar: "XDG_CONFIG_HOME" | "XDG_DATA_HOME", fallback: string[]): string {
  const fromEnv = process.env[envVar]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(home(), ...fallback);
}

/**
 * The config homes the vellum assistant resolves, canonical + legacy —
 * when XDG_CONFIG_HOME is set it uses BOTH (paths.ts resolveConfigDirPaths).
 */
function vellumConfigHomes(): string[] {
  const canonical = xdgHome("XDG_CONFIG_HOME", [".config"]);
  const legacy = path.join(home(), ".config");
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

function vellumDataHomes(): string[] {
  const canonical = xdgHome("XDG_DATA_HOME", [".local", "share"]);
  const legacy = path.join(home(), ".local", "share");
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

/** Production dir name plus env-suffixed siblings (vellum, vellum-dev, …). */
const VELLUM_DIR_PATTERN = /^vellum(?:-[A-Za-z0-9._-]+)?$/;

async function pathKind(p: string): Promise<"dir" | "file" | null> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await pathKind(p)) !== null;
}

/**
 * Guard rails around the whole operation: a target may never be `/`, the
 * home dir itself, or one of the XDG homes we enumerate siblings from.
 * Everything on the list lives strictly INSIDE those parents by
 * construction; this is the backstop against a bad env var or a symlink.
 */
async function assertSafeTarget(p: string): Promise<void> {
  const real = await fs.realpath(p).catch(() => p);
  if (real === path.parse(real).root) {
    throw new Error(`refusing to delete the filesystem root: ${p}`);
  }
  if (real === home()) {
    throw new Error(`refusing to delete the home directory: ${p}`);
  }
  for (const parent of [...vellumConfigHomes(), ...vellumDataHomes()]) {
    if (real === (await fs.realpath(parent).catch(() => parent))) {
      throw new Error(`refusing to delete an XDG home itself: ${p}`);
    }
  }
}

/**
 * Every vellum location on the machine. Roots come from discovery (already
 * marker-gated, so env overrides that point at junk are skipped); config
 * and data dirs are namespaced by name; the home-level lockfiles are the
 * legacy pre-XDG identity files.
 */
export async function gatherUninstallTargets(ops: ProcessOps = defaultProcessOps): Promise<UninstallTarget[]> {
  const { discoverVellumRoots } = await import("./discover.js");
  const discovered = await discoverVellumRoots();

  const targets: UninstallTarget[] = [];

  for (const root of discovered) {
    targets.push({
      path: root.root,
      origin: root.layout === "modern" ? "modern XDG data root (discovery)" : "vellum root (discovery)",
      kind: "dir",
      markerGated: true,
      marker: root.markers[0],
    });
  }

  // XDG config dirs: vellum + env-suffixed siblings.
  for (const configHome of vellumConfigHomes()) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(configHome)).filter((n) => VELLUM_DIR_PATTERN.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      targets.push({
        path: path.join(configHome, name),
        origin: "XDG config dir",
        kind: "dir",
        markerGated: false,
      });
    }
  }

  // XDG data roots not already covered by discovery: env-suffixed siblings
  // (vellum-dev, vellum-staging, …). Discovery targets production only.
  for (const dataHome of vellumDataHomes()) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(dataHome)).filter((n) => VELLUM_DIR_PATTERN.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      const p = path.join(dataHome, name);
      if (discovered.some((r) => r.root === p)) continue;
      targets.push({
        path: p,
        origin: "XDG data dir (environment sibling)",
        kind: "dir",
        markerGated: false,
      });
    }
  }

  // Old home-level lockfiles — the pre-XDG identity files (config.ts's
  // resolveLockfilePaths production branch).
  for (const name of [".vellum.lock.json", ".vellum.lockfile.json"]) {
    const p = path.join(home(), name);
    targets.push({ path: p, origin: "legacy home-level lockfile", kind: "file", markerGated: false });
  }

  // The installed program itself: the npm global package (`vellum`) and the
  // binary it links into the PATH (vellum). Data dirs without the
  // program left behind a machine that still can't spell vellum — v0.0.9
  // run feedback ("The full list" was missing the binary/package). The npm
  // global root is probed via ops (npm may be absent); the bun global layout
  // is checked by path. Everything is exists-gated and passes the same
  // assertSafeTarget guard as the rest of the list.
  const GLOBAL_PACKAGE = "vellum";
  const GLOBAL_BINS = ["vellum"];
  const packageDirs: Array<{ dir: string; origin: string }> = [];
  const binParents: Array<{ dir: string; origin: string }> = [];
  const npmRoot = await ops.npmGlobalRoot();
  if (npmRoot) {
    packageDirs.push({ dir: path.join(npmRoot, GLOBAL_PACKAGE), origin: "npm global package" });
    // `npm root -g` is <prefix>/node_modules (unix); the bins it links live
    // in <prefix>/bin. Custom layouts without that shape skip the bin probe.
    if (path.basename(npmRoot) === "node_modules") {
      binParents.push({
        dir: path.join(path.dirname(path.dirname(npmRoot)), "bin"),
        origin: "npm global package",
      });
    }
  }
  packageDirs.push({
    dir: path.join(home(), ".bun", "install", "global", "node_modules", GLOBAL_PACKAGE),
    origin: "bun global package",
  });
  binParents.push({ dir: path.join(home(), ".bun", "bin"), origin: "bun global package" });
  for (const { dir, origin } of packageDirs) {
    targets.push({ path: dir, origin: `${origin} (${GLOBAL_PACKAGE})`, kind: "dir", markerGated: false });
  }
  for (const { dir, origin } of binParents) {
    for (const bin of GLOBAL_BINS) {
      targets.push({ path: path.join(dir, bin), origin: `${origin} binary`, kind: "file", markerGated: false });
    }
  }

  // Dedupe by realpath — discovery and the XDG sweep can agree on a root.
  const seen = new Set<string>();
  const unique: UninstallTarget[] = [];
  for (const target of targets) {
    if (!(await exists(target.path))) continue;
    const real = await fs.realpath(target.path).catch(() => target.path);
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push(target);
  }
  return unique;
}

/**
 * Where the migrator itself was loaded from, when npx cached it:
 * ~/.npm/_npx/<hash>/node_modules/… — deleting the <hash> dir removes the
 * cached package (and the @mycadet/vellum engine alongside it). Returns
 * null for global/checked-out invocations; the CLI prints the npm hint.
 */
export async function npxCacheEntry(scriptPath: string | undefined): Promise<string | null> {
  if (!scriptPath) return null;
  const parts = scriptPath.split(path.sep);
  const npxIdx = parts.lastIndexOf("_npx");
  if (npxIdx === -1 || npxIdx + 1 >= parts.length) return null;
  const entry = path.join(...parts.slice(0, npxIdx + 2));
  // Only when it looks like an npx cache entry (a sibling node_modules).
  if (!(await exists(path.join(entry, "node_modules")))) return null;
  return entry;
}

export async function runUninstall(options: UninstallOptions = {}): Promise<UninstallReport> {
  const startedAt = new Date().toISOString();
  const ops = options.processOps ?? defaultProcessOps;
  const report: UninstallReport = {
    ok: false,
    exitCode: EXIT_CODES.ok,
    mode: "uninstall",
    dryRun: options.dryRun === true,
    slept: false,
    targets: [],
    selfRemoved: null,
    backupsKept: null,
    startedAt,
    finishedAt: startedAt,
  };
  const finish = (): UninstallReport => {
    report.finishedAt = new Date().toISOString();
    return report;
  };

  const homeDir = home();
  const backups = path.join(homeDir, ".cadet-migration-backups");
  if (await exists(backups)) report.backupsKept = backups;

  // Running assistants go to sleep before anything is deleted — deleting a
  // live assistant's data mid-write is how disks learn lies. The vellum
  // CLI owns the decision of what is actually running; we never guess.
  if (!options.dryRun) {
    try {
      await ops.vellumSleep();
      report.slept = true;
    } catch {
      // No vellum CLI (nothing to sleep) or it failed — the DELETE
      // confirmation is the user's moment to make sure everything is
      // stopped before the point of no return.
    }
  }

  const targets = await gatherUninstallTargets(ops);
  for (const target of targets) {
    await assertSafeTarget(target.path);
  }

  if (options.dryRun) {
    report.targets = targets.map((t) => ({ ...t, deleted: false }));
    report.ok = true;
    return finish();
  }

  if (!options.yes) {
    const confirmed = await confirmDelete(targets);
    if (!confirmed) {
      report.exitCode = EXIT_CODES.uninstallDeclined;
      return finish();
    }
  }

  let failed = false;
  for (const target of targets) {
    try {
      await fs.rm(target.path, { recursive: true, force: true });
      report.targets.push({ ...target, deleted: true });
    } catch (err) {
      failed = true;
      report.targets.push({ ...target, deleted: false, reason: (err as Error).message });
    }
  }

  // The migrator itself goes last — everything above may still need to log.
  const selfEntry = await npxCacheEntry(process.argv[1]);
  if (selfEntry) {
    try {
      await fs.rm(selfEntry, { recursive: true, force: true });
      report.selfRemoved = selfEntry;
    } catch {
      // Non-fatal: the CLI prints the npm hint when it couldn't self-remove.
    }
  }

  report.ok = !failed;
  report.exitCode = failed ? EXIT_CODES.uninstallFailed : EXIT_CODES.ok;
  return finish();
}

const SCARY_WARNING = [
  "  \u001b[1;31m\u26a0  WARNING — this is a FULL, IRREVERSIBLE DELETION\u001b[0m",
  "",
  "    Every vellum installation listed below will be PERMANENTLY DELETED.",
  "    Conversations, memories, skills, credentials — irrecoverable.",
  "",
  "    Your cadet assistant is SAFE: nothing cadet-related is touched.",
  "    Migration backups (if any) are kept as your last-resort net.",
].join("\n");

async function confirmDelete(targets: UninstallTarget[]): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      "uninstall refuses to delete without confirmation and stdin is not a TTY — re-run with --yes to delete without asking",
    );
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  console.error(SCARY_WARNING);
  console.error("");
  console.error("  The full list:");
  for (const target of targets) {
    console.error(`    \u2022 ${target.path} ${dim(`(${target.origin})`)}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new Promise<never>((_, reject) => {
    rl.on("close", () => reject(new Error("stdin closed before a choice was made")));
  });
  try {
    const answer = (
      await Promise.race([
        rl.question(
          "\n  Type DELETE (in capitals) to permanently remove everything listed — anything else aborts: ",
        ),
        closed,
      ])
    ).trim();
    return answer === "DELETE";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function dim(text: string): string {
  return `\u001b[2m${text}\u001b[0m`;
}

/** Human-facing uninstall summary (stderr in --json mode, stdout otherwise). */
export function renderUninstallHuman(report: UninstallReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  vellum → cadet uninstall");
  lines.push("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  if (report.dryRun) {
    lines.push(`  ${"·"} Dry run — nothing was deleted. Would remove:`);
  }
  for (const target of report.targets) {
    const icon = target.deleted ? "\u2713" : report.dryRun ? "\u2022" : "\u2717";
    lines.push(`  ${icon} ${target.path} ${dim(`(${target.origin})`)}`);
    if (target.reason) lines.push(`      ${target.reason}`);
  }
  if (report.slept) {
    lines.push(`  \u2713 asked the vellum CLI to put running assistants to sleep (vellum sleep)`);
  }
  if (report.selfRemoved) {
    lines.push(`  \u2713 removed the migrator's npx cache: ${report.selfRemoved}`);
  }
  if (report.backupsKept) {
    lines.push(`  \u2690 kept ${report.backupsKept} ${dim("(your migration backups — delete by hand if you're done with them)")}`);
  }
  lines.push("");
  if (report.ok) {
    if (!report.dryRun) {
      lines.push("  Done. Your cadet assistant is safe and untouched.");
      lines.push("");
    }
  } else {
    lines.push("  Uninstall did not complete — nothing further was removed.");
    lines.push(`  ${`(exit code: ${report.exitCode})`}`);
    lines.push("");
  }
  return lines.join("\n");
}
