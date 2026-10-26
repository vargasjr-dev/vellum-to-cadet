import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { DEFAULT_VELLUM_ROOT, detectVersion } from "./detect.js";
import { formatBytes } from "../fs-utils.js";
import { handleToInstanceName } from "../layout.js";
import {
  extractVBundle,
  readVBundleManifest,
  VBundleError,
  type VBundleManifest,
} from "../vbundle.js";
import {
  extractExportTar,
  inspectExportTar,
  sniffBundleKind,
  ExportTarError,
  type ExportTarInfo,
} from "../export-tar.js";
import type { MigrateOptions, StepIssue, StepResult } from "../types.js";

/**
 * Restore a legacy `.vbundle` assistant backup into the discovered vellum
 * root as a real assistant, so the rest of the migrator's logic (detect →
 * layout → db steps → verify) proceeds unchanged — Vargas's direction:
 * "the migrator first extracts the bundle into a vellum assistant in
 * whatever vellum root that was found, and then we proceed with the rest of
 * the migrator's logic".
 *
 * The extraction is ADDITIVE and ATOMIC: a fresh staging dir is filled,
 * hash-verified against the bundle's manifest, and renamed into place —
 * an interrupted run leaves the root untouched (a crash mid-extract leaves
 * only a `.vtc-extract-*` staging dir, swept on the next run). The root's
 * own assistants are never modified. Credentials carried by the bundle are
 * plaintext values with no sanctioned home in a cold root (no CES to import
 * them into), so they are NOT written — the step reports them, matching the
 * upstream importer's no-callback default.
 */

const STAGING_PREFIX = ".vtc-extract-";
/** Our own collision marker: proves a same-named assistant dir came from THIS bundle. */
const RESTORE_MARKER = "vtc-bundle-restore.json";
const FALLBACK_ASSISTANT_NAME = "restored-assistant";
const MAX_DIR_NAME_LENGTH = 80;
/** Legacy landing order for the three volume dirs (workspace first — the collision guard). */
const VOLUME_LANDING_ORDER = ["workspace", "gateway-security", "ces-security"] as const;

/** The bundle's assistant name, made safe as a directory name. */
export function sanitizeAssistantDirName(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[\s\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[-.]+/, "")
    .slice(0, MAX_DIR_NAME_LENGTH)
    .replace(/[-.]+$/, "");
  return cleaned.length > 0 ? cleaned : FALLBACK_ASSISTANT_NAME;
}

/** A modern root keeps assistants under `assistants/`; a legacy root IS one assistant. */
async function resolveLayout(
  vellumRoot: string,
): Promise<{ layout: "modern" | "legacy"; assistantsDir: string }> {
  const assistantsDir = path.join(vellumRoot, "assistants");
  try {
    const stat = await fs.stat(assistantsDir);
    if (stat.isDirectory()) return { layout: "modern", assistantsDir };
  } catch {
    // Legacy layout.
  }
  return { layout: "legacy", assistantsDir: vellumRoot };
}

/** Read our restore marker back — the idempotency signal for a same-bundle re-run. */
async function readRestoreMarker(markerPath: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const bundleId = (parsed as Record<string, unknown>).bundle_id;
      if (typeof bundleId === "string" && bundleId.length > 0) return bundleId;
    }
  } catch {
    // No marker — a real assistant (or an interrupted ours).
  }
  return null;
}

async function sweepStaleStaging(assistantsDir: string, issues: StepIssue[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(assistantsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!(entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))) continue;
    const stale = path.join(assistantsDir, entry.name);
    try {
      await fs.rm(stale, { recursive: true, force: true });
      issues.push({
        severity: "warning",
        message: `removed leftover extraction staging dir ${stale} (an earlier run died mid-restore)`,
      });
    } catch (err) {
      issues.push({
        severity: "warning",
        message: `could not remove leftover staging dir ${stale} (${(err as Error).message}) — remove it by hand`,
      });
    }
  }
}

function credentialIssue(count: number, accounts: string[]): StepIssue | null {
  if (count === 0) return null;
  return {
    severity: "warning",
    message:
      `the bundle carried ${count} credential(s) (${accounts.join(", ")}) — values were not restored; ` +
      "re-add them in the migrated assistant's credentials settings",
  };
}

const NOT_IN_LOCKFILE_NOTE: StepIssue = {
  severity: "info",
  message:
    "the bundle carries no CLI lockfile state, so the restored assistant is not in any vellum lockfile — " +
    "it migrates as data; wake it from cadet once migrated",
};

/**
 * The `extract-bundle` step: sniff the bundle's format (a legacy `.vbundle`
 * backup or a `vellum.ai/export` tar — content-sniffed, extension aside),
 * then dispatch to the matching restore. Both restores validate, stage, and
 * land the bundle as a real vellum assistant. Only mutates the vellum root
 * ADDITIVELY (one new assistant dir per bundle).
 */
export async function extractBundleStep(options: MigrateOptions): Promise<StepResult> {
  const step = "extract-bundle";
  const bundlePath = options.bundlePath!;
  const vellumRoot = options.vellumRoot ?? DEFAULT_VELLUM_ROOT;
  const issues: StepIssue[] = [];
  const fail = (message: string): StepResult => ({
    step,
    status: "failed",
    summary: message,
    issues,
  });

  if (bundlePath.endsWith(".enc")) {
    return fail(
      "--bundle: encrypted .vbundle.enc backups are not supported — the keys that encrypted them " +
        "are gone with the old install; restore the unencrypted export",
    );
  }
  let bundleStat;
  try {
    bundleStat = await fs.stat(bundlePath);
  } catch {
    return fail(`--bundle: no such file: ${bundlePath}`);
  }
  if (!bundleStat.isFile()) return fail(`--bundle: not a file: ${bundlePath}`);

  if (!(await pathExists(vellumRoot))) {
    return fail(
      `--bundle: no vellum root at ${vellumRoot} — a bundle restores into an existing vellum installation`,
    );
  }

  const format = await sniffBundleKind(bundlePath);
  if (format === "vbundle") return restoreVBundle(options, issues);
  if (format === "export-tar") return restoreExportTar(options, issues);
  return fail(
    "--bundle: unrecognized archive — expected a .vbundle assistant backup or a vellum.ai/export tar " +
      "(the archive's contents don't parse as a tar)",
  );
}

async function restoreVBundle(options: MigrateOptions, issues: StepIssue[]): Promise<StepResult> {
  const step = "extract-bundle";
  const bundlePath = options.bundlePath!;
  const vellumRoot = options.vellumRoot ?? DEFAULT_VELLUM_ROOT;
  const fail = (message: string): StepResult => ({
    step,
    status: "failed",
    summary: message,
    issues,
  });

  // Pass 1: the manifest alone (the bundle's first entry) — validates shape,
  // self-checksum, and the migration-relevant options before any byte lands.
  let manifest: VBundleManifest;
  try {
    manifest = await readVBundleManifest(bundlePath);
  } catch (err) {
    return fail(
      err instanceof VBundleError
        ? `--bundle: ${(err as Error).message}`
        : `--bundle: could not read the archive: ${(err as Error).message}`,
    );
  }
  if (manifest.export_options.include_gateway === true) {
    return fail(
      "--bundle: this .vbundle is a staff debug profile (gateway logs and db attached), not an assistant export",
    );
  }
  const totalBytes = manifest.contents.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const credentialCount = manifest.contents.filter((entry) =>
    entry.path.startsWith("credentials/"),
  ).length;

  const assistantName = sanitizeAssistantDirName(manifest.assistant.name);
  const { layout, assistantsDir } = await resolveLayout(vellumRoot);
  // Modern: the bundle becomes a NEW assistant dir. Legacy: the root itself IS
  // the assistant — the workspace tree lands at the root (the marker dir too).
  const targetDir = layout === "modern" ? path.join(assistantsDir, assistantName) : vellumRoot;
  const displayTarget =
    layout === "modern"
      ? path.join(vellumRoot, `assistants/${assistantName}`)
      : `${vellumRoot} (the legacy root itself)`;
  const summaryCore = `"${manifest.assistant.name}" (${manifest.contents.length} entr${manifest.contents.length === 1 ? "y" : "ies"}, ${formatBytes(totalBytes)})`;

  // Collision / idempotency: a same-named dir is refused unless THIS bundle
  // already restored into it (the marker carries the bundle id).
  const versionDir =
    layout === "modern"
      ? path.join(targetDir, ".vellum", ".vellum-assistant")
      : path.join(targetDir, ".vellum-assistant");
  if (await pathExists(layout === "modern" ? targetDir : path.join(vellumRoot, "workspace"))) {
    if (layout === "legacy") {
      const marker = await readRestoreMarker(path.join(versionDir, RESTORE_MARKER));
      if (marker === manifest.bundle_id) {
        return {
          step,
          status: "skipped",
          summary: `bundle already restored into the root at ${vellumRoot} — nothing to do`,
          issues,
          data: { assistantName, bundleId: manifest.bundle_id, alreadyRestored: true },
        };
      }
      return fail(
        `--bundle: the root at ${vellumRoot} already carries an assistant workspace (legacy single-root layout) — ` +
          "a bundle cannot restore over it",
      );
    }
    const marker = await readRestoreMarker(path.join(versionDir, RESTORE_MARKER));
    if (marker === manifest.bundle_id) {
      return {
        step,
        status: "skipped",
        summary: `bundle already restored as ${displayTarget} — nothing to do`,
        issues,
        data: { assistantName, bundleId: manifest.bundle_id, alreadyRestored: true },
      };
    }
    return fail(
      `--bundle: assistants/${assistantName} already exists — refusing to overwrite a real assistant; ` +
        "remove or rename it first",
    );
  }

  if (options.dryRun) {
    const plannedCredentialIssue = credentialIssue(
      credentialCount,
      manifest.contents
        .filter((entry) => entry.path.startsWith("credentials/"))
        .map((entry) => entry.path.slice("credentials/".length)),
    );
    return {
      step,
      status: "planned",
      summary: `dry run: would restore ${summaryCore} into ${displayTarget}`,
      issues: [...(plannedCredentialIssue ? [plannedCredentialIssue] : []), NOT_IN_LOCKFILE_NOTE],
      data: {
        assistantName,
        bundleId: manifest.bundle_id,
        runtimeVersion: manifest.assistant.runtime_version,
        entries: manifest.contents.length,
        bytes: totalBytes,
        credentials: credentialCount,
        layout,
      },
    };
  }

  // Real run: staging → verify → land. Modern lands by one atomic rename of
  // the whole assistant dir; legacy merges two fresh dirs into the existing
  // root (workspace/ + the marker dir) — both renames land or both roll back.
  const stagingParent = layout === "modern" ? assistantsDir : vellumRoot;
  await sweepStaleStaging(stagingParent, issues);
  const stagingDir = path.join(stagingParent, `${STAGING_PREFIX}${randomHex(6)}`);
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    const extracted = await extractVBundle(bundlePath, stagingDir, {
      // Modern roots nest ALL assistant state under .vellum/ — the layout
      // step dissolves it; legacy roots carry the workspace at the root.
      workspaceDir: layout === "modern" ? ".vellum" : ".",
    });

    // The marker dir doubles as the discovery/detect marker: without it the
    // restored assistant is invisible to root discovery and version reads.
    // Modern: it lives inside the staging dir that becomes the assistant dir.
    // Legacy: it is staged INSIDE the staging dir too (the root-level rename
    // below moves it into place — writing it at the root would be premature).
    // Both layouts stage the marker INSIDE the staging dir at the same
    // relative position it occupies after landing (modern's rename carries
    // the whole assistant dir; legacy renames the marker dir separately).
    const writeVersionDir =
      layout === "modern"
        ? path.join(stagingDir, ".vellum", ".vellum-assistant")
        : path.join(stagingDir, ".vellum-assistant");
    await fs.mkdir(writeVersionDir, { recursive: true });
    await fs.writeFile(
      path.join(writeVersionDir, "version"),
      `${manifest.assistant.runtime_version}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(writeVersionDir, RESTORE_MARKER),
      `${JSON.stringify({ bundle_id: manifest.bundle_id, restored_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );

    if (layout === "modern") {
      await fs.rename(stagingDir, targetDir);
    } else {
      const landedWorkspace = path.join(vellumRoot, "workspace");
      const landedMarkerDir = path.join(vellumRoot, ".vellum-assistant");
      try {
        await fs.rename(path.join(stagingDir, "workspace"), landedWorkspace);
        await fs.rename(writeVersionDir, landedMarkerDir);
      } catch (err) {
        await fs.rm(landedWorkspace, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(landedMarkerDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    }

    const credIssue = credentialIssue(extracted.credentials.length, [
      ...new Set(extracted.credentials.map((c) => c.account)),
    ]);
    if (credIssue) issues.push(credIssue);
    issues.push(NOT_IN_LOCKFILE_NOTE);
    return {
      step,
      status: "completed",
      summary: `restored ${summaryCore} into ${displayTarget}`,
      issues,
      data: {
        assistantName,
        bundleId: manifest.bundle_id,
        runtimeVersion: manifest.assistant.runtime_version,
        files: extracted.fileCount,
        bytes: extracted.totalBytes,
        credentials: extracted.credentials.length,
        symlinks: extracted.symlinkCount,
        layout,
      },
    };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    const reason = err instanceof VBundleError ? (err as Error).message : `could not extract the bundle: ${(err as Error).message}`;
    return fail(`--bundle: ${reason}`);
  }
}

/** The marker's bundle id shape for vellum.ai/export tars: content-addressed. */
function exportBundleId(info: ExportTarInfo): string {
  return `vellum-export-${info.fingerprint.slice(0, 12)}`;
}

/**
 * The `vellum.ai/export` restore: map the archive's top-level volumes, name
 * the assistant from the volume names' instance id (falling back to the
 * archive's filename), then stage and land the three volume trees exactly
 * like a `.vbundle` restore would land its workspace. No manifest exists —
 * the archive's decompressed sha256 is the identity the restore marker
 * records, so re-running the same export skips instead of colliding.
 */
async function restoreExportTar(options: MigrateOptions, issues: StepIssue[]): Promise<StepResult> {
  const step = "extract-bundle";
  const bundlePath = options.bundlePath!;
  const vellumRoot = options.vellumRoot ?? DEFAULT_VELLUM_ROOT;
  const fail = (message: string): StepResult => ({
    step,
    status: "failed",
    summary: message,
    issues,
  });

  let info: ExportTarInfo;
  try {
    info = await inspectExportTar(bundlePath);
  } catch (err) {
    return fail(`--bundle: ${(err as Error).message}`);
  }
  for (const entry of info.unexpected) {
    issues.push({
      severity: "warning",
      message:
        `the export archive carries an unexpected top-level ${entry.kind} ${JSON.stringify(entry.name)} — ` +
        "not one of the three vellum volumes; it is not restored",
    });
  }
  if (!info.volumes.gatewaySecurity) {
    issues.push({
      severity: "warning",
      message:
        "the export carries no gateway-security volume — the gateway db, guardian trust, and channel " +
        "registrations are absent; the migrated assistant re-inits guardian from scratch",
    });
  }
  if (!info.volumes.cesSecurity) {
    issues.push({
      severity: "warning",
      message:
        "the export carries no ces-security volume — encrypted credential keys are absent; " +
        "re-add credentials in the migrated assistant's settings",
    });
  }

  // The volume names' shared instance id (`vellum-velly`) is the assistant's
  // real identity — the brand prefix strips for the dir name, same rule the
  // layout step applies to modern assistant dirs. Without it, the archive's
  // filename speaks for the assistant.
  const rawName =
    info.instanceId && info.instanceId.length > 0
      ? handleToInstanceName(info.instanceId)
      : path.basename(bundlePath).replace(/\.(tar|tar\.gz|tgz)$/i, "");
  const assistantName = sanitizeAssistantDirName(rawName);
  const bundleId = exportBundleId(info);
  const { layout, assistantsDir } = await resolveLayout(vellumRoot);
  const targetDir = layout === "modern" ? path.join(assistantsDir, assistantName) : vellumRoot;
  const displayTarget =
    layout === "modern"
      ? path.join(vellumRoot, `assistants/${assistantName}`)
      : `${vellumRoot} (the legacy root itself)`;
  const volumeNames = Object.values(info.volumes).filter((v): v is string => typeof v === "string");
  const summaryCore = `"${assistantName}" (${info.entries} entries, ${formatBytes(info.totalBytes)}, volumes: ${volumeNames.join(", ")})`;

  // Collision / idempotency, same discipline as the .vbundle flow: a
  // same-named dir is refused unless THIS archive already restored into it.
  const versionDir =
    layout === "modern"
      ? path.join(targetDir, ".vellum", ".vellum-assistant")
      : path.join(targetDir, ".vellum-assistant");
  if (await pathExists(layout === "modern" ? targetDir : path.join(vellumRoot, "workspace"))) {
    const marker = await readRestoreMarker(path.join(versionDir, RESTORE_MARKER));
    if (marker === bundleId) {
      return {
        step,
        status: "skipped",
        summary:
          layout === "modern"
            ? `export already restored as ${displayTarget} — nothing to do`
            : `export already restored into the root at ${vellumRoot} — nothing to do`,
        issues,
        data: { assistantName, bundleId, alreadyRestored: true, layout },
      };
    }
    if (layout === "modern") {
      return fail(
        `--bundle: assistants/${assistantName} already exists — refusing to overwrite a real assistant; ` +
          "remove or rename it first",
      );
    }
    return fail(
      `--bundle: the root at ${vellumRoot} already carries an assistant workspace (legacy single-root layout) — ` +
        "a bundle cannot restore over it",
    );
  }

  if (options.dryRun) {
    return {
      step,
      status: "planned",
      summary: `dry run: would restore ${summaryCore} into ${displayTarget}`,
      issues: [...issues, NOT_IN_LOCKFILE_NOTE],
      data: {
        assistantName,
        bundleId,
        entries: info.entries,
        bytes: info.totalBytes,
        volumes: volumeNames,
        layout,
      },
    };
  }

  // Real run: staging → extract → land. Modern lands by one atomic rename of
  // the whole assistant dir; legacy merges the three fresh volume dirs and
  // the marker dir into the existing root — all renames land or roll back.
  const stagingParent = layout === "modern" ? assistantsDir : vellumRoot;
  await sweepStaleStaging(stagingParent, issues);
  const stagingDir = path.join(stagingParent, `${STAGING_PREFIX}${randomHex(6)}`);
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    const extracted = await extractExportTar(bundlePath, stagingDir, {
      stateDir: layout === "modern" ? ".vellum" : ".",
      volumes: info.volumes,
    });
    for (const skip of extracted.skipped) {
      issues.push({ severity: "warning", message: `${skip.path}: ${skip.reason}` });
    }

    // The marker dir doubles as the discovery/detect marker. The archive
    // carries no runtime version, so the restoring root's own detected
    // version fills the `version` file (omitted when the root has none).
    const writeVersionDir =
      layout === "modern"
        ? path.join(stagingDir, ".vellum", ".vellum-assistant")
        : path.join(stagingDir, ".vellum-assistant");
    await fs.mkdir(writeVersionDir, { recursive: true });
    const version = await detectVersion(vellumRoot);
    if (version) {
      await fs.writeFile(path.join(writeVersionDir, "version"), `${version}\n`, "utf8");
    }
    await fs.writeFile(
      path.join(writeVersionDir, RESTORE_MARKER),
      `${JSON.stringify(
        { bundle_id: bundleId, fingerprint: info.fingerprint, kind: "vellum-export", restored_at: new Date().toISOString() },
        null,
        2,
      )}\n`,
      "utf8",
    );

    if (layout === "modern") {
      await fs.rename(stagingDir, targetDir);
    } else {
      const landed: string[] = [];
      try {
        for (const stateName of VOLUME_LANDING_ORDER) {
          const src = path.join(stagingDir, stateName);
          if (!(await pathExists(src))) continue;
          const dest = path.join(vellumRoot, stateName);
          await fs.rename(src, dest);
          landed.push(dest);
        }
        const landedMarkerDir = path.join(vellumRoot, ".vellum-assistant");
        await fs.rename(writeVersionDir, landedMarkerDir);
        landed.push(landedMarkerDir);
      } catch (err) {
        for (const p of landed) {
          await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
        }
        throw err;
      }
    }

    issues.push(NOT_IN_LOCKFILE_NOTE);
    return {
      step,
      status: "completed",
      summary: `restored ${summaryCore} into ${displayTarget}`,
      issues,
      data: {
        assistantName,
        bundleId,
        files: extracted.fileCount,
        bytes: extracted.totalBytes,
        symlinks: extracted.symlinkCount,
        skippedEntries: extracted.skipped.length,
        volumes: volumeNames,
        layout,
      },
    };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    const reason = err instanceof ExportTarError ? (err as Error).message : `could not extract the bundle: ${(err as Error).message}`;
    return fail(`--bundle: ${reason}`);
  }
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
