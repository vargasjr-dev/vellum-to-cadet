import { describe, test } from "node:test";

import {
  applySubstitutions,
  formatBytes,
  rewriteLegacyTokens,
  rewritePersonaPrompt,
  sanctionedContentTransform,
} from "../../src/fs-utils.js";
import { DEFAULT_TARGET_CTX } from "../../src/layout.js";
import { expect } from "../helpers/expect.js";

describe("formatBytes", () => {
  test("converts to GB when applicable", () => {
    expect(formatBytes(10_800_600_000)).toBe("10.8GB");
    expect(formatBytes(1e9)).toBe("1.0GB");
  });

  test("keeps MB/KB/B below the GB threshold", () => {
    expect(formatBytes(999_999_999)).toBe("1000.0MB");
    expect(formatBytes(10800.6 * 1e6)).toBe("10.8GB");
    expect(formatBytes(512_400)).toBe("512.4KB");
    expect(formatBytes(512)).toBe("512B");
  });
});

describe("applySubstitutions with a nested migration target", () => {
  test("xdg root paths point at the fresh instance dir", () => {
    const { text } = applySubstitutions(
      "stateRoot=/home/u/.local/share/vellum/assistants/velly/.vellum/workspace\n",
      { instanceName: "vellum-2", nested: true },
    );
    expect(text).toContain(
      "/home/u/.local/share/cadet/assistants/vellum-2/assistants/velly/workspace",
    );
  });

  test("legacy root tokens use the configured instance name", () => {
    const { text } = applySubstitutions("root=~/.vellum\n", {
      instanceName: "vellum-3",
      nested: true,
    });
    expect(text).toContain(".local/share/cadet/assistants/vellum-3");
  });

  test("the default target matches the historical behavior", () => {
    const { text } = applySubstitutions("root=~/.vellum\n", DEFAULT_TARGET_CTX);
    expect(text).toContain(".local/share/cadet/assistants/vellum");
  });
});

describe("rewriteLegacyTokens — precise edits for conversation/runtime logs", () => {
  test("flips attachment links and quoted channel values", () => {
    const out = rewriteLegacyTokens(
      'attached vellum://workspace/data/attachments/a.pdf on channel "vellum"',
    );
    expect(out.text).toBe('attached cadet://workspace/data/attachments/a.pdf on channel "cadet"');
    expect(out.counts["attachment-links"]).toBe(1);
    expect(out.counts["channel-values"]).toBe(1);
  });

  test("leaves quoted user prose and single-quoted shell output verbatim", () => {
    const raw = 'user said "I used vellum before it was cadet" and ran: SELECT * FROM t WHERE c = \'vellum\';';
    const out = rewriteLegacyTokens(raw);
    expect(out.text).toBe(raw);
  });

  test("rewrites moved state paths and env names", () => {
    const out = rewriteLegacyTokens("VELLUM_ROOT_DIR=/root/.vellum/workspace");
    expect(out.text).toContain("CADET_ROOT_DIR=");
    expect(out.text).toContain(".local/share/cadet/assistants/vellum/workspace");
    expect(out.text).not.toContain("VELLUM_");
  });

  test("is idempotent — clean content maps to itself", () => {
    const clean = 'docs at cadet://workspace/notes on channel "cadet" with CADET_ROOT_DIR set';
    expect(rewriteLegacyTokens(clean).text).toBe(clean);
  });
});

describe("rewritePersonaPrompt — brand flip with path protection", () => {
  test("flips brand words in prose, links, and paths", () => {
    const out = rewritePersonaPrompt(
      "Comes with the Vellum harness. Docs at vellum://workspace/notes. Keys in ~/.vellum.",
    );
    expect(out.text).toBe(
      "Comes with the Cadet harness. Docs at cadet://workspace/notes. Keys in ~/.local/share/cadet/assistants/vellum.",
    );
    // Only the prose "Vellum" counts as a brand word — the link's vellum://
    // was already consumed (and counted) by the attachment-links rule.
    expect(out.counts["brand-words"]).toBe(1);
  });

  test("the migrated instance's own name survives inside rewritten paths", () => {
    // The path rule legitimately writes `…/assistants/vellum` (the migrated
    // instance is NAMED vellum) — the brand flip must not corrupt it.
    const out = rewritePersonaPrompt("We keep docs at vellum://x and keys in ~/.vellum.");
    expect(out.text).toContain(".local/share/cadet/assistants/vellum");
    expect(out.text).not.toContain("assistants/cadet");
  });

  test("is idempotent — an already-flipped prompt maps to itself", () => {
    const clean = "Comes with the Cadet harness. Docs at cadet://workspace/notes. Keys in ~/.local/share/cadet/assistants/vellum.";
    expect(rewritePersonaPrompt(clean).text).toBe(clean);
  });
});

describe("sanctionedContentTransform — the shared dispatch", () => {
  test("each category reports its own substep", () => {
    expect(sanctionedContentTransform("workspace/config.json", '{"provider":"vellum"}')?.substep).toBe(
      "config.json rewrite",
    );
    expect(sanctionedContentTransform("workspace/skills/s/install-meta.json", '{"origin":"vellum"}')?.substep).toBe(
      "skills renames",
    );
    expect(sanctionedContentTransform("workspace/conversations/x/messages.jsonl", 'a "vellum"')?.substep).toBe(
      "conversation log rewrites",
    );
    expect(sanctionedContentTransform("workspace/data/logs/assistant-2026-01-01.log", "vellum://x")?.substep).toBe(
      "runtime log rewrites",
    );
    expect(sanctionedContentTransform("workspace/SOUL.md", "the Vellum harness")?.substep).toBe(
      "persona prompt rewrites",
    );
  });

  test("unmapped files return null (generic machine-file treatment)", () => {
    expect(sanctionedContentTransform("hooks/on-wake.sh", "VELLUM_")).toBeNull();
    expect(sanctionedContentTransform("workspace/notes/vellum-history.md", "vellum")).toBeNull();
  });
});
