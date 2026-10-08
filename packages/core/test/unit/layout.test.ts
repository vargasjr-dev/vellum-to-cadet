import { describe, expect, test } from "bun:test";

import {
  applySubstitutions,
  isRewriteEligible,
  renameRelativePath,
} from "../../src/fs-utils.js";

describe("layout: path renames", () => {
  test("renames every mapped dotfile segment", () => {
    expect(renameRelativePath(".vellum-assistant/version")).toBe(".cadetAssistant/version");
    expect(renameRelativePath(".vellum-skill-run/github-summary")).toBe(".cadet-skill-run/github-summary");
    expect(renameRelativePath("skills/.vellumBridge/x")).toBe("skills/.cadetBridge/x");
    expect(renameRelativePath(".vellum-mac-helper/run")).toBe(".cadet-mac-helper/run");
  });

  test("leaves normal files alone", () => {
    expect(renameRelativePath("workspace/notes/README.md")).toBe("workspace/notes/README.md");
  });

  test("longest names win over the bare root", () => {
    // `.vellum-assistant` must not become `.cadet` + `-assistant`.
    const renamed = renameRelativePath(".vellum-assistant");
    expect(renamed).toBe(".cadetAssistant");
  });
});

describe("layout: text substitutions", () => {
  test("env prefix, npm scope, and paths all rewrite", () => {
    const { text, counts } = applySubstitutions(
      'cmd: "VELLUM_HOOK_EVENT", pkg: "@vellumai/slack", root: "~/.vellum"',
    );
    expect(text).toBe('cmd: "CADET_HOOK_EVENT", pkg: "@mycadet/slack", root: "~/.cadet"');
    expect(counts["env-prefix"]).toBe(1);
    expect(counts["npm-scope"]).toBe(1);
    expect(counts["paths-and-dotfiles"]).toBe(1);
  });

  test("bare .vellum does not eat longer names", () => {
    const { text } = applySubstitutions("run .vellum-assistant now");
    expect(text).toBe("run .cadetAssistant now");
  });

  test("absolute home paths rewrite", () => {
    const { text } = applySubstitutions("binds /Users/someone/.vellum:/data");
    expect(text).toBe("binds /Users/someone/.cadet:/data");
  });
});

describe("layout: rewrite eligibility", () => {
  test("never rewrites the user workspace", () => {
    expect(isRewriteEligible("workspace/notes/README.md")).toBe(false);
    expect(isRewriteEligible("workspace/config.json")).toBe(false);
  });

  test("never rewrites protected keys", () => {
    expect(isRewriteEligible("protected/actor-token-signing-key")).toBe(false);
    expect(isRewriteEligible("protected/credential-executor/grants.json")).toBe(false);
  });

  test("rewrites machine-owned config and scripts", () => {
    expect(isRewriteEligible("config.json")).toBe(true);
    expect(isRewriteEligible("hooks/on-wake.sh")).toBe(true);
    expect(isRewriteEligible("skills/github-summary/SKILL.md")).toBe(true);
    expect(isRewriteEligible(".env")).toBe(true);
  });
});
