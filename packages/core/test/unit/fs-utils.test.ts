import { describe, test } from "node:test";

import {
  applySubstitutions,
  formatBytes,
  rewriteLegacyTokens,
  rewritePersonaPrompt,
  sanctionedContentTransform,
} from "../../src/fs-utils.js";
import {
  consolidateDefaultProvider,
  DEFAULT_TARGET_CTX,
  renamePlatformConfigSection,
} from "../../src/layout.js";
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

describe("consolidateDefaultProvider — the blob is the one selection key", () => {
  const config = (llm: Record<string, unknown>): string =>
    JSON.stringify({ llm, services: {} }, null, 2) + "\n";

  test("a valid retired key stamps the blob and is deleted", () => {
    const out = consolidateDefaultProvider(
      config({
        defaultProvider: { provider: "anthropic", connectionName: "anthropic-personal" },
        default: { provider: "together", model: "x" },
      }),
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.llm.defaultProvider).toBeUndefined();
    expect(parsed.llm.default).toEqual({
      provider: "anthropic",
      provider_connection: "anthropic-personal",
      model: "x",
    });
  });

  test("key-only installs get a blob", () => {
    const out = consolidateDefaultProvider(
      config({ defaultProvider: { provider: "openai" } }),
    );
    expect(JSON.parse(out!).llm.default).toEqual({ provider: "openai" });
  });

  test("no explicit pin + provider change drops the old provider's pin", () => {
    const out = consolidateDefaultProvider(
      config({
        defaultProvider: { provider: "openai" },
        default: { provider: "anthropic", provider_connection: "anthropic-personal" },
      }),
    );
    expect(JSON.parse(out!).llm.default).toEqual({ provider: "openai" });
  });

  test("no explicit pin + unchanged provider keeps the pin", () => {
    const out = consolidateDefaultProvider(
      config({
        defaultProvider: { provider: "openai" },
        default: { provider: "openai", provider_connection: "work-openai" },
      }),
    );
    expect(JSON.parse(out!).llm.default).toEqual({
      provider: "openai",
      provider_connection: "work-openai",
    });
  });

  test("a key with no usable provider is left alone", () => {
    const raw = config({ defaultProvider: { connectionName: "x" } });
    expect(consolidateDefaultProvider(raw)).toBeNull();
    expect(consolidateDefaultProvider(config({}))).toBeNull();
    expect(consolidateDefaultProvider("not json {{{")).toBeNull();
  });

  test("is idempotent — the consolidated config maps to itself", () => {
    const once = consolidateDefaultProvider(
      config({
        defaultProvider: { provider: "openai", connectionName: "work-openai" },
        default: { provider: "together" },
      }),
    )!;
    expect(consolidateDefaultProvider(once)).toBeNull();
  });

  test("the config.json rewrite substep reports the consolidation", () => {
    const out = sanctionedContentTransform(
      "workspace/config.json",
      config({ defaultProvider: { provider: "openai" } }),
    );
    expect(out?.counts["default-provider consolidation"]).toBe(1);
  });
});

describe("renamePlatformConfigSection — the config section key", () => {
  const config = (extra: Record<string, unknown>): string =>
    JSON.stringify(
      { llm: {}, twilio: {}, ...extra },
      null,
      2,
    ) + "\n";

  test("renames the top-level platform section, preserving order and contents", () => {
    const out = renamePlatformConfigSection(
      config({
        platform: { baseUrl: "https://cloud.mycadet.ai", subdomain: "apollobot" },
      }),
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.platform).toBeUndefined();
    expect(parsed.cloud).toEqual({
      baseUrl: "https://cloud.mycadet.ai",
      subdomain: "apollobot",
    });
    // cloud lands where platform was — key order is preserved.
    expect(Object.keys(parsed)).toEqual(["llm", "twilio", "cloud"]);
  });

  test("is idempotent — the renamed config maps to itself", () => {
    const once = renamePlatformConfigSection(
      config({ platform: { subdomain: "apollobot" } }),
    )!;
    expect(renamePlatformConfigSection(once)).toBeNull();
  });

  test("an existing cloud section wins — platform is dropped", () => {
    const out = renamePlatformConfigSection(
      config({
        cloud: { baseUrl: "https://new.example.com" },
        platform: { baseUrl: "https://old.example.com" },
      }),
    );
    expect(JSON.parse(out!).cloud).toEqual({ baseUrl: "https://new.example.com" });
  });

  test("nested platform keys elsewhere are untouched", () => {
    const out = renamePlatformConfigSection(
      config({
        platform: { subdomain: "apollobot" },
        services: { platform: { enabled: true } },
      }),
    );
    const parsed = JSON.parse(out!);
    expect(parsed.cloud).toEqual({ subdomain: "apollobot" });
    expect(parsed.services.platform).toEqual({ enabled: true });
  });

  test("nothing to do returns null", () => {
    expect(renamePlatformConfigSection(config({}))).toBeNull();
    expect(renamePlatformConfigSection("not json {{{")).toBeNull();
    expect(renamePlatformConfigSection('["array"]')).toBeNull();
    expect(renamePlatformConfigSection("null")).toBeNull();
    expect(renamePlatformConfigSection("42")).toBeNull();
  });

  test("the config.json rewrite substep reports the rename", () => {
    const out = sanctionedContentTransform(
      "workspace/config.json",
      config({ platform: { subdomain: "apollobot" } }),
    );
    expect(out?.counts["platform-section-key"]).toBe(1);
    expect(JSON.parse(out!.text).cloud).toEqual({ subdomain: "apollobot" });
  });

  test("non-config files never see the section rename", () => {
    const out = sanctionedContentTransform(
      "workspace/conversations/x/messages.jsonl",
      '{"platform": {"subdomain": "x"}}',
    );
    expect(out?.counts["platform-section-key"]).toBeUndefined();
  });
});
