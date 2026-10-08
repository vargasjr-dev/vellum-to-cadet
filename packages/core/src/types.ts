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
  runningProcesses: Array<{ pid: number; command: string }>;
  rootSizeBytes: number;
  externalReferences: string[];
}

export interface MigrateOptions {
  /** Override the default ~/.vellum source root. */
  vellumRoot?: string;
  /** Override the default ~/.cadet target root. */
  cadetRoot?: string;
  /** Print the plan and touch nothing. */
  dryRun?: boolean;
  /** Non-interactive: never prompt, assume yes. */
  yes?: boolean;
  /** Verbose logging to stderr. */
  verbose?: boolean;
  /** Platform seam: skip the stop-assistant step (container-managed lifecycles). */
  skipStopAssistant?: boolean;
  /** Test seam: override process discovery/termination. */
  processKiller?: ProcessKiller;
  /** Test seam: skip filesystem checks that need privileged statfs. */
  skipDiskSpaceCheck?: boolean;
  /** Test seam: SIGTERM grace period before SIGKILL escalation. */
  termGraceMs?: number;
}

/** How the runner communicates with the outside world. */
export interface ProcessKiller {
  find(patterns: string[]): Promise<Array<{ pid: number; command: string }>>;
  terminate(pid: number): Promise<void>;
  kill(pid: number): Promise<void>;
}

export interface MigrationReport {
  ok: boolean;
  exitCode: ExitCode;
  mode: "plan" | "migrate" | "verify-only";
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
