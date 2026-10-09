import { detect as detectStep, envSuffixFor, resolveMigrationTarget } from "./steps/detect.js";
import { preflight } from "./steps/preflight.js";
import { stopAssistant } from "./steps/stop-assistant.js";
import { backup, backupDirFor } from "./steps/backup.js";
import { buildCopyPlan, migrateLayout } from "./steps/migrate-layout.js";
import { migrateAssistantDb } from "./steps/migrate-assistant-db.js";
import { migrateHomeLockfile } from "./steps/migrate-lockfile.js";
import { verify } from "./steps/verify.js";
import { defaultProcessOps } from "./process.js";
import { DEFAULT_TARGET_CTX } from "./layout.js";
import { stateRelativePath } from "./fs-utils.js";
import { ASSISTANT_DB_STATE_REL } from "./steps/migrate-assistant-db.js";
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
  const ops = options.processOps ?? defaultProcessOps;
  const steps: StepResult[] = [];
  const start = (step: string): void => options.onStepStart?.(step);
  const done = (result: StepResult): StepResult => {
    options.onStepDone?.(result);
    steps.push(result);
    return result;
  };
  const log = (msg: string): void => {
    if (options.verbose) console.error(`[vellum-migrate] ${msg}`);
  };

  start("detect");
  const detect: DetectInfo = await detectStep(options, ops);
  const dockerNote =
    detect.docker.instances.length > 0
      ? `, docker instances: ${detect.docker.instances.join(", ")}`
      : "";
  done({
    step: "detect",
    status: "completed",
    summary: detect.vellumRootExists
      ? `vellum root at ${detect.vellumRoot} (${detect.deploymentKind}, version ${detect.version ?? "unknown"}${dockerNote})`
      : `no vellum root at ${detect.vellumRoot}`,
    data: {
      vellumRoot: detect.vellumRoot,
      cadetRoot: detect.cadetRoot,
      deploymentKind: detect.deploymentKind,
      version: detect.version,
      runningProcessCount: detect.runningProcesses.length,
      rootSizeBytes: detect.rootSizeBytes,
      externalReferences: detect.externalReferences,
      docker: detect.docker,
    },
  });

  if (!detect.vellumRootExists) {
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.nothingToMigrate);
  }

  // Resolve the destination idempotently: an occupied cadet root gets a
  // fresh instance dir instead of a hard error.
  const target = await resolveMigrationTarget(detect, options.cadetRootExplicit === true);
  if (target.kind === "conflict") {
    done({
      step: "preflight",
      status: "failed",
      summary: `${target.occupied} already exists and is populated (no prior migration manifest)`,
      issues: [
        {
          severity: "error",
          message:
            "refusing to overwrite an explicit --cadet-root; if this is a previous migration, re-run to verify instead, or pick a different root",
        },
      ],
      data: { conflict: true },
    });
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.cadetRootConflict);
  }
  // Path rewrites must point at the directory the files actually land in.
  const targetCtx =
    target.kind === "fresh"
      ? { instanceName: target.freshName, nested: true }
      : DEFAULT_TARGET_CTX;
  if (target.kind === "fresh") {
    detect.cadetRoot = target.cadetRoot;
    detect.cadetRootExists = false;
    detect.cadetRootPopulated = false;
  } else if (target.kind === "already-migrated") {
    detect.cadetRoot = target.cadetRoot;
  }

  // Already-migrated path: verify-only.
  if (target.kind === "already-migrated") {
    start("verify");
    const v = await verify(detect.vellumRoot, detect.cadetRoot);
    done(v);
    const code = v.status === "completed" ? EXIT_CODES.ok : EXIT_CODES.verifyFailed;
    return finish(detect, steps, "verify-only", startedAt, null, code);
  }

  start("preflight");
  const pre = await preflight(detect, { skipDiskSpaceCheck: options.skipDiskSpaceCheck });
  done(pre);
  if (pre.status === "failed") {
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.preflightFailed);
  }

  if (options.dryRun) {
    start("plan-copy");
    const plan = await buildCopyPlan(detect.vellumRoot);
    const rewrites = plan.filter((p) => p.action === "rewrite").length;
    done({
      step: "plan-copy",
      status: "planned",
      summary: `dry run: ${plan.length} entries would be migrated to ${detect.cadetRoot} (${rewrites} rewritten)`,
      files: plan,
    });
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.ok);
  }

  // 1. Put the vellum assistant to sleep (its own CLI does the stopping).
  if (!options.skipStopAssistant) {
    start("stop-assistant");
    const stop = await stopAssistant(detect, ops, options.verbose, options.termGraceMs ?? 5_000);
    done(stop);
    if (stop.status === "failed") {
      return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.processesUnstoppable);
    }
  }

  // 2. Full backup before any mutation.
  start("backup");
  const timestamp = utcStamp();
  const bk = await backup(detect.vellumRoot, detect.cadetRoot, timestamp);
  done(bk);
  if (bk.status === "failed") {
    return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.backupFailed);
  }
  const backupPath = backupDirFor(detect.cadetRoot, timestamp);

  // 3. Migrate the layout (copy + renames + rewrites + manifest).
  start("migrate-layout");
  const mig = await migrateLayout(detect, timestamp, targetCtx);
  done(mig);
  if (mig.status === "failed") {
    return finish(detect, steps, "migrate", startedAt, backupPath, EXIT_CODES.migrationFailed);
  }

  // 3.5 Rewrite vellum-branded VALUES inside the migrated assistant DB
  // (channel ids, attachment links, the managed connection row). The
  // destination path comes from the copy plan so every layout shape agrees.
  start("migrate-assistant-db");
  done(
    await migrateAssistantDb(
      detect,
      mig.files?.find((f) => stateRelativePath(f.src) === ASSISTANT_DB_STATE_REL)?.dest,
    ),
  );

  // 4. Move a legacy home-level cadet lockfile into the config dir so the
  // migrated install keeps its identity (cadet no longer reads the old name).
  start("migrate-lockfile");
  done(await migrateHomeLockfile(envSuffixFor(detect.vellumRoot)));

  // 5. Verify against the backup ground truth.
  start("verify");
  const v = await verify(detect.vellumRoot, detect.cadetRoot);
  done(v);
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
