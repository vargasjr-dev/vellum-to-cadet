import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverCadetRoots } from "./discover.js";
import { cadetDataRoot, migrateCliState } from "./steps/migrate-cli-state.js";
import { detect as detectStep, envSuffixFor, resolveMigrationTarget } from "./steps/detect.js";
import { preflight } from "./steps/preflight.js";
import { stopAssistant, stopCadet } from "./steps/stop-assistant.js";
import { backup, backupDirFor } from "./steps/backup.js";
import { buildCopyPlan, migrateLayout } from "./steps/migrate-layout.js";
import {
  ASSISTANT_DB_STATE_REL,
  GATEWAY_DB_DEST_REL,
  isGatewayDbStateRel,
  migrateAssistantDb,
  migrateAssistantDbAt,
  migrateGatewayDb,
  migrateGatewayDbAt,
} from "./steps/migrate-assistant-db.js";
import { migrateLockfile } from "./steps/migrate-lockfile.js";
import { migrateRetiredArchives, migrateRetiredManifests } from "./steps/migrate-retired.js";
import { migrateCredentialsStep } from "./steps/scrub-credentials.js";
import {
  cloudEmailFindings,
  detectCloudEmailStep,
  provisionCloudDomainsStep,
} from "./steps/cloud-email.js";
import {
  fetchDockerVolumes,
  loadDockerVolumes,
  vellumVolumeNames,
  verifyDockerVolumeData,
} from "./steps/migrate-docker-volumes.js";
import { readLockfileAssistants } from "./discover.js";
import { extractBundleStep } from "./steps/extract-bundle.js";
import { installCadetCli, cadetLoginStep, wakeAssistants } from "./steps/wake.js";
import { cadetImageRefs } from "./cadet-images.js";
import { handleToInstanceName, DEFAULT_TARGET_CTX } from "./layout.js";
import { dbVellumRows, verify, VALUE_MIGRATED_DBS } from "./steps/verify.js";
import { defaultProcessOps } from "./process.js";
import {
  applySubstitutions,
  findLegacyTokens,
  isDbArtifact,
  isRewriteEligible,
  sanctionedContentTransform,
  walkTree,
} from "./fs-utils.js";
import {
  EXIT_CODES,
  type ConfirmMigrationInfo,
  type DetectInfo,
  type MigrationReport,
  type MigrateOptions,
  type ProcessOps,
  type StepIssue,
  type StepItemEvent,
  type StepResult,
} from "./types.js";

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

/**
 * The stop step's honest no-op for export-contract ingest
 * (`stoppedByConstruction`): the root was packed from a sleeping assistant,
 * and the ingesting VM has no vellum CLI — nothing here to sleep and
 * nothing to sleep it with.
 */
function skippedStopStep(): StepResult {
  return {
    step: "stop-assistant",
    status: "skipped",
    summary: "skipped — exported root is asleep by construction",
  };
}

/**
 * Assemble the pre-migration confirmation payload from a detect result —
 * shared by the runner's confirm hook and the launcher's pre-detach prompt
 * (the detached child has no stdin, so the LAUNCHER is the one that asks).
 * The docker volume bytes ride the same du the preflight disk guard uses;
 * a failed du (daemon unreachable) yields null and the prompt names the
 * volumes without a size.
 */
export async function gatherConfirmInfo(
  detect: DetectInfo,
  ops: Pick<ProcessOps, "dockerVolumeSize">,
): Promise<ConfirmMigrationInfo> {
  const dockerInstances = detect.docker.instances;
  let dockerVolumeBytes: number | null = null;
  if (dockerInstances.length > 0) {
    const sizes: number[] = [];
    for (const instance of dockerInstances) {
      for (const volume of vellumVolumeNames(instance)) {
        const size = await ops.dockerVolumeSize?.(volume);
        if (typeof size === "number") sizes.push(size);
      }
    }
    if (sizes.length > 0) dockerVolumeBytes = sizes.reduce((a, b) => a + b, 0);
  }
  return {
    vellumRoot: detect.vellumRoot,
    cadetRoot: detect.cadetRoot,
    cadetRootExists: detect.cadetRootExists,
    assistants: detect.assistantHandles.map((handle) => ({
      name: handleToInstanceName(handle),
      docker: dockerInstances.includes(handle),
    })),
    retiredCount: detect.retiredCount,
    rootSizeBytes: detect.rootSizeBytes,
    dockerVolumeBytes,
    dockerVolumeCount: dockerInstances.reduce(
      (sum, instance) => sum + vellumVolumeNames(instance).length,
      0,
    ),
  };
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
  const onItem = (step: string) => (item: StepItemEvent): void => options.onStepItem?.(step, item);

  // --bundle: the bundle restores FIRST, as a real vellum assistant, so
  // detect below sees it and every downstream flow (target resolution,
  // plan-copy, verify) treats it exactly like any other assistant.
  if (options.bundlePath) {
    start("extract-bundle");
    const extraction = await extractBundleStep(options);
    done(extraction);
    if (extraction.status === "failed") {
      // The root is untouched (staging + atomic rename) — report the
      // detected state honestly alongside the failure.
      const failedDetect: DetectInfo = await detectStep(options, ops);
      return finish(failedDetect, steps, "plan", startedAt, null, EXIT_CODES.migrationFailed);
    }
  }

  start("detect");
  const detect: DetectInfo = await detectStep(options, ops);
  done({
    step: "detect",
    status: "completed",
    // One root line, then one bullet line per migrating assistant — the
    // story reads top to bottom (v0.0.11 run feedback: the docker suffix
    // crowded the root line and the nested line carried a whole sentence;
    // the deployment kind belongs on the line as a short "(docker)" tag).
    // v0.0.13 run feedback: plain bullets at the item indent, not tree
    // glyphs — the nested lines then read exactly like the live item
    // lines the renderer prints under a running step.
    summary: detect.vellumRootExists
      ? [
          `vellum root at ${detect.vellumRoot}`,
          ...detect.assistantHandles.map(
            (handle) =>
              `    · migrating assistant ${handleToInstanceName(handle)}${detect.docker.instances.includes(handle) ? " (docker)" : ""}`,
          ),
          // v0.0.15 field feedback: an existing cadet root is a decision
          // the user gets to make BEFORE confirming — its data will be
          // updated in place, and they may want to clear it first.
          ...(detect.cadetRootExists
            ? [
                `    · cadet root ${detect.cadetRoot} already exists — its data will be updated in place (delete it first for a clean start)`,
              ]
            : []),
          ...(detect.retiredCount > 0
            ? [`    · ${detect.retiredCount} retired assistant${detect.retiredCount === 1 ? "" : "s"} migrating too`]
            : []),
        ].join("\n")
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
  // On a clear target the instance is named after the first real assistant
  // handle (docker instance ids included — v0.0.10 run feedback: the
  // generic "vellum" name leaked into every recorded legacy path), never
  // the brand default.
  const targetCtx =
    target.kind === "fresh"
      ? { instanceName: target.freshName, nested: true }
      : detect.assistantHandles.length > 0
        ? {
            instanceName: handleToInstanceName(detect.assistantHandles[0] ?? ""),
            nested: false,
          }
        : DEFAULT_TARGET_CTX;
  if (target.kind === "fresh") {
    detect.cadetRoot = target.cadetRoot;
    detect.cadetRootExists = false;
    detect.cadetRootPopulated = false;
  } else if (target.kind === "already-migrated") {
    detect.cadetRoot = target.cadetRoot;
  }

  start("preflight");
  const pre = await preflight(detect, {
    skipDiskSpaceCheck: options.skipDiskSpaceCheck,
    dryRun: options.dryRun,
    dockerOps: options.dockerOps ?? ops,
    npmOps: options.npmOps ?? ops,
  });
  done(pre);
  if (pre.status === "failed") {
    return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.preflightFailed);
  }

  // Pre-migration confirmation (v0.0.15 field feedback: "warn the user
  // that we are about to put their assistants to sleep and migrate X
  // amount of data. They should confirm with enter, skippable with -y").
  // Runs BEFORE anything mutates — the fresh flow's stop-assistant, the
  // heal flow's fetch — and AFTER target resolution, so the prompt names
  // the final cadet root and flags an existing one the user may want to
  // clear first. The cli wires the callback only for interactive runs;
  // --yes/--json/non-TTY runs never see it.
  if (options.confirm && !options.dryRun) {
    const confirmed = await options.confirm(await gatherConfirmInfo(detect, ops));
    if (!confirmed) {
      return finish(detect, steps, "plan", startedAt, null, EXIT_CODES.notConfirmed);
    }
  }

  // Already-migrated path: the idempotent fix steps first — a re-run after a
  // migrator upgrade heals an install an older version left incomplete (no
  // cadet lockfile written, stale retired manifests, legacy credentials
  // kept) — then verify. The layout itself is never touched here.
  if (target.kind === "already-migrated") {
    // A re-run after a failed docker migration (e.g. the v0.0.11 hang)
    // heals the volumes too: fetch → the SAME value steps → load, the
    // identical shape as the fresh flow — the healed import is
    // value-migrated AND scrubbed before it lands back in the volumes.
    const reDockerFlow = detect.docker.instances.length > 0;
    const reWorkRoot = reDockerFlow ? await fs.mkdtemp(path.join(os.tmpdir(), "vtc-volumes-")) : null;
    if (reDockerFlow && reWorkRoot) {
      // The fresh flow sleeps the assistants BEFORE it fetches (a live
      // writer mid-tar is an inconsistent snapshot, and load writes the
      // volumes back). The re-run heals the SAME volumes, so it needs the
      // SAME quiet writer — and it cannot assume run 1 left them asleep:
      // the assistant may have been woken between runs (a re-run IS the
      // "the migrator got better since my last test" path). `vellum
      // sleep` on an already-asleep assistant is a no-op. Gated on the
      // docker flow because that is the only place a re-run touches
      // vellum-owned data — a local re-run reads and writes the cadet
      // root only, and must never yank a running assistant. (v0.0.15
      // field run: the re-test fetched volumes while the assistant was
      // still generating data.)
      start("stop-assistant");
      done(
        options.stoppedByConstruction
          ? skippedStopStep()
          : await stopAssistant(ops, options.verbose, options.termGraceMs ?? 5_000),
      );
      start("fetch-docker-volumes");
      const reFetched = done(
        await fetchDockerVolumes({
          dockerOps: options.dockerOps ?? ops,
          instances: detect.docker.instances,
          images: detect.docker.images,
          workRoot: reWorkRoot,
          onItem: onItem("fetch-docker-volumes"),
        }),
      );
      // Same abort contract as the fresh flow: a failed transfer must not
      // flow into the value steps and load (v0.0.13 run feedback).
      if (reFetched.status === "failed") {
        await fs.rm(reWorkRoot, { recursive: true, force: true });
        return finish(detect, steps, "verify-only", startedAt, null, EXIT_CODES.migrationFailed);
      }
    }
    // The value steps heal on a re-run too: idempotent by construction, and
    // an install an older migrator version left incomplete gets its dbs
    // value-migrated and its credentials scrubbed here. The working roots:
    // the extracted volume scratch tree (docker) and the already-migrated
    // cadet root (a mixed install's local assistants live there).
    const reValueRoots = [reWorkRoot, detect.cadetRoot].filter((r): r is string => r !== null);
    start("migrate-assistant-db");
    done(await migrateAssistantDb(reValueRoots));
    start("migrate-gateway-db");
    done(await migrateGatewayDb(reValueRoots));
    // Offline cloud-email detection (no vellum daemon): decrypt the CES
    // store directly for the assistant api key, then look up the managed
    // domain + email address on the vellum platform — before the scrub
    // deletes the key from the working copy (the original vellum root
    // keeps its own copy either way, so a re-run re-detects).
    start("detect-cloud-email");
    const reCloudEmail = done(
      await detectCloudEmailStep({ roots: reValueRoots, vellumRoot: detect.vellumRoot }),
    );
    start("migrate-credentials");
    const reCredentials = await migrateCredentialsStep(reValueRoots);
    done(reCredentials);
    if (reDockerFlow && reWorkRoot) {
      start("load-docker-volumes");
      const reLoaded = done(
        await loadDockerVolumes({
          dockerOps: options.dockerOps ?? ops,
          instances: detect.docker.instances,
          images: detect.docker.images,
          workRoot: reWorkRoot,
          onItem: onItem("load-docker-volumes"),
        }),
      );
      // Same abort contract as the fresh flow: a failed import must not
      // end in a green "Migration complete" (v0.0.13 run feedback).
      if (reLoaded.status === "failed") {
        await fs.rm(reWorkRoot, { recursive: true, force: true });
        return finish(detect, steps, "verify-only", startedAt, null, EXIT_CODES.migrationFailed);
      }
    }
    // Same image-ref contract as the fresh path: when a cadet CLI is
    // present, its version derives the docker entries' cadet images. A
    // missing binary gets installed HERE (before the lockfile merge reads
    // the version) — a re-run after a failed install heals the CLI too.
    let reBinAvailable = await ops.cadetBinAvailable();
    let reVersion: string | null = null;
    let reVersionReason: string | undefined;
    if (!reBinAvailable) {
      start("install-cadet");
      const reInstall = await installCadetCli(ops, 1, { retryAsSudo: options.retryInstallAsSudo });
      done(reInstall);
      reBinAvailable = reInstall.data?.["binAvailable"] === true;
    }
    if (reBinAvailable) {
      const asked = await ops.cadetVersion();
      reVersion = asked.version;
      reVersionReason = asked.detail;
    } else {
      reVersionReason = "the cadet CLI was not available on PATH";
    }
    start("migrate-lockfile");
    const reLockfile = await migrateLockfile({
      vellumRoot: detect.vellumRoot,
      cadetRoot: detect.cadetRoot,
      envSuffix: envSuffixFor(detect.vellumRoot),
      applyRenames: false,
      cadetImages: reVersion ? cadetImageRefs(reVersion) : null,
      cadetVersionUnavailableReason: reVersion ? undefined : reVersionReason,
    });
    done(reLockfile);
    start("migrate-cli-state");
    done(await migrateCliState(detect.vellumRoot, detect.cadetRoot));
    start("migrate-retired");
    done(
      await migrateRetiredManifests(detect.cadetRoot, {
        vellumRoot: detect.vellumRoot,
        applyRenames: false,
      }),
    );

    if (cadetDataRoot(detect.cadetRoot) !== detect.cadetRoot) {
      done(await migrateRetiredArchives(cadetDataRoot(detect.cadetRoot), targetCtx, onItem("migrate-retired"),
        { vellumRoot: detect.vellumRoot, applyRenames: true }));
    }

    start("verify");
    const reVerify = await verify(detect.vellumRoot, detect.cadetRoot, targetCtx);
    if (reDockerFlow && reWorkRoot) {
      const volumeVerify = await verifyDockerVolumeData(reWorkRoot);
      reVerify.issues = [...(reVerify.issues ?? []), ...volumeVerify.issues];
      reVerify.issues.push({ severity: "info", message: `${volumeVerify.dbsChecked} volume db(s) checked` }, { severity: "info", message: `${volumeVerify.storesChecked} volume credential store(s) checked` });
    }
    done(reVerify);
    if (reWorkRoot) await fs.rm(reWorkRoot, { recursive: true, force: true });

    const reDetected =
      reCredentials.data?.["detected"] === true ||
      reLockfile.data?.["legacyPlatformCredentials"] === true;
    if (reDetected) {
      start("cadet-login");
      done(
        await cadetLoginStep(ops, {
          binAvailable: reBinAvailable,
          detected: true,
          interactive: !options.internalRun,
        }),
      );
    }
    // Wake (v0.0.15 field feedback: "I did not see a cadet wake at the
    // end") — the re-run is a full heal, and with the lockfile merged
    // above the migrated assistants are tracked, so wake them exactly
    // like the fresh flow would.
    const reAssistantCount = (await readLockfileAssistants()).length;
    start("wake-assistants");
    done(await wakeAssistants(ops, reAssistantCount, reBinAvailable));
    // Provision the detected vellum domain + email on the cadet cloud —
    // only once a cadet account exists (`cadet login` above) and the
    // migrated assistants have registered with it (the wake). No account
    // → the step reports pending and the final summary carries the
    // follow-up.
    start("provision-cloud-domains");
    done(
      await provisionCloudDomainsStep({
        findings: cloudEmailFindings(reCloudEmail),
        envSuffix: envSuffixFor(detect.vellumRoot),
      }),
    );
    return finish(detect, steps, "verify-only", startedAt, null, EXIT_CODES.ok);
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
  //    Export-contract ingest skips it: a staged root is asleep by
  //    construction — export refused to pack a running assistant — and the
  //    ingesting VM has no vellum CLI to sleep anything with.
  start("stop-assistant");
  const stop = options.stoppedByConstruction
    ? skippedStopStep()
    : await stopAssistant(ops, options.verbose, options.termGraceMs ?? 5_000);
  done(stop);

  // 2. (No backup step.) The vellum root is a read-only source of truth —
  //    the migration copies FROM it and never writes to it, so the original
  //    IS the backup and a full copy only doubles the disk bill (v0.0.9
  //    run feedback). The timestamp still stamps the layout manifest. Only
  //    repair mode backs anything up, because IT mutates a root in place
  //    (the cadet root).
  const timestamp = utcStamp();

  // 3. Migrate the layout (copy + renames + rewrites + manifest).
  start("migrate-layout");
  const mig = await migrateLayout(detect, timestamp, targetCtx);
  done(mig);
  if (mig.status === "failed") {
    return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.migrationFailed);
  }

  // 3.5 Docker deployments keep the assistant's real data in docker
  //     volumes (workspace, gateway security, CES security) — the host
  //     root only carries the CLI's own state. Once detect says docker,
  //     the value steps below run against the volume data as well: fetch
  //     extracts each instance's volumes into a STATE-SHAPED scratch
  //     tree (one state root per assistant — the same layout the copied
  //     host root carries), and load writes the migrated trees back.
  //     "The difference between volume or directory" is confined to
  //     those two brackets (v0.0.11 run feedback: the host-path db steps
  //     ran first and failed before any volume work started).
  const dockerOps = options.dockerOps ?? ops;
  const dockerFlow = detect.docker.instances.length > 0;
  const volumeWorkRoot = dockerFlow ? await fs.mkdtemp(path.join(os.tmpdir(), "vtc-volumes-")) : null;

  // 3.6 Extract each instance's volumes and apply the workspace content
  //     transforms in place — the docker analog of the copy phase.
  if (dockerFlow) {
    start("fetch-docker-volumes");
    const fetched = done(
      await fetchDockerVolumes({
        dockerOps,
        instances: detect.docker.instances,
        images: detect.docker.images,
        workRoot: volumeWorkRoot!,
        onItem: onItem("fetch-docker-volumes"),
      }),
    );
    // A failed transfer poisons everything downstream — the value steps
    // would run over a partial scratch tree and load would import it
    // (v0.0.13 run feedback: an extraction that died on disk space kept
    // "migrating" for 10 more minutes and ended "✔ Migration complete"
    // with the data half-there). Abort now, discard the scratch, report
    // the failure. The docker volumes are left alone either way: they are
    // either the untouched source of truth or a partial import a re-run
    // re-imports idempotently — deleting them could destroy good data.
    if (fetched.status === "failed") {
      if (volumeWorkRoot) await fs.rm(volumeWorkRoot, { recursive: true, force: true });
      return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.migrationFailed);
    }
  }

  // 3.7 The value steps — the SAME calls for local and docker, zero
  //     surface branching left in the runner. Each step scans the working
  //     roots for its own targets (dbs by their state-tree paths via
  //     findStateDbs, credential stores for keys.enc). The docker scratch
  //     tree is materialized STATE-SHAPED — one state root per assistant,
  //     the same layout the copied host root carries — which is what lets
  //     one discovery serve both surfaces; the roots themselves are the
  //     only per-surface input (the scratch root rides along on docker,
  //     and a mixed install's local assistants live on the host copy).
  const valueRoots = [volumeWorkRoot, detect.cadetRoot].filter((r): r is string => r !== null);

  //     Rewrite vellum-branded VALUES inside EVERY assistant db (channel
  //     ids, attachment links, the managed connection row). The root hosts
  //     one state tree per assistant, so the scan can find several copies
  //     of each db — every one gets the rewrite (rewriting only the first
  //     left every later workspace branded; v0.0.9 run feedback).
  start("migrate-assistant-db");
  done(await migrateAssistantDb(valueRoots));

  // 3.8 Same treatment for every gateway DB (its own contact/invite/
  //     request/delivery channel columns).
  start("migrate-gateway-db");
  done(await migrateGatewayDb(valueRoots));

  // 3.8.5 Offline cloud-email detection (no vellum daemon): decrypt the
  //     CES store directly (the CES token = store.key, the CES file =
  //     keys.enc) for the assistant api key, then look the managed domain
  //     + email address up on the vellum platform — the last read before
  //     the scrub deletes the key from the working copy (the original
  //     vellum root keeps its own copy, so a re-run re-detects).
  start("detect-cloud-email");
  const cloudEmail = done(
    await detectCloudEmailStep({ roots: valueRoots, vellumRoot: detect.vellumRoot }),
  );

  // 3.9 Remove the legacy vellum platform credentials from every working
  //     root — the cloud api key and webhook secret can't be kept; `cadet
  //     login` (below, before wake) establishes fresh ones.
  start("migrate-credentials");
  const credentials = await migrateCredentialsStep(valueRoots);
  done(credentials);

  // 3.10 Write the migrated trees into the cadet volumes under the
  //      migrated instance names.
  if (dockerFlow) {
    start("load-docker-volumes");
    const loaded = done(
      await loadDockerVolumes({
        dockerOps,
        instances: detect.docker.instances,
        images: detect.docker.images,
        workRoot: volumeWorkRoot!,
        onItem: onItem("load-docker-volumes"),
      }),
    );
    // Same abort contract as fetch (v0.0.13 run feedback): a failed import
    // must not end in a green "Migration complete" — discard the scratch
    // tree and report the failure; the incomplete cadet volumes get
    // re-imported idempotently on a re-run.
    if (loaded.status === "failed") {
      if (volumeWorkRoot) await fs.rm(volumeWorkRoot, { recursive: true, force: true });
      return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.migrationFailed);
    }
  }

  // 4. Put the cadet CLI on the machine — before the lockfile conversion:
  //    the migrated docker entries must record the CADet image refs for
  //    the installed cadet version (v0.0.10 run feedback: the
  //    containerInfo pointed at the vellum images the containers ran
  //    before). Its version is captured right after the install.
  const assistantCount = (await readLockfileAssistants()).length;
  start("install-cadet");
  const install = await installCadetCli(ops, assistantCount, { retryAsSudo: options.retryInstallAsSudo });
  done(install);
  const cadetVersion = typeof install.data?.["version"] === "string" ? install.data["version"] : null;
  const cadetImages = cadetVersion ? cadetImageRefs(cadetVersion) : null;
  // Field QA: the image-refs warning used to fire with no reason shown —
  // surface WHY the cadet version stayed unresolved (binary missing vs
  // unparsable `cadet --version` output) straight into the warning.
  const rawVersionReason = install.data?.["versionUnavailableReason"];
  const cadetVersionReason =
    cadetVersion !== null
      ? undefined
      : typeof rawVersionReason === "string"
        ? rawVersionReason
        : install.data?.["binAvailable"] === true
          ? "`cadet --version` printed no parsable version"
          : "the cadet CLI was not available on PATH";

  // 4. Convert the vellum lockfile into the cadet canonical config-dir
  //    lockfile (transformed entries, the path the cadet CLI reads), and
  //    move a legacy home-level cadet lockfile aside for identity
  //    continuity. The docker entries' containerInfo gets the cadet image
  //    refs for the installed cadet — never the vellum images.
  start("migrate-lockfile");
  const lockfile = await migrateLockfile({
    vellumRoot: detect.vellumRoot,
    cadetRoot: detect.cadetRoot,
    envSuffix: envSuffixFor(detect.vellumRoot),
    applyRenames: true,
    cadetImages,
    cadetVersionUnavailableReason: cadetVersionReason,
  });
  done(lockfile);

  // 4.5 Retired-assistant archives ride along verbatim — untar each one,
  // run the same assistant-logic migration over the extracted tree, re-tar.
  // Success is optional by design: failures warn and never fail the run.
  // The sibling metadata manifests + file names get the same cleaning.
  start("migrate-cli-state");
  done(await migrateCliState(detect.vellumRoot, detect.cadetRoot));
  start("migrate-retired");
  done(
    await migrateRetiredArchives(
      detect.cadetRoot,
      targetCtx,
      onItem("migrate-retired"),
      { vellumRoot: detect.vellumRoot, applyRenames: true },
    ),
  );

  if (cadetDataRoot(detect.cadetRoot) !== detect.cadetRoot) {
    done(await migrateRetiredArchives(cadetDataRoot(detect.cadetRoot), targetCtx, onItem("migrate-retired"),
      { vellumRoot: detect.vellumRoot, applyRenames: true }));
  }

  // 5. Verify against the vellum source. Findings are WARNINGS, not
  //    failures: the migration itself is complete, and residual branding in
  //    a cold corner of the data must not scare the user with exit code 7.
  //    The docker flow folds the volume-data checks into the same step —
  //    the extracted trees are exactly what load wrote into the cadet
  //    volumes (v0.0.10 run feedback: the volume dbs and credential store
  //    went unverified).
  start("verify");
  const verifyResult = await verify(detect.vellumRoot, detect.cadetRoot, targetCtx);
  if (dockerFlow) {
    const volumeVerify = await verifyDockerVolumeData(volumeWorkRoot!);
    verifyResult.issues = [...(verifyResult.issues ?? []), ...volumeVerify.issues];
    verifyResult.issues.push({ severity: "info", message: `${volumeVerify.dbsChecked} volume db(s) checked` }, { severity: "info", message: `${volumeVerify.storesChecked} volume credential store(s) checked` });
  }
  done(verifyResult);

  // The extracted trees were verified and imported; the vellum volumes are
  // the untouched source of truth, so the scratch copy can go.
  if (volumeWorkRoot) await fs.rm(volumeWorkRoot, { recursive: true, force: true });

  start("cadet-login");
  done(
    await cadetLoginStep(ops, {
      binAvailable: install.data?.["binAvailable"] === true,
      detected:
        credentials.data?.["detected"] === true ||
        lockfile.data?.["legacyPlatformCredentials"] === true,
      interactive: !options.internalRun,
    }),
  );
  start("wake-assistants");
  done(await wakeAssistants(ops, assistantCount, install.data?.["binAvailable"] === true));

  // Provision the detected vellum domain + email on the cadet cloud — if
  // and only after they create a cadet account (`cadet login` above) and
  // the migrated assistants have registered with it (the wake). No
  // account → the step reports pending and the final summary carries the
  // follow-up.
  start("provision-cloud-domains");
  done(
    await provisionCloudDomainsStep({
      findings: cloudEmailFindings(cloudEmail),
      envSuffix: envSuffixFor(detect.vellumRoot),
    }),
  );

  return finish(detect, steps, "migrate", startedAt, null, EXIT_CODES.ok);
}

/** The substep labels the managed-provider cutovers report their changes under. */
const SPEECH_CUTOVER_SUBSTEP = "speech provider cutover";
const WEB_SEARCH_CUTOVER_SUBSTEP = "web search provider cutover";
const TUNNEL_INGRESS_SUBSTEP = "tunnel ingress urls";

/**
 * The managed-provider cutovers swap the retired managed service ids for real
 * defaults, and follow-ups surface as end-of-run next steps in the final
 * summary block when a cutover fired anywhere in the run. Any step's substep
 * totals count: migrate-layout during a fresh copy, rewrite-content in repair
 * mode. Speech swapped in providers whose API keys the user never had (the
 * managed service billed credits, not keys) — without them voice input and
 * spoken replies fail after the wake. Web search swapped in the inference
 * provider's built-in search, which needs no key — the reminder only suggests
 * adding a BYOK search provider for stronger results.
 */
function cutoverNextSteps(steps: StepResult[]): string[] | undefined {
  const fired = new Set<string>();
  for (const step of steps) {
    const data = step.data;
    if (data === null || typeof data !== "object") continue;
    const substeps: unknown = (data as Record<string, unknown>).substeps;
    if (substeps === null || typeof substeps !== "object") continue;
    for (const [label, entry] of Object.entries(substeps as Record<string, unknown>)) {
      if (
        label !== SPEECH_CUTOVER_SUBSTEP &&
        label !== WEB_SEARCH_CUTOVER_SUBSTEP &&
        label !== TUNNEL_INGRESS_SUBSTEP
      ) {
        continue;
      }
      if (entry === null || typeof entry !== "object") continue;
      const changes: unknown = (entry as Record<string, unknown>).changes;
      if (typeof changes === "number" && changes > 0) fired.add(label);
    }
  }
  if (fired.size === 0) return undefined;
  const warnings: string[] = [];
  if (fired.has(SPEECH_CUTOVER_SUBSTEP)) {
    warnings.push(
      "The managed speech service is retired: STT now defaults to Deepgram and TTS to ElevenLabs.",
      "Add a Deepgram API key so voice input keeps working (Cadet settings → Models & Services).",
      "Add an ElevenLabs API key so spoken replies keep working (Cadet settings → Models & Services).",
    );
  }
  if (fired.has(WEB_SEARCH_CUTOVER_SUBSTEP)) {
    warnings.push(
      "The managed web search service is retired: search now defaults to your model's built-in web search — no key needed.",
      "Add a Perplexity or Brave API key for stronger search results (Cadet settings → Models & Services).",
    );
  }
  if (fired.has(TUNNEL_INGRESS_SUBSTEP)) {
    warnings.push(
      "The managed tunnel host convention changed: recorded tunnel ingress URLs were rewritten from tunnel-{env}.mycadet.ai to {env}-tunnel.mycadet.ai.",
      "Telegram and Twilio webhooks re-register against the rewritten URL on the next wake — no action needed, but check delivery after the first message.",
    );
  }
  return warnings;
}

/** The provision-cloud-domains pending note — no cadet account at run end. */
function provisionPendingNextSteps(steps: StepResult[]): string[] {
  const pending = steps.some(
    (s) => s.step === "provision-cloud-domains" && s.data?.["pending"] === true,
  );
  return pending
    ? [
        "No Cadet account yet: run `cadet login`, then re-run the migrator — it registers your vellum domain and email address on Cadet.",
      ]
    : [];
}

function finish(
  detect: DetectInfo,
  steps: StepResult[],
  mode: MigrationReport["mode"],
  startedAt: string,
  backupPath: string | null,
  exitCode: MigrationReport["exitCode"],
): MigrationReport {
  const finishedAt = new Date().toISOString();
  const nextSteps = [...(cutoverNextSteps(steps) ?? []), ...provisionPendingNextSteps(steps)];
  return {
    ok: exitCode === EXIT_CODES.ok,
    exitCode,
    mode,
    detect,
    steps,
    backupPath,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    nextSteps: nextSteps.length > 0 ? nextSteps : undefined,
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

interface CadetScan {
  /** Destination-relative paths, ready for the db steps. One per assistant workspace. */
  assistantDbs: string[];
  gatewayDbs: string[];
  /** Rewrite-eligible, non-db files: destination-relative path + state-relative predicate path. */
  contentFiles: Array<{ destRel: string; stateRel: string }>;
}

/** One walk of the cadet tree, classified for the repair steps. */
async function scanCadetTree(cadetRoot: string): Promise<CadetScan> {
  const scan: CadetScan = { assistantDbs: [], gatewayDbs: [], contentFiles: [] };
  for (const entry of await walkTree(cadetRoot)) {
    if (entry.isDirectory) continue;
    const stateRel = cadetStateRel(entry.relPath);
    if (stateRel === ASSISTANT_DB_STATE_REL) {
      scan.assistantDbs.push(entry.relPath);
      continue;
    }
    if (stateRel === GATEWAY_DB_DEST_REL || isGatewayDbStateRel(stateRel)) {
      scan.gatewayDbs.push(entry.relPath);
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
    for (const [name, n] of Object.entries(sanctioned?.substeps ?? {})) {
      if (n <= 0) continue;
      const side = (substeps[name] ??= { files: 0, changes: 0 });
      side.files++;
      side.changes += n;
    }
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
  const assistantSpec = VALUE_MIGRATED_DBS[0]!;
  const gatewaySpec = VALUE_MIGRATED_DBS[1]!;
  const dbChecks: Array<[string, typeof assistantSpec]> = [
    ...scan.assistantDbs.map((d): [string, typeof assistantSpec] => [d, assistantSpec]),
    ...scan.gatewayDbs.map((d): [string, typeof assistantSpec] => [d, gatewaySpec]),
  ];
  for (const [destRel, spec] of dbChecks) {
    dbsChecked++;
    const leftover = await dbVellumRows(path.join(cadetRoot, destRel), spec);
    if (leftover === "unreadable") {
      issues.push({
        severity: "warning",
        message: `${destRel} is not a readable sqlite file — could not check for leftover rows`,
      });
    } else if (leftover.total > 0) {
      issues.push({
        severity: "warning",
        message: `${destRel} still has vellum-branded data — ${leftover.details.join("; ")}`,
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
          severity: "warning",
          message: `${destRel}: ${sanctioned.substep} left legacy tokens behind`,
        });
      }
      continue;
    }
    // Generic machine file: same leftover-token scan the migrate verify uses.
    const leftovers = findLegacyTokens(raw);
    if (leftovers && leftovers.length > 0) {
      issues.push({
        severity: "warning",
        message: `${destRel}: ${leftovers.length} leftover vellum token(s)`,
      });
    }
  }

  if (issues.length > 0) {
    return {
      step: "verify",
      status: "completed",
      summary: `repaired root verified with ${issues.length} warning(s) (see ⚠)`,
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
    assistantHandles: [],
    retiredCount: 0,
    deploymentKind: "local",
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
        summary: `dry run in ${root}: ${pending} of ${scan.contentFiles.length} eligible file(s) pending rewrites, ${scan.assistantDbs.length} assistant db(s) + ${scan.gatewayDbs.length} gateway db(s) to re-check`,
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
    for (const destRel of scan.assistantDbs) {
      start("migrate-assistant-db");
      done(await migrateAssistantDbAt(root, destRel));
    }

    for (const destRel of scan.gatewayDbs) {
      start("migrate-gateway-db");
      done(await migrateGatewayDbAt(root, destRel));
    }

    // Verify: dbs must have zero vellum rows; sanctioned content must be
    // transform-idempotent (rewriting an already-clean file changes nothing).
    // Findings are warnings — same philosophy as migrate-mode verify.
    start("verify");
    done(await verifyRepair(root, scan));
  }

  return finish(detect, steps, "repair", startedAt, lastBackupPath, EXIT_CODES.ok);
}
