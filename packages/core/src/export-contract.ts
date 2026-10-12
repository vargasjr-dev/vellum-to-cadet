import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { inspectRootMarkers } from "./discover.js";
import { settleStreams, volumeTarCreateArgs } from "./process.js";
import { migrate } from "./runner.js";
import type { MigrationReport, MigrateOptions } from "./types.js";

/**
 * The cloud export contract (Option B).
 *
 * The local flow migrates a vellum root in place on the machine that owns
 * it. The cloud flow can't: the root lives on the user's machine, and the
 * fresh cadet boots on a firecracker VM. The contract between the two
 * sides is a plain tarball of the ENTIRE vellum root — the disk state
 * itself, not an invented JSON shape — so this repo's disk-layout-native
 * engine runs with zero adapter code:
 *
 *   1. The far side packs the root: `packVellumRoot` is what `vellum
 *      export` will produce — the same tar stream the docker-volume
 *      transfer already uses (sockets excluded; cadet recreates its own).
 *   2. The export is staged where the VM reads it (bucket / mounted disk).
 *   3. The VM's boot-migrate step calls `migrateFromExport`: the tarball
 *      is unpacked to a staging dir, validated against the same discovery
 *      markers a local root must pass, and the standard migrate() engine
 *      converts vellum root → cadet root on the VM disk.
 *   4. The assistant process boots and wakes.
 *
 * The stop-assistant step is skipped on this path (`stoppedByConstruction`):
 * an exported root is asleep by construction — export refuses to pack a
 * running assistant — and the ingesting VM has no vellum CLI to sleep
 * anything with.
 */

/** Where staged exports land while the engine runs against them. */
const STAGING_PREFIX = "vtc-export-";

/**
 * Tar the whole vellum root to `outPath` — the artifact `vellum export`
 * will produce. Same stream shape as the docker-volume transfer
 * (volumeTarCreateArgs: sockets excluded), written straight to a file with
 * -f so there is no pipe bookkeeping. Returns the path and its byte size.
 */
export async function packVellumRoot(
  root: string,
  outPath: string,
): Promise<{ path: string; bytes: number }> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const tar = spawn(
    "tar",
    ["-c", "-f", outPath, ...volumeTarCreateArgs(root).slice(1)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  await settleStreams([{ child: tar, label: "pack tar" }], `pack ${root}`);
  const { size } = await fs.stat(outPath);
  return { path: outPath, bytes: size };
}

/**
 * Unpack a vellum export tarball into a fresh staging directory and return
 * the staged root's path — the directory IS the vellum root (the tarball's
 * members are the root's contents). Self-cleans on failure: a broken or
 * truncated tarball leaves no scratch behind.
 */
export async function stageExportedRoot(tarballPath: string): Promise<string> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), STAGING_PREFIX));
  try {
    const tar = spawn("tar", ["-x", "-f", tarballPath, "-C", staging], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    await settleStreams([{ child: tar, label: "stage tar" }], `stage ${tarballPath}`);
    return staging;
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
}

export interface StagedRootVerdict {
  ok: boolean;
  /** Every vellum marker the staged directory carries (root-relative). */
  markers: string[];
  /** Set when !ok — why this isn't a vellum root. */
  reason?: string;
}

/**
 * The same trust gate root discovery applies to a local candidate, applied
 * to a staged export: at least one marker only the vellum assistant creates
 * must be present (a guardian token among them — the credential that lets
 * the migrated assistant keep its cloud identity). Generic directories fail
 * with a reason naming what was (and wasn't) found.
 */
export async function validateStagedRoot(stagedRoot: string): Promise<StagedRootVerdict> {
  const { markers, strong } = await inspectRootMarkers(stagedRoot);
  if (!strong) {
    return {
      ok: false,
      markers,
      reason:
        markers.length === 0
          ? `no vellum markers in ${stagedRoot} — not a vellum root tarball`
          : `only generic markers (${markers.join(", ")}) — none only the vellum assistant creates`,
    };
  }
  return { ok: true, markers };
}

export interface MigrateFromExportOptions extends MigrateOptions {
  /** Debugging escape hatch: keep the staged root after the run. Default: removed. */
  keepStagedRoot?: boolean;
}

/**
 * Ingest a vellum export tarball: stage it, validate it, run the standard
 * migration engine against the staged root. The staged root is scratch —
 * removed after the run unless `keepStagedRoot` is set. Throws when the
 * tarball isn't a vellum root at all.
 */
export async function migrateFromExport(
  tarballPath: string,
  options: MigrateFromExportOptions = {},
): Promise<MigrationReport> {
  const { keepStagedRoot, ...migrateOptions } = options;
  const staged = await stageExportedRoot(tarballPath);
  try {
    const verdict = await validateStagedRoot(staged);
    if (!verdict.ok) {
      throw new Error(`staged export is not a vellum root: ${verdict.reason}`);
    }
    return await migrate({
      ...migrateOptions,
      vellumRoot: staged,
      stoppedByConstruction: true,
    });
  } finally {
    if (!keepStagedRoot) await fs.rm(staged, { recursive: true, force: true });
  }
}
