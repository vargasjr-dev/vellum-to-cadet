import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { lockfileCandidates } from "../discover.js";
import { basePortsForEnvSuffix } from "../port-declash.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * Register a restored bundle as a real vellum citizen — in the VELLUM
 * lockfile, before the rest of the migration runs (Vargas's direction):
 * a data-only `--bundle` export carries no CLI lockfile state, so until
 * now the restored assistant migrated as data and the cadet lockfile
 * never learned about it (`cadet ps`/`wake --all` saw nothing — field
 * review item 5).
 *
 * The synthesis writes the VELLUM side, not the cadet side: the entry is
 * the shape vellum itself writes for a local assistant, into the first
 * location vellum's own reader scans (lockfileCandidates order — the
 * e2e hook dir, the home-level legacy names, the canonical
 * `~/.config/vellum/lockfile.json`, created when none exists). The
 * standard lockfile conversion then does the cadet-side work through the
 * one path every other assistant takes: brand prefixes stripped, the
 * instance dir mapped through the rename map, ports de-clashed, vellum
 * cloud identity absent because none is synthesized. No cadet-side
 * special case, no second writer of the cadet lockfile.
 *
 * The entry is strictly local: `cloud: "local"`, no platform/cloud
 * registration ids, no secrets. The recorded ports are the env's base
 * ports — placeholders for the de-clash to reallocate (nothing binds
 * them; the converted entry always lands on fresh, free ports). The
 * merge is additive and idempotent: an entry the winning lockfile
 * already records (a previous run, or a live vellum install that really
 * hatched this assistant) is never touched.
 */
export interface RegisterBundleLockfileOptions {
  /** The vellum root the bundle restored into (for the env's port bases). */
  vellumRoot: string;
  /** The restored assistant's name — also its dir handle and lockfile id. */
  assistantName: string;
  /** Where the restore landed the assistant (the modern assistants/ dir, or the legacy root itself). */
  assistantDir: string;
  /** cadet env suffix for the port bases (from envSuffixFor(vellumRoot)). */
  envSuffix: string;
}

export interface RegisterBundleLockfileData {
  /** The vellum lockfile the entry landed in (or would have). */
  lockfile: string;
  registered: boolean;
  /** True when the lockfile itself was newly created. */
  created: boolean;
}

/** HOME-first home resolution — mirrors the reader (discover.ts). */
function home(): string {
  const fromEnv = process.env["HOME"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return os.homedir();
}

async function readJsonCandidate(
  candidate: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(candidate, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unparsable — the reader skips it too.
  }
  return null;
}

async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.vtc-tmp-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

export async function registerBundleLockfileStep(
  opts: RegisterBundleLockfileOptions,
): Promise<StepResult> {
  const issues: StepIssue[] = [];
  const data: RegisterBundleLockfileData = {
    lockfile: "",
    registered: false,
    created: false,
  };
  const step = "register-bundle-lockfile";

  // The entry: strictly local, placeholder ports the de-clash reallocates.
  const bases = basePortsForEnvSuffix(opts.envSuffix);
  const entry: Record<string, unknown> = {
    assistantId: opts.assistantName,
    name: opts.assistantName,
    cloud: "local",
    resources: {
      instanceDir: opts.assistantDir,
      daemonPort: bases.daemon,
      gatewayPort: bases.gateway,
      cesPort: bases.ces,
    },
  };

  // The winning candidate: the first location vellum's own reader scans
  // that parses. An existing winner gets the entry additively; no winner
  // creates the canonical config-dir lockfile.
  let winnerPath: string | null = null;
  let winnerData: Record<string, unknown> | null = null;
  for (const candidate of await lockfileCandidates()) {
    const parsed = await readJsonCandidate(candidate);
    if (parsed !== null) {
      winnerPath = candidate;
      winnerData = parsed;
      break;
    }
  }

  let lockfilePath: string;
  let root: Record<string, unknown>;
  if (winnerPath !== null && winnerData !== null) {
    lockfilePath = winnerPath;
    root = winnerData;
  } else {
    // Create where the reader looks first for a dir-scoped lockfile: the
    // e2e hook dir when set, else the canonical XDG location.
    const lockfileDir = process.env["VELLUM_LOCKFILE_DIR"]?.trim();
    lockfilePath = lockfileDir
      ? path.join(lockfileDir, "lockfile.json")
      : path.join(home(), ".config", "vellum", "lockfile.json");
    root = {};
    data.created = true;
  }
  data.lockfile = lockfilePath;

  const assistants = Array.isArray(root.assistants)
    ? root.assistants.filter(
        (e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null && !Array.isArray(e),
      )
    : [];
  if (assistants.some((e) => e.assistantId === opts.assistantName)) {
    return {
      step,
      status: "skipped",
      summary: `${opts.assistantName} is already in ${lockfilePath} — nothing to do`,
      issues,
      data: { ...data, registered: false },
    };
  }

  assistants.push(entry);
  root.assistants = assistants;
  if (typeof root.activeAssistant !== "string" || root.activeAssistant.length === 0) {
    root.activeAssistant = opts.assistantName;
  }

  try {
    await atomicWriteJson(lockfilePath, root);
    data.registered = true;
    return {
      step,
      status: "completed",
      summary: data.created
        ? `created ${lockfilePath} and registered ${opts.assistantName} as a local vellum assistant`
        : `registered ${opts.assistantName} in ${lockfilePath}`,
      issues,
      data: { ...data },
    };
  } catch (err) {
    issues.push({
      severity: "warning",
      message: `could not register ${opts.assistantName} in ${lockfilePath} (${(err as Error).message}) — the migrated assistant will not appear in \`cadet ps\`/\`wake --all\` until it is added`,
    });
    return {
      step,
      status: "completed",
      summary: `could not write ${lockfilePath}`,
      issues,
      data: { ...data },
    };
  }
}
