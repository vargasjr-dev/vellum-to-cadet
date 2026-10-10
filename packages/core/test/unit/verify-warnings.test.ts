import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect } from "../helpers/expect.js";
import { verify } from "../../src/steps/verify.js";

/**
 * Verification findings are WARNINGS, never failures: the migration is
 * complete by the time verify runs, and residual branding in a cold corner
 * of the data must not flip the run to exit code 7. These tests pin that
 * every finding class demotes to a warning on a completed step, with the
 * offending rows/files NAMED.
 */
describe("verify: findings are named warnings on a completed step", () => {
  test("a leftover vellum token in a rewritten file warns (does not fail)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-verify-warn-"));
    const vellumRoot = path.join(tmp, "vellum");
    const cadetRoot = path.join(tmp, "cadet");

    // Conversation-log shape: rewrite-eligible, sanctioned transform
    // rewrites vellum:// links. The cadet side was mangled by something
    // else (differs from source AND from the sanctioned rewrite) → flagged.
    const logDir = path.join(vellumRoot, "workspace", "data", "logs");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "day.log"), "vellum://a.png\n");
    const cadetLogDir = path.join(cadetRoot, "workspace", "data", "logs");
    await fs.mkdir(cadetLogDir, { recursive: true });
    await fs.writeFile(path.join(cadetLogDir, "day.log"), "manually edited content\n");

    const result = await verify(vellumRoot, cadetRoot);
    expect(result.status).toBe("completed");
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.severity).toBe("warning");
    expect(result.issues?.[0]?.path).toBe("workspace/data/logs/day.log");
    expect(result.summary).toContain("1 warning(s) (see ⚠)");
  });

  test("a source file missing from the cadet root warns (does not fail)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-verify-miss-"));
    const vellumRoot = path.join(tmp, "vellum");
    const cadetRoot = path.join(tmp, "cadet");
    // Source tree with a plain user file; the cadet root lacks it entirely.
    await fs.mkdir(path.join(vellumRoot, "workspace", "notes"), { recursive: true });
    await fs.writeFile(path.join(vellumRoot, "workspace", "notes", "keep.md"), "user data\n");

    const result = await verify(vellumRoot, cadetRoot);
    expect(result.status).toBe("completed");
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.severity).toBe("warning");
    expect(result.issues?.[0]?.message).toBe("missing in cadet root");
  });
});
