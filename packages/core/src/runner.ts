import { promises as fs } from "node:fs";
import * as path from "node:path";

import { discoverCadetRoots } from "./discover.js";
import { detect as detectStep, envSuffixFor, resolveMigrationTarget } from "./steps/detect.js";
import { preflight } from "./steps/preflight.js";
import { stopAssistant, stopCadet } from "./steps/stop-assistant.js";
import { backup, backupDirFor } from "./steps/backup.js";
import { buildCopyPlan, migrateLayout } from "./steps/migrate-layout.js";
import {
  ASSISTANT_DB_STATE_REL,
  GATEWAY_DB_STATE_REL,
  migrateAssistantDb,
  migrateAssistantDbAt,
  migrateGatewayDb,
  migrateGatewayDbAt,
} from "./steps/migrate-assistant-db.js";
import { migrateHomeLockfile } from "./steps/migrate-lockfile.js";
import { dbVellumRows, verify, VALUE_MIGRATED_DBS } from "./steps/verify.js";
import { defaultProcessOps } from "./process.js";
import { DEFAULT_TARGET_CTX } from "./layout.js";
import {
  applySubstitutions,
  isDbArtifact,
  isRewriteEligible,
  sanctionedContentTransform,
  stateRelativePath,
  walkTree,
} from "./fs-utils.js";
import {
  EXIT_CODES,
  type DetectInfo,
  type MigrationReport,
  type MigrateOptions,
  type StepIssue,
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
    const v = await verify(detect.vellumRoot, detect.cadetRoot, targetCtx);
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

  // 1. Put the vellum assistants to sleep (the vellum CLI does the stopping).
  start("stop-assistant");
  const stop = await stopAssistant(ops, options.verbose, options.termGraceMs ?? 5_000);
  done(stop);

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

  // 3.6 Same treatment for the gateway DB (its own contact/invite/request/
  // delivery channel columns). Also destination-path-derived from the plan.
  start("migrate-gateway-db");
  done(
    await migrateGatewayDb(
      detect,
      mig.files?.find((f) => stateRelativePath(f.src) === GATEWAY_DB_STATE_REL)?.dest,
    ),
  );

  // 4. Move a legacy home-level cadet lockfile into the config dir so the
  // migrated install keeps its identity (cadet no longer reads the old name).
  start("migrate-lockfile");
  done(await migrateHomeLockfile(envSuffixFor(detect.vellumRoot)));

  // 5. Verify against the backup ground truth.
  start("verify");
  const v = await verify(detect.vellumRoot, detect.cadetRoot, targetCtx);
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

// ---------------------------------------------------------------------------
// Repair mode — re-run the idempotent value steps against an already-
// migrated cadet root. When a user reports a migration bug after using
// cadet for a while, `vtc repair <cadetRoot>` fixes the data in place:
// no layout copy, no renames, no lockfile move — just the content
// transforms (all idempotent by construction) and the db value rewrites,
// after a fresh timestamped backup of the cadet root itself.
// ---------------------------------------------------------------------------

/** Cadet-destination-relative → state-relative: dissolve the instance dir. */
function cadetStateRel(relPath: string): string {
  const norm = relPath.split("\\").join("/");
  const m = norm.match(/^assistants\/[^/]+\//);
  return m ? norm.slice(m[0].length) : norm;
}

/** Gateway db at the cadet destination (PATH_MOVES renamed it on migrate). */
const GATEWAY_DB_DEST_REL = "gateway-security/gateway.sqlite";

interface CadetScan {
  /** Destination-relative paths, ready for the db steps. */
  assistantDb: string | null;
  gatewayDb: string | null;
  /** Rewrite-eligible, non-db files: destination-relative path + state-relative predicate path. */
  contentFiles: Array<{ destRel: string; stateRel: string }>;
}

/** One walk of the cadet tree, classified for the repair steps. */
async function scanCadetTree(cadetRoot: string): Promise<CadetScan> {
  const scan: CadetScan = { assistantDb: null, gatewayDb: null, contentFiles: [] };
  for (const entry of await walkTree(cadetRoot)) {
    if (entry.isDirectory) continue;
    const stateRel = cadetStateRel(entry.relPath);
    if (stateRel === ASSISTANT_DB_STATE_REL) {
      scan.assistantDb = entry.relPath;
      continue;
    }
    if (stateRel === GATEWAY_DB_DEST_REL || stateRel === GATEWAY_DB_STATE_REL) {
      scan.gatewayDb = entry.relPath;
      continue;
    }
    if (isDbArtifact(stateRel)) continue;
    if (!isRewriteEligible(stateRel)) continue;
    scan.contentFiles.push({ destRel: entry.relPath, stateRel });
  }
  return scan;
}

/**
 * Re-apply every sanctioned content transform in place. Idempotent by
 * construction: each transform maps clean content to itself, so a correct
 * root is a no-op and a buggy one gets exactly the missing edits.
 */
async function rewriteContent(
  cadetRoot: string,
  scan: CadetScan,
  log: (msg: string) => void,
): Promise<StepResult> {
  const substeps: Record<string, { files: number; changes: number }> = {};
  let filesWritten = 0;
  for (const { destRel, stateRel } of scan.contentFiles) {
    const abs = path.join(cadetRoot, destRel);
    const raw = await fs.readFile(abs, "utf8");
    const sanctioned = sanctionedContentTransform(stateRel, raw);
    const text = sanctioned ? sanctioned.text : applySubstitutions(raw).text;
    if (text === raw) continue;
    await fs.writeFile(abs, text, "utf8");
    filesWritten++;
    const substep = sanctioned?.substep ?? "machine-file substitutions";
    const changes = sanctioned
      ? Object.values(sanctioned.counts).reduce((a, b) => a + b, 0)
      : 1;
    const s = (substeps[substep] ??= { files: 0, changes: 0 });
    s.files++;
    s.changes += changes;
    log(`${substep}: ${destRel}`);
  }
  return {
    step: "rewrite-content",
    status: "completed",
    summary:
      filesWritten === 0
        ? "every eligible file already matches its sanctioned transform"
        : `${filesWritten} file(s) rewritten in place`,
    data: { substeps },
  };
}

/** Post-repair verification: zero vellum rows in dbs, transform-idempotent content. */
async function verifyRepair(cadetRoot: string, scan: CadetScan): Promise<StepResult> {
  const issues: StepIssue[] = [];
  let dbsChecked = 0;
  for (const [destRel, spec] of [
    [scan.assistantDb, VALUE_MIGRATED_DBS[0]!],
    [scan.gatewayDb, VALUE_MIGRATED_DBS[1]!],
  ] as const) {
    if (!destRel) continue;
    dbsChecked++;
    const leftover = await dbVellumRows(path.join(cadetRoot, destRel), spec);
    if (leftover === "unreadable") {
      issues.push({
        severity: "warning",
        message: `${destRel} is not a readable sqlite file — could not check for leftover rows`,
      });
    } else if (leftover > 0) {
      issues.push({
        severity: "error",
        message: `${destRel} still has ${leftover} vellum-branded row(s)`,
      });
    }
  }

  let contentChecked = 0;
  for (const { destRel, stateRel } of scan.contentFiles) {
    const raw = await fs.readFile(path.join(cadetRoot, destRel), "utf8");
    contentChecked++;
    const sanctioned = sanctionedContentTransform(stateRel, raw);
    if (sanctioned) {
      if (sanctioned.text !== raw) {
        issues.push({
          severity: "error",
          message: `${destRel}: ${sanctioned.substep} left legacy tokens behind`,
        });
      }
      continue;
    }
    // Generic machine file: same leftover-token scan the migrate verify uses.
    const leftovers = raw.match(/VELLUM_|@vellumai\/|\.vellum(?![A-Za-z-])/g);
    if (leftovers && leftovers.length > 0) {
      issues.push({
        severity: "error",
        message: `${destRel}: ${leftovers.length} leftover vellum token(s)`,
      });
    }
  }

  if (issues.some((i) => i.severity === "error")) {
    return {
      step: "verify",
      status: "failed",
      summary: `${issues.length} verification issue(s) in the repaired cadet root`,
      issues,
    };
  }
  return {
    step: "verify",
    status: "completed",
    summary: `${contentChecked} content file(s) transform-idempotent, ${dbsChecked} db(s) free of vellum rows`,
    issues,
  };
}

/** Repair takes no root: every migrated cadet root is discovered and fixed. */
export type RepairOptions = Omit<MigrateOptions, "cadetRoot">;

export async function repair(options: RepairOptions): Promise<MigrationReport> {
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

  const detect: DetectInfo = {
    vellumRoot: "",
    vellumRootExists: false,
    cadetRoot: "",
    cadetRootExists: false,
    cadetRootPopulated: false,
    previousManifest: false,
    version: null,
    deploymentKind: "unknown",
    docker: { instances: [], images: [] },
    runningProcesses: [],
    rootSizeBytes: 0,
    externalReferences: [],
  };

  // Discovery first: repair never takes a path — it finds every cadet
  // root this migrator created (manifest-bearing) and fixes them all.
  // The manifest is the migrator's own audit trail — its presence is what
  // makes "this root is mine to fix" a safe claim.
  start("discover-cadet-roots");
  const roots = await discoverCadetRoots();
  if (roots.length === 0) {
    done({
      step: "discover-cadet-roots",
      status: "failed",
      summary: "no migrated cadet roots found — repair only runs on roots this migrator created",
      issues: [
        {
          severity: "error",
          message: "no cadet root carries a .cadet-migration-manifest.json; run the migrator instead of repair",
        },
      ],
    });
    return finish(detect, steps, "repair", startedAt, null, EXIT_CODES.nothingToMigrate);
  }
  detect.cadetRoot = roots.join(", ");
  detect.cadetRootExists = true;
  detect.previousManifest = true;
  done({
    step: "discover-cadet-roots",
    status: "completed",
    summary: `${roots.length} migrated cadet root(s): ${roots.join(", ")}`,
  });

  if (options.dryRun) {
    for (const root of roots) {
      const scan = await scanCadetTree(root);
      let pending = 0;
      for (const { destRel, stateRel } of scan.contentFiles) {
        const raw = await fs.readFile(path.join(root, destRel), "utf8");
        const sanctioned = sanctionedContentTransform(stateRel, raw);
        const text = sanctioned ? sanctioned.text : applySubstitutions(raw).text;
        if (text !== raw) pending++;
      }
      done({
        step: "repair-plan",
        status: "planned",
        summary: `dry run in ${root}: ${pending} of ${scan.contentFiles.length} eligible file(s) pending rewrites, ${scan.assistantDb ? 1 : 0} assistant db(s) + ${scan.gatewayDb ? 1 : 0} gateway db(s) to re-check`,
      });
    }
    return finish(detect, steps, "repair", startedAt, null, EXIT_CODES.ok);
  }

  // Stop every cadet assistant ONCE — `cadet sleep --all` sleeps every
  // assistant the cadet lockfiles know about (the cadet CLI does the
  // stopping; we trust it).
  start("stop-cadet");
  const stop = await stopCadet(ops, options.verbose, options.termGraceMs ?? 5_000);
  done(stop);

  let lastBackupPath: string | null = null;
  for (const root of roots) {
    const scan = await scanCadetTree(root);

    // Fresh per-root backup BEFORE mutating it — same sha256 manifest
    // contract as the migrate backup. The instance-name suffix keeps
    // sibling instances (which share a backup anchor) from colliding on
    // the same-second timestamp.
    start("backup");
    const timestamp = `${utcStamp()}-${path.basename(root).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const bk = await backup(root, root, timestamp);
    done(bk);
    if (bk.status === "failed") {
      return finish(detect, steps, "repair", startedAt, lastBackupPath, EXIT_CODES.backupFailed);
    }
    lastBackupPath = backupDirFor(root, timestamp);

    // Re-apply every sanctioned content transform in place.
    start("rewrite-content");
    done(await rewriteContent(root, scan, log));

    // The db value steps, pointed at this root. All guarded and
    // idempotent: WHERE col = 'vellum' matches nothing on a clean root.
    start("migrate-assistant-db");
    done(await migrateAssistantDbAt(root, scan.assistantDb ?? undefined));

    start("migrate-gateway-db");
    done(await migrateGatewayDbAt(root, scan.gatewayDb ?? undefined));

    // Verify: dbs must have zero vellum rows; sanctioned content must be
    // transform-idempotent (rewriting an already-clean file changes nothing).
    start("verify");
    const v = await verifyRepair(root, scan);
    done(v);
    if (v.status === "failed") {
      return finish(detect, steps, "repair", startedAt, lastBackupPath, EXIT_CODES.verifyFailed);
    }
  }

  return finish(detect, steps, "repair", startedAt, lastBackupPath, EXIT_CODES.ok);
}
