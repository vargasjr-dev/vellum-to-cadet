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

/**
 * What the pre-migration confirmation tells the user, gathered from detect
 * (v0.0.15 field feedback: "warn the user that we are about to put their
 * assistants to sleep and migrate X amount of data"). dockerVolumeBytes is
 * null when the volumes could not be measured (daemon unreachable) — the
 * prompt then names the volumes without a size.
 */
export interface ConfirmMigrationInfo {
  vellumRoot: string;
  cadetRoot: string;
  /** The cadet root already exists (re-run or occupied target) — its data will be updated in place. */
  cadetRootExists: boolean;
  /** Assistants about to be put to sleep, under their MIGRATED names. */
  assistants: Array<{ name: string; docker: boolean }>;
  retiredCount: number;
  /** Bytes in the vellum host root. */
  rootSizeBytes: number;
  /** Bytes across the docker volumes being fetched, or null when unmeasured. */
  dockerVolumeBytes: number | null;
  /** Number of docker volumes to fetch (0 when not a docker install). */
  dockerVolumeCount: number;
}

/** Live progress: a named item inside the running step (e.g. each retired archive). */
export interface StepItemEvent {
  /** Item name shown verbatim in the nested progress line. */
  name: string;
  /**
   * "started" opens a pending line; "completed"/"warning" resolve it;
   * "progress" refreshes the open line's byte counter mid-transfer.
   */
  status: "started" | "completed" | "warning" | "progress";
  /** Short outcome text appended after the name when resolving. */
  summary?: string;
  /**
   * Byte counts for a "progress" event (docker volume transfers). The
   * renderer formats it as `1.2GB/4.0GB (30%)`; totalBytes is undefined
   * when the size pre-pass failed, and the line degrades to bytes-so-far.
   */
  progress?: { bytes: number; totalBytes?: number; label?: string };
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
  /** True when this process IS the detached child (--internal-run): the launcher already confirmed. */
  internalRun?: boolean;
  /**
   * Pre-flight confirmation (v0.0.15 field feedback: the run puts assistants
   * to sleep and moves tens of GB before the user ever had a say). Called
   * once after detect + target resolution, before the FIRST mutating step —
   * so the prompt can name the final cadet root and flag an existing one
   * the user may want to clear first. Returning false aborts with
   * EXIT_CODES.notConfirmed and touches nothing.
   */
  confirm?: (info: ConfirmMigrationInfo) => Promise<boolean>;
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
   * volume copies, plus the size/free-space probes preflight's disk guard
   * reads). Defaults to the real docker CLI via temp containers.
   */
  dockerOps?: Pick<
    ProcessOps,
    "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable" | "dockerVolumeSize" | "dockerDiskFree"
  >;
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
  /**
   * Copy a docker volume's contents down to a host dir (temp container +
   * docker cp). onProgress, when given, receives byte counts of the tar
   * stream as it flows — long transfers report steady progress instead of
   * hanging silently (the v0.0.12 run feedback).
   */
  dockerVolumeToDir(
    volume: string,
    destDir: string,
    image?: string,
    onProgress?: (bytes: number, totalBytes?: number) => void,
  ): Promise<void>;
  /** Copy a host dir's contents up into a docker volume (created if missing). */
  dockerDirToVolume(
    srcDir: string,
    volume: string,
    image?: string,
    onProgress?: (bytes: number, totalBytes?: number) => void,
  ): Promise<void>;
  /**
   * Create an empty named docker volume if missing (`docker volume create`
   * on an existing name is a no-op). Used by load-docker-volumes to
   * pre-create the runtime volumes the migrated instance should have.
   */
  dockerVolumeCreate?(name: string): Promise<void>;
  /** True when the docker CLI has a usable daemon (`docker info` succeeds). */
  dockerAvailable(): Promise<boolean>;
  /**
   * A volume's content size in bytes (`du -sk` inside a throwaway container),
   * or undefined when it cannot be measured — the progress denominator for
   * the volume copies; preflight's disk guard sums these per instance.
   */
  dockerVolumeSize?(volume: string, image?: string): Promise<number | undefined>;
  /**
   * The docker daemon's free disk bytes (`df` inside a throwaway container —
   * volumes live on the daemon's own filesystem, which host-side statfs
   * cannot see), or undefined when it cannot be determined.
   */
  dockerDiskFree?(image?: string): Promise<number | undefined>;
  /**
   * A volume's content size in bytes (`du -sk` inside a throwaway container),
   * or undefined when it cannot be measured — the progress denominator for
   * the volume copies; preflight's disk guard sums these per instance.
   */
  dockerVolumeSize?(volume: string, image?: string): Promise<number | undefined>;
  /**
   * The docker daemon's free disk bytes (`df` inside a throwaway container —
   * volumes live on the daemon's own filesystem, which host-side statfs
   * cannot see), or undefined when it cannot be determined.
   */
  dockerDiskFree?(image?: string): Promise<number | undefined>;
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
  /** The pre-migration confirmation was declined (same number as uninstall's decline — same semantic). */
  notConfirmed: 10,
  /** Uninstall failed to delete one or more targets. */
  uninstallFailed: 11,
  /** A migration is already running (the run lock is held by a live pid). */
  alreadyRunning: 12,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
