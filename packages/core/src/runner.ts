import { detect as detectStep } from "./steps/detect.js";
import { preflight } from "./steps/preflight.js";
import { stopAssistant } from "./steps/stop-assistant.js";
import { backup, backupDirFor } from "./steps/backup.js";
import { buildCopyPlan, migrateLayout } from "./steps/migrate-layout.js";
import { verify } from "./steps/verify.js";
import { defaultProcessKiller } from "./process.js";
import {
  EXIT_CODES,
  type DetectInfo,
  type MigrationReport,
  type MigrateOptions,
  type StepResult,
} from "./types.js";

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

/**
 * Orchestrate the full migration. Idempotent: re-running against an already
 * migrated root runs verify-only and exits 0.
 */
export async function migrate(options: MigrateOptions = {}): Promise<MigrationReport> {
  const startedAt = new Date().toISOString();
  const killer = options.processKiller ?? defaultProcessKiller;
  const steps: StepResult[] = [];
  const log = (msg: string): void => {
    if (options.verbose) console.error(`[vellum-migrate] ${msg}`);
  };

  const detect: DetectInfo = await detectStep(options, killer);
  steps.push({
    step: "detect",
    status: "completed",
    summary: detect.vellumRootExists
      ? `vellum root at ${detect.vellumRoot} (${detect.deploymentKind}, version ${detect.version ?? "unknown"})`
      : `no vellum root at ${detect.vellumRoot}`,
    data: {
      vellumRoot: detect.vellumRoot,
      cadetRoot: detect.cadetRoot,
      deploymentKind: detect.deploymentKind,
      version: detect.version,
      runningProcessCount: detect.runningProcesses.length,
      rootSizeBytes: detect.rootSizeBytes,
      externalReferences: detect.externalReferences,
    },
  });

  if (!detect.vellumRootExists) {
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.nothingToMigrate);
  }

  // Already-migrated path: verify-only.
  if (detect.previousManifest) {
    const v = await verify(detect.vellumRoot, detect.cadetRoot);
    steps.push(v);
    const code = v.status === "completed" ? EXIT_CODES.ok : EXIT_CODES.verifyFailed;
    return finish(detect, steps, "verify-only", startedAt, null, code);
  }

  const pre = await preflight(detect, { skipDiskSpaceCheck: options.skipDiskSpaceCheck });
  steps.push(pre);
  if (pre.status === "failed") {
    const conflict = (pre.data as { conflict?: boolean } | undefined)?.conflict === true;
    return finish(detect, steps, "plan", startedAt, null, conflict ? EXIT_CODES.cadetRootConflict : EXIT_CODES.preflightFailed);
  }

  if (options.dryRun) {
    const plan = await buildCopyPlan(detect.vellumRoot);
    const rewrites = plan.filter((p) => p.action === "rewrite").length;
    steps.push({
      step: "plan-copy",
      status: "planned",
      summary: `dry run: ${plan.length} entries would be migrated to ${detect.cadetRoot} (${rewrites} rewritten)`,
      files: plan,
    });
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.ok);
  }

  // 1. Put the vellum assistant to sleep.
  if (!options.skipStopAssistant) {
    const stop = await stopAssistant(detect, killer, options.verbose, options.termGraceMs ?? 5_000);
    steps.push(stop);
    if (stop.status === "failed") {
      return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.processesUnstoppable);
    }
  }

  // 2. Full backup before any mutation.
  const timestamp = utcStamp();
  const bk = await backup(detect.vellumRoot, detect.cadetRoot, timestamp);
  steps.push(bk);
  if (bk.status === "failed") {
    return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.backupFailed);
  }
  const backupPath = backupDirFor(detect.cadetRoot, timestamp);

  // 3. Migrate the layout (copy + renames + rewrites + manifest).
  const mig = await migrateLayout(detect, timestamp);
  steps.push(mig);
  if (mig.status === "failed") {
    return finish(detect, steps, "migrate", startedAt, backupPath, EXIT_CODES.migrationFailed);
  }

  // 4. Verify against the backup ground truth.
  const v = await verify(detect.vellumRoot, detect.cadetRoot);
  steps.push(v);
  if (v.status === "failed") {
    return finish(detect, steps, "migrate", startedAt, backupPath, EXIT_CODES.verifyFailed);
  }

  return finish(detect, steps, "migrate", startedAt, backupPath, EXIT_CODES.ok);
}

function finish(
  detect: DetectInfo,
  steps: StepResult[],
  mode: MigrationReport["mode"],
  startedAt: string,
  backupPath: string | null,
  exitCode: MigrationReport["exitCode"],
): MigrationReport {
  return {
    ok: exitCode === EXIT_CODES.ok,
    exitCode,
    mode,
    detect,
    steps,
    backupPath,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
