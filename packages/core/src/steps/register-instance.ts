import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { basePortsForEnvSuffix, declashEntryPorts } from "../port-declash.js";
import type { StepIssue, StepResult } from "../types.js";

/**
 * Register the migrated instance so the migration's end state is a
 * wakeable assistant — the piece a `--bundle BOOTSTRAP` of a data-only
 * export could never reach before (field review item 5): the lockfile
 * conversion works from the VELLUM lockfile, and a data-only export ships
 * none, so no entry landed in the cadet lockfile and `cadet wake --all`
 * had nothing to wake. `cadet hatch` allocates its own dir (it will not
 * adopt an existing one) and `cadet restore` takes only its own tar.gz —
 * nothing on the cadet side picks the migrated directory up.
 *
 * The step tops the lockfile up ADDITIVELY: the converted entries (when a
 * vellum lockfile existed) are never touched, and a same-id entry means a
 * previous run or live cadet state — skipped, never rewritten.
 *
 * It also seeds the gateway's signing identity when absent: the export
 * never carried one (the cloud gateway owned the key and never exported
 * it), so the migrated tree boots keyless and wake fails the continuity
 * check. The key is written gateway-owned ONLY — the exact file the
 * gateway reads (`<instanceDir>/gateway-security/actor-token-signing-key`,
 * 32 raw bytes, 0600, atomic temp+rename, dir 0700 — the shape cadet's own
 * `persistRootSigningKey` writes) — and nowhere else: no lockfile field,
 * no env var. A gateway that self-heals a missing key simply keeps this
 * one; a runtime that gates on its presence finds it. An EXISTING key is
 * never clobbered — rotating it under paired clients orphans every one of
 * them.
 */
export interface RegisterInstanceOptions {
  /**
   * The migrated instance's dir — where the gateway actually lives (the
   * runner resolves it: nested fresh-instance migrations land under
   * `<cadetRoot>/assistants/<name>`, a bare-root migration IS the cadet
   * root). The signing key seeds under its gateway-security/.
   */
  instanceDir: string;
  /** The migrated instance's name — the lockfile id cadet wakes by. */
  instanceName: string;
  /** cadet env suffix for the config dir (from envSuffixFor(vellumRoot)). */
  envSuffix: string;
  /**
   * Bind probe for the synthesized entry's port allocation; tests inject a
   * deterministic probe (production binds 0.0.0.0, port-declash.ts).
   */
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface RegisterInstanceData {
  /** Absolute path of the cadet lockfile the entry landed in (or would have). */
  lockfile: string;
  /** Absolute path of the signing key file (seeded or already present). */
  signingKeyPath: string;
  lockfileRegistered: boolean;
  signingKeySeeded: boolean;
}

export async function registerInstanceStep(
  opts: RegisterInstanceOptions,
): Promise<StepResult> {
  const issues: StepIssue[] = [];
  const parts: string[] = [];

  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(process.env.HOME?.trim() || "", ".config");
  const destDir = path.join(configHome, `cadet${opts.envSuffix}`);
  const lockfilePath = path.join(destDir, "lockfile.json");

  const data: RegisterInstanceData = {
    lockfile: lockfilePath,
    signingKeyPath: path.join(opts.instanceDir, "gateway-security", "actor-token-signing-key"),
    lockfileRegistered: false,
    signingKeySeeded: false,
  };

  // ── 1. The lockfile entry — additive-only. ──────────────────────────────
  let raw: Record<string, unknown> = {};
  let assistants: Record<string, unknown>[] = [];
  const existing = await readJsonIfExists(lockfilePath, issues);
  if (existing !== null) {
    raw = existing;
    assistants = Array.isArray(raw.assistants)
      ? raw.assistants.filter(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null && !Array.isArray(e),
        )
      : [];
  }
  const alreadyRegistered = assistants.some(
    (e) => e.assistantId === opts.instanceName,
  );
  if (alreadyRegistered) {
    parts.push("instance already registered in the cadet lockfile");
  } else {
    const entry = await synthesizeEntry(opts, assistants, issues);
    assistants.push(entry);
    raw.assistants = assistants;
    if (typeof raw.activeAssistant !== "string" || raw.activeAssistant.length === 0) {
      raw.activeAssistant = opts.instanceName;
    }
    try {
      await fs.mkdir(destDir, { recursive: true });
      await atomicWriteJson(lockfilePath, raw);
      data.lockfileRegistered = true;
      parts.push(`registered ${opts.instanceName} in ${lockfilePath}`);
    } catch (err) {
      issues.push({
        severity: "warning",
        message: `could not register ${opts.instanceName} in ${lockfilePath} (${(err as Error).message}) — \`cadet wake\` will not see the migrated assistant until it is added`,
      });
      parts.push("cadet lockfile could not be written");
    }
  }

  // ── 2. The gateway signing key — seed when absent, never clobber. ──────
  try {
    const seeded = await seedSigningKey(data.signingKeyPath);
    if (seeded) {
      data.signingKeySeeded = true;
      parts.push("seeded the gateway signing key (gateway-owned, instance-local)");
    } else {
      parts.push("gateway signing key already present — left as-is");
    }
  } catch (err) {
    issues.push({
      severity: "warning",
      message: `could not seed the gateway signing key at ${data.signingKeyPath} (${(err as Error).message}) — wake's signing-identity check fails until one exists`,
    });
    parts.push("gateway signing key could not be seeded");
  }

  return {
    step: "register-instance",
    status: "completed",
    summary: parts.filter((p) => p.length > 0).join("; "),
    issues,
    data: data as unknown as Record<string, unknown>,
  };
}

/**
 * The minimal local entry cadet's parser accepts (`assistantId` is the only
 * strictly-required field; `cloud` defaults to local) with the `resources`
 * the local wake path needs: the migrated instance dir and ports allocated
 * the same way converted entries get them — walked from the environment's
 * base ports, skipping everything already claimed and every port a live
 * process holds.
 */
async function synthesizeEntry(
  opts: RegisterInstanceOptions,
  existing: Record<string, unknown>[],
  issues: StepIssue[],
): Promise<Record<string, unknown>> {
  const bases = basePortsForEnvSuffix(opts.envSuffix);
  const entry: Record<string, unknown> = {
    assistantId: opts.instanceName,
    name: opts.instanceName,
    cloud: "local",
    hatchedAt: new Date().toISOString(),
    resources: {
      instanceDir: opts.instanceDir,
      // Bases as the recorded starting point — the de-clash walk below
      // reallocates any that collide with live state, exactly like the
      // converted entries.
      gatewayPort: bases.gateway,
      daemonPort: bases.daemon,
      cesPort: bases.ces,
    },
  };
  const claimed = new Set<number>();
  for (const e of existing) {
    const resources = e.resources;
    if (typeof resources !== "object" || resources === null || Array.isArray(resources)) continue;
    for (const field of ["gatewayPort", "daemonPort", "qdrantPort", "cesPort"]) {
      const value = (resources as Record<string, unknown>)[field];
      if (typeof value === "number") claimed.add(value);
    }
  }
  try {
    await declashEntryPorts(entry, {
      envSuffix: opts.envSuffix,
      claimed,
      isPortFree: opts.isPortFree,
    });
  } catch (err) {
    // Port-walk exhaustion warns — the entry keeps its base ports and
    // cadet's wake reports the conflict when it binds.
    issues.push({
      severity: "warning",
      message: `could not de-clash the synthesized ports for ${opts.instanceName} (${(err as Error).message}) — the base ports ride through, and \`cadet wake\` reports any conflict when it binds`,
    });
  }
  return entry;
}

/**
 * Write the gateway's signing key the way cadet's own `persistRootSigningKey`
 * does: a 64-hex-char key materializing as 32 raw bytes at
 * `<instanceDir>/gateway-security/actor-token-signing-key`, 0600, via atomic
 * temp+rename inside a 0700 dir. Random per instance (crypto.randomBytes) —
 * there is no key to recover from the export (the cloud gateway owned it and
 * never exported it), so a fresh one is the only option; paired clients
 * re-pair against it on their next connect.
 */
async function seedSigningKey(keyPath: string): Promise<boolean> {
  try {
    await fs.stat(keyPath);
    return false; // Present — NEVER clobber; rotating it orphans paired clients.
  } catch {
    // Absent — the expected post-migration state.
  }
  const keyHex = randomBytes(32).toString("hex");
  const dir = path.dirname(keyPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.signing-key-${randomBytes(8).toString("hex")}`);
  await fs.writeFile(temporary, Buffer.from(keyHex, "hex"), { mode: 0o600 });
  await fs.rename(temporary, keyPath);
  return true;
}

async function readJsonIfExists(
  filePath: string,
  issues: StepIssue[],
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Unparsable live state — never overwrite it; cadet's own repair owns it.
    issues.push({
      severity: "warning",
      message: `${filePath} could not be read (${(err as Error).message}) — the instance was not registered; repair the lockfile and re-run`,
    });
    return null;
  }
}

async function atomicWriteJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporary = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temporary, filePath);
}
