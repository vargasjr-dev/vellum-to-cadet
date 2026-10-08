import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DetectInfo, MigrateOptions, ProcessKiller } from "../types.js";
import { discoveryPatterns } from "../process.js";
import { treeSize } from "../fs-utils.js";
import { LEGACY_INSTANCE_NAME } from "../layout.js";

export const DEFAULT_VELLUM_ROOT = path.join(os.homedir(), ".vellum");

/**
 * The cadet root mirrors the vellum root's shape:
 *   ~/.local/share/vellum[-env] → ~/.local/share/cadet[-env]
 *   ~/.vellum[-env]             → ~/.local/share/cadet[-env]/assistants/<name>
 *                                 (a NAMED instance in cadet's multi-instance
 *                                 layout — never a bare ~/.cadet root)
 * Custom roots migrate to a sibling named `cadet`.
 */
export function toCadetRoot(vellumRoot: string): string {
  const base = path.basename(vellumRoot);
  if (base === "vellum" || base.startsWith("vellum-")) {
    return path.join(path.dirname(vellumRoot), `cadet${base.slice("vellum".length)}`);
  }
  if (base === ".vellum" || base.startsWith(".vellum-")) {
    const dataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    const envSuffix = base.startsWith(".vellum-")
      ? base.slice(".vellum".length)
      : "";
    return path.join(
      dataHome,
      `cadet${envSuffix}`,
      "assistants",
      LEGACY_INSTANCE_NAME,
    );
  }
  return path.join(path.dirname(vellumRoot), "cadet");
}

/**
 * Known external places that may reference the vellum root without living
 * inside it. We detect and report these; touching them is a follow-up.
 */
const EXTERNAL_REFERENCE_PROBES: ReadonlyArray<{ label: string; file: string }> = [
  { label: "launchd agent", file: path.join(os.homedir(), "Library/LaunchAgents") },
  { label: "systemd unit", file: path.join(os.homedir(), ".config/systemd/user") },
];

export async function detect(options: MigrateOptions, killer: ProcessKiller): Promise<DetectInfo> {
  const vellumRoot = options.vellumRoot ?? DEFAULT_VELLUM_ROOT;
  const cadetRoot = options.cadetRoot ?? toCadetRoot(vellumRoot);

  const [vellumRootExists, cadetRootExists] = await Promise.all([
    pathExists(vellumRoot),
    pathExists(cadetRoot),
  ]);

  let cadetRootPopulated = false;
  let previousManifest = false;
  if (cadetRootExists) {
    const entries = await fs.readdir(cadetRoot);
    cadetRootPopulated = entries.length > 0;
    previousManifest = entries.includes(".cadet-migration-manifest.json");
  }

  const runningProcesses = vellumRootExists
    ? await killer.find(discoveryPatterns())
    : [];

  const rootSizeBytes = vellumRootExists ? await treeSize(vellumRoot) : 0;

  return {
    vellumRoot,
    cadetRoot,
    vellumRootExists,
    cadetRootExists,
    cadetRootPopulated,
    previousManifest,
    version: await detectVersion(vellumRoot),
    deploymentKind: await detectDeploymentKind(vellumRoot),
    runningProcesses,
    rootSizeBytes,
    externalReferences: await detectExternalReferences(vellumRoot),
  };
}

async function detectVersion(vellumRoot: string): Promise<string | null> {
  // 0.12.x recorded its version in the desktop marker; best-effort read.
  // Modern layout: the marker lives inside each assistant's state dir.
  const candidates = [
    path.join(vellumRoot, ".vellum-assistant", "version"),
    path.join(vellumRoot, "version"),
  ];
  try {
    for (const name of await fs.readdir(path.join(vellumRoot, "assistants"))) {
      candidates.push(path.join(vellumRoot, "assistants", name, ".vellum", ".vellum-assistant", "version"));
    }
  } catch {
    // Legacy single-root layout — nothing to add.
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      try {
        return (await fs.readFile(candidate, "utf8")).trim() || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function detectDeploymentKind(
  vellumRoot: string,
): Promise<DetectInfo["deploymentKind"]> {
  if (await pathExists("/.dockerenv")) return "docker";
  if (
    await pathExists(
      path.join(vellumRoot, ".vellum-assistant"),
    )
  ) {
    return "desktop";
  }
  // Modern layout: the marker lives inside each assistant's state dir.
  try {
    for (const name of await fs.readdir(path.join(vellumRoot, "assistants"))) {
      if (
        await pathExists(
          path.join(vellumRoot, "assistants", name, ".vellum", ".vellum-assistant"),
        )
      ) {
        return "desktop";
      }
    }
  } catch {
    // Not a modern root.
  }
  return "unknown";
}

async function detectExternalReferences(vellumRoot: string): Promise<string[]> {
  const refs: string[] = [];
  for (const probe of EXTERNAL_REFERENCE_PROBES) {
    if (!(await pathExists(probe.file))) continue;
    try {
      const stat = await fs.stat(probe.file);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(probe.file);
        if (entries.length > 0) {
          refs.push(`${probe.label}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${probe.file}`);
        }
      }
    } catch {
      // Unreadable — skip silently, it's a best-effort probe.
    }
  }
  void vellumRoot;
  return refs;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
