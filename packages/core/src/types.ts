/** Shared result types. Every step returns one; the runner aggregates them. */

export type StepStatus = "completed" | "skipped" | "failed" | "planned";

export interface FileAction {
  /** Path relative to the vellum root (POSIX separators). */
  src: string;
  /** Path relative to the cadet root after renames are applied. */
  dest: string;
  action: "verbatim" | "rewrite" | "rename-only";
  bytes: number;
  /** Substitution counts by name, for rewrite actions. */
  substitutions?: Record<string, number>;
}

export interface StepIssue {
  severity: "warning" | "error";
  message: string;
  /** Optional relative path the issue relates to. */
  path?: string;
}

export interface StepResult {
  step: string;
  status: StepStatus;
  /** Human-readable one-liner. */
  summary: string;
  files?: FileAction[];
  issues?: StepIssue[];
  data?: Record<string, unknown>;
}

export interface DetectInfo {
  vellumRoot: string;
  cadetRoot: string;
  vellumRootExists: boolean;
  cadetRootExists: boolean;
  cadetRootPopulated: boolean;
  previousManifest: boolean;
  version: string | null;
  deploymentKind: "desktop" | "docker" | "unknown";
  docker: DockerDeployment;
  runningProcesses: Array<{ pid: number; command: string }>;
  rootSizeBytes: number;
  externalReferences: string[];
}

export interface MigrateOptions {
  /** Override the default ~/.vellum source root. */
  vellumRoot?: string;
  /** Override the default ~/.cadet target root. */
  cadetRoot?: string;
  /** True when cadetRoot came from an explicit --cadet-root flag. */
  cadetRootExplicit?: boolean;
  /** Print the plan and touch nothing. */
  dryRun?: boolean;
  /** Non-interactive: never prompt, assume yes. */
  yes?: boolean;
  /** Verbose logging to stderr. */
  verbose?: boolean;
  /** Test seam: override process discovery and the stop command. */
  processOps?: ProcessOps;
  /** Test seam: skip filesystem checks that need privileged statfs. */
  skipDiskSpaceCheck?: boolean;
  /** Test seam: grace period after `vellum sleep` before re-discovery. */
  termGraceMs?: number;
  /** Live progress: called right before a step starts executing. */
  onStepStart?: (step: string) => void;
  /** Live progress: called with each step's result as it completes. */
  onStepDone?: (result: StepResult) => void;
}

/**
 * How the runner talks to the outside world about vellum processes. The
 * migrator never kills anything itself — stopping the assistant is the
 * vellum CLI's job (`vellum sleep`); we only discover and report.
 */
export interface ProcessOps {
  find(patterns: string[]): Promise<Array<{ pid: number; command: string }>>;
  /**
   * Ask the vellum CLI to put an assistant to sleep. The vellum CLI has no
   * sleep-all flag, so the migrator iterates the lockfile and calls this
   * once per tracked assistant (`vellum sleep <assistant>`); pass no
   * argument for the CLI's own default resolution.
   */
  vellumSleep(assistant?: string): Promise<void>;
  /**
   * Ask the cadet CLI to put its assistants to sleep (repair mode).
   * `cadet sleep --all` stops every assistant the cadet lockfiles know
   * about — a cadet root can have several running at once.
   */
  cadetSleep(): Promise<void>;
}

/**
 * Evidence that a vellum root belongs to a docker deployment, read from
 * the vellum lockfile — the same record `vellum ps` is derived from. Only
 * lockfile-tracked assistants matter; the CLI's own sleep command stops
 * their containers, so no docker APIs are touched.
 */
export interface DockerDeployment {
  /** Instance ids whose lockfile entry records docker topology. */
  instances: string[];
  /** Docker images recorded in the lockfile's containerInfo. */
  images: string[];
}

export interface MigrationReport {
  ok: boolean;
  exitCode: ExitCode;
  mode: "plan" | "migrate" | "verify-only" | "repair";
  detect: DetectInfo;
  steps: StepResult[];
  backupPath: string | null;
  startedAt: string;
  finishedAt: string;
}

export const EXIT_CODES = {
  ok: 0,
  nothingToMigrate: 2,
  preflightFailed: 3,
  processesUnstoppable: 4,
  backupFailed: 5,
  migrationFailed: 6,
  verifyFailed: 7,
  cadetRootConflict: 8,
  /** Discovery found multiple plausible vellum roots in a non-interactive run. */
  ambiguousRoot: 9,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
