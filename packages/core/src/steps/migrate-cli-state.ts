import { constants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StepIssue, StepResult } from "../types.js";
import { envSuffixFor, vellumDataRoot } from "./detect.js";

/** Shared CLI state belongs beside assistants/, never inside an assistant. */
export function cadetDataRoot(root: string): string {
  return path.basename(path.dirname(root)) === "assistants"
    ? path.dirname(path.dirname(root)) : root;
}

/** Copy missing state only: a retry must preserve existing Cadet archives/logs. */
export async function migrateCliState(vellumRoot: string, cadetRoot: string): Promise<StepResult> {
  const issues: StepIssue[] = [];
  let copied = 0;
  async function merge(source: string, destination: string): Promise<void> {
    if (path.resolve(source) === path.resolve(destination)) return;
    let entries;
    try { entries = await fs.readdir(source, { withFileTypes: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ severity: "warning", message: `${source}: ${(err as Error).message}` });
      return;
    }
    try {
      await fs.mkdir(destination, { recursive: true });
    } catch (err) {
      issues.push({ severity: "warning", message: `${destination}: ${(err as Error).message} - shared state not copied` });
      return;
    }
    for (const entry of entries) {
      const src = path.join(source, entry.name);
      const dest = path.join(destination, entry.name);
      try {
        if (path.basename(source) === "retired" && entry.name.startsWith("vellum-")) {
          const renamed = path.join(destination, entry.name.slice("vellum-".length));
          if (await fs.lstat(renamed).then(() => true, () => false)) continue;
        }
        if (entry.isDirectory()) await merge(src, dest);
        else if (entry.isFile()) {
          // COPYFILE_EXCL protects existing destination files, including retries.
          await fs.copyFile(src, dest, constants.COPYFILE_EXCL);
          copied++;
        } else if (entry.isSymbolicLink()) {
          await fs.symlink(await fs.readlink(src), dest);
          copied++;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") issues.push({ severity: "warning", message: `${src}: ${(err as Error).message} — not copied` });
      }
    }
  }
  const dataRoot = cadetDataRoot(cadetRoot);
  for (const sourceRoot of new Set([vellumDataRoot(vellumRoot), vellumRoot])) {
    for (const dir of ["retired", "backups", "upgrade-logs"]) {
      await merge(path.join(sourceRoot, dir), path.join(dataRoot, dir));
    }
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const suffix = envSuffixFor(vellumRoot);
  await merge(path.join(configHome, `vellum${suffix}`, "logs"), path.join(configHome, `cadet${suffix}`, "logs"));
  return { step: "migrate-cli-state", status: "completed", summary: `copied ${copied} shared archive/log file(s)`, issues, data: { copied } };
}
