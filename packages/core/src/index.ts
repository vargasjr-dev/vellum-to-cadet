/**
 * @mycadet/vellum — programmatic API.
 *
 * The cadet platform imports this to run migrations from a service; the npx
 * CLI and (later) the desktop wrapper are thin shells over the same engine.
 */
export { migrate } from "./runner.js";
export {
  migrateFromExport,
  packVellumRoot,
  stageExportedRoot,
  validateStagedRoot,
  type MigrateFromExportOptions,
  type StagedRootVerdict,
} from "./export-contract.js";
export { detect as detectInstall } from "./steps/detect.js";
export {
  probeDesktopInstall,
  markMigrated,
  markDeclined,
  readDesktopMigrationState,
  desktopMigrationStatePath,
  type DesktopMigrationState,
  type DesktopProbe,
  type DesktopProbeQuietReason,
} from "./desktop.js";
export { gatherConfirmInfo } from "./runner.js";
export { buildCopyPlan } from "./steps/migrate-layout.js";
export { verify } from "./steps/verify.js";
export { defaultProcessOps } from "./process.js";
export {
  EXIT_CODES,
  type ConfirmMigrationInfo,
  type DetectInfo,
  type ExitCode,
  type FileAction,
  type MigrationReport,
  type MigrateOptions,
  type ProcessOps,
  type StepItemEvent,
  type StepResult,
} from "./types.js";
export {
  PATH_RENAMES,
  textSubstitutions,
  USER_WORKSPACE_DIR,
  WORKSPACE_RUNTIME_DIR,
  VERBATIM_DIRS,
} from "./layout.js";
