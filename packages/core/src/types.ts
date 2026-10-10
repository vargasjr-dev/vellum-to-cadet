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
  /** "info" = a nested takeaway bullet, "warning" = yellow ⚠, "error" = red !. */
  severity: "info" | "warning" | "error";
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
  /**
   * Display-quiet: recorded in the report and --json, but excluded from the
   * live step stream and the human summary list — e.g. a step whose success
   * line is pure noise in the UI while failures stay visible.
   */
  quiet?: boolean;
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
  /** Modern-layout assistant dir names (the handles), sorted. Empty for legacy roots. */
  assistantHandles: string[];
  /**
   * Retired-assistant archives discovered in the vellum root's retired/ dir
   * — they migrate too, and the detect summary reports the count when > 0.
   */
  retiredCount: number;
  deploymentKind: "desktop" | "docker" | "local";
  docker: DockerDeployment;
  runningProcesses: Array<{ pid: number; command: string }>;
  rootSizeBytes: number;
  externalReferences: string[];
}

/** Live progress: a named item inside the running step (e.g. each retired archive). */
export interface StepItemEvent {
  /** Item name shown verbatim in the nested progress line. */
  name: string;
  /** "started" opens a pending line; "completed"/"warning" resolve it. */
  status: "started" | "completed" | "warning";
  /** Short outcome text appended after the name when resolving. */
  summary?: string;
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
  /** Live progress: nested item progress within the current step. */
  onStepItem?: (step: string, item: StepItemEvent) => void;
  /**
   * Test seam: override the docker volume ops (volume → dir and dir →
   * volume copies). Defaults to the real docker CLI via temp containers.
   */
  dockerOps?: Pick<ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable">;
}

/**
 * How the runner talks to the outside world about vellum processes. The
 * migrator never kills anything itself — stopping the assistant is the
 * vellum CLI's job (`vellum sleep`); we only discover and report.
 */
export interface ProcessOps {
  find(patterns: string[]): Promise<Array<{ pid: number; command: string }>>;
  /** Ask the vellum CLI its own version (`vellum --version`), or null. */
  vellumVersion(): Promise<string | null>;
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
  /** Install the cadet CLI globally (`npm install -g cadet`). */
  installCadet(): Promise<void>;
  /** Wake every cadet assistant (`cadet wake --all`). */
  cadetWakeAll(): Promise<void>;
  /**
   * Run the cadet CLI's interactive cloud login (browser PKCE), so the
   * migrated assistants get fresh cloud credentials when the vellum ones
   * were removed. stdio is inherited — the user completes the flow.
   */
  cadetLogin(): Promise<void>;
  /** True when the `cadet` binary resolves on PATH (`cadet --version`). */
  cadetBinAvailable(): Promise<boolean>;
  /**
   * Ask the cadet CLI its own version (`cadet --version`), or null. The
   * migrated docker entries must record the CADet image refs for the
   * installed cadet (the images are tagged per cadet version) — so the
   * version is captured right after the CLI is installed, before the
   * lockfile conversion writes containerInfo.
   */
  cadetVersion(): Promise<string | null>;
  /** Copy a docker volume's contents down to a host dir (temp container + docker cp). */
  dockerVolumeToDir(volume: string, destDir: string, image?: string): Promise<void>;
  /** Copy a host dir's contents up into a docker volume (created if missing). */
  dockerDirToVolume(srcDir: string, volume: string, image?: string): Promise<void>;
  /** True when the docker CLI has a usable daemon (`docker info` succeeds). */
  dockerAvailable(): Promise<boolean>;
  /** The npm global node_modules dir (`npm root -g`), or null when npm is unavailable. */
  npmGlobalRoot(): Promise<string | null>;
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
  /** Repair mode only: the cadet-root backup written before in-place mutation. */
  backupPath: string | null;
  startedAt: string;
  finishedAt: string;
  /** Wall-clock duration of the whole run, in milliseconds. */
  durationMs: number;
}

export const EXIT_CODES = {
  ok: 0,
  nothingToMigrate: 2,
  preflightFailed: 3,
  backupFailed: 5,
  migrationFailed: 6,
  cadetRootConflict: 8,
  /** Discovery found multiple plausible vellum roots in a non-interactive run. */
  ambiguousRoot: 9,
  /** Uninstall was not confirmed (declined or unconfirmable). */
  uninstallDeclined: 10,
  /** Uninstall failed to delete one or more targets. */
  uninstallFailed: 11,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
