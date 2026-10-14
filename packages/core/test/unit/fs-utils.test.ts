import { describe, test } from "node:test";

import {
  applySubstitutions,
  findLegacyTokens,
  formatBytes,
  formatProgress,
  isRewriteEligible,
  rewriteLegacyTokens,
  rewritePersonaPrompt,
  sanitizeCesCredentialMetadata,
  sanctionedContentTransform,
} from "../../src/fs-utils.js";
import {
  CADET_CLOUD_BASE_URL,
  consolidateDefaultProvider,
  DEFAULT_TARGET_CTX,
  isCesCredentialMetadata,
  isWorkspaceScript,
  normalizeCloudBaseUrl,
  renamePlatformConfigSection,
} from "../../src/layout.js";
import { expect } from "../helpers/expect.js";

describe("formatBytes", () => {
  test("converts to GB when applicable", () => {
    expect(formatBytes(10_800_600_000)).toBe("10.80GB");
    expect(formatBytes(1e9)).toBe("1.00GB");
  });

  test("keeps MB/KB/B below the GB threshold", () => {
    expect(formatBytes(999_999_999)).toBe("1000.0MB");
    expect(formatBytes(10800.6 * 1e6)).toBe("10.80GB");
    expect(formatBytes(512_400)).toBe("512.4KB");
    expect(formatBytes(512)).toBe("512B");
  });
});

describe("formatProgress", () => {
  test("renders bytes over total with a percentage", () => {
    expect(formatProgress(1.2e9, 4e9)).toBe("1.20GB/4.00GB (30%)");
    expect(formatProgress(5e8, 5e8)).toBe("500.0MB/500.0MB (100%)");
  });

  test("clamps at 100% (tar headers can push the count past the du estimate)", () => {
    expect(formatProgress(5e9, 4e9)).toBe("5.00GB/4.00GB (100%)");
  });

  test("falls back to bytes-so-far without a total (size pre-pass failed)", () => {
    expect(formatProgress(3e8)).toBe("300.0MB");
    expect(formatProgress(3e8, 0)).toBe("300.0MB");
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
    // workspace text files are sweep-eligible now (see the workspace env
    // sweep describe) — they are no longer "unmapped".
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

describe("workspace env sweep — the one rewrite user scripts may receive", () => {
  test("isWorkspaceScript claims assistant-authored text files", () => {
    expect(isWorkspaceScript("workspace/bin/vj")).toBe(true); // extensionless
    expect(isWorkspaceScript("workspace/lib/ledger.ts")).toBe(true);
    expect(isWorkspaceScript("workspace/schedules/clean-worktrees.sh")).toBe(true);
    expect(isWorkspaceScript("workspace/notes/vellum-history.md")).toBe(true);
    expect(isWorkspaceScript("workspace/.env.local")).toBe(true);
  });

  test("isWorkspaceScript skips non-user and non-text paths", () => {
    expect(isWorkspaceScript("workspace/config.json")).toBe(false); // contract file
    expect(isWorkspaceScript("workspace/skills/s/install-meta.json")).toBe(false);
    expect(isWorkspaceScript("workspace/plugins/p/index.ts")).toBe(false);
    expect(isWorkspaceScript("workspace/data/db/assistant.db")).toBe(false); // db
    expect(isWorkspaceScript("workspace/data/db/assistant.db-wal")).toBe(false);
    expect(isWorkspaceScript("workspace/.git/objects/pack")).toBe(false); // vendor dirs
    expect(isWorkspaceScript("workspace/node_modules/x/index.js")).toBe(false);
    expect(isWorkspaceScript("workspace/avatar.png")).toBe(false); // binary ext
    expect(isWorkspaceScript("bin/vj")).toBe(false); // outside the workspace
    expect(isWorkspaceScript("workspace/notes/photo.png")).toBe(false);
  });

  test("rewrites ONLY the workspace env token — other vars and prose stay", () => {
    const script = [
      "#!/usr/bin/env bun",
      "const dbPath = `${process.env.VELLUM_WORKSPACE_DIR}/data/db/vj.sqlite`;",
      "const port = Number(process.env.VELLUM_DAEMON_PORT || 8000);",
      "// vellum flavor prose stays vellum",
      "",
    ].join("\n");
    const out = sanctionedContentTransform("workspace/bin/vj", script);
    expect(out?.substep).toBe("workspace env sweep");
    expect(out?.text).toContain("process.env.CADET_WORKSPACE_DIR");
    expect(out?.text).not.toContain("VELLUM_WORKSPACE_DIR");
    expect(out?.text).toContain("process.env.VELLUM_DAEMON_PORT");
    expect(out?.text).toContain("vellum flavor prose stays vellum");
    expect(out?.counts).toEqual({ "workspace-env-sweep": 1 });
  });

  test("shell fallback syntax sweeps too", () => {
    const out = sanctionedContentTransform(
      "workspace/schedules/clean.sh",
      'WORKSPACE_DIR="${VELLUM_WORKSPACE_DIR:-/workspace}"\n',
    );
    expect(out?.text).toBe('WORKSPACE_DIR="${CADET_WORKSPACE_DIR:-/workspace}"\n');
  });

  test("a sweep-eligible file with no token is a no-op (stays byte-identical)", () => {
    const out = sanctionedContentTransform(
      "workspace/notes/vellum-history.md",
      "# History\n\nI used vellum before it was cadet. VELLUM_ROOT_DIR was a nice env var.\n",
    );
    expect(out?.substep).toBe("workspace env sweep");
    expect(out?.counts).toEqual({});
    expect(out?.text).toContain("VELLUM_ROOT_DIR was a nice env var");
  });
});

describe("CES credential metadata — legacy product-service placeholders dropped", () => {
  const meta = (services: string[]): string =>
    JSON.stringify({
      version: 5,
      credentials: services.map((service, i) => ({
        credentialId: `id-${i}`,
        service,
        field: "field",
        allowedTools: [],
        allowedDomains: [],
        createdAt: 1,
        updatedAt: 1,
      })),
    });

  test("drops vellum-service entries, keeps everything else", () => {
    const out = sanitizeCesCredentialMetadata(meta(["telegram", "vellum", "my-site.dev", "vellum"]));
    expect(out.removed).toBe(2);
    const parsed = JSON.parse(out.text) as { credentials: Array<{ service: string }> };
    expect(parsed.credentials.map((c) => c.service)).toEqual(["telegram", "my-site.dev"]);
  });

  test("is a no-op when nothing is vellum-branded (bytes untouched)", () => {
    const raw = meta(["telegram"]);
    expect(sanitizeCesCredentialMetadata(raw)).toEqual({ text: raw, removed: 0 });
  });

  test("unparseable or unexpected-shape files pass through untouched", () => {
    expect(sanitizeCesCredentialMetadata("not json {")).toEqual({
      text: "not json {",
      removed: 0,
    });
    expect(sanitizeCesCredentialMetadata('{"other": []}').removed).toBe(0);
  });

  test("isCesCredentialMetadata matches both known index locations", () => {
    expect(isCesCredentialMetadata("data/credentials/metadata.json")).toBe(true);
    expect(isCesCredentialMetadata("protected/credential-executor/metadata.json")).toBe(true);
    expect(isCesCredentialMetadata("data/credentials/other.json")).toBe(false);
  });

  test("the index opts out of verbatim protected/ handling", () => {
    expect(isRewriteEligible("protected/credential-executor/metadata.json")).toBe(true);
    expect(isRewriteEligible("protected/credential-executor/grants.json")).toBe(false);
    expect(isRewriteEligible("protected/keys.enc")).toBe(false);
  });
});

describe("cloud baseUrl — the product cloud, never the mangled garbage", () => {
  test("platform.vellum.ai lands as cloud.mycadet.ai through the section rename", () => {
    const out = renamePlatformConfigSection(
      JSON.stringify({ platform: { baseUrl: "https://platform.vellum.ai" } }),
    );
    const parsed = JSON.parse(out!) as { cloud?: { baseUrl?: string }; platform?: unknown };
    expect(parsed.cloud?.baseUrl).toBe(CADET_CLOUD_BASE_URL);
    expect(parsed.platform).toBeUndefined();
  });

  test("an existing cloud section with mangled vellum bytes normalizes in place", () => {
    const out = renamePlatformConfigSection(
      JSON.stringify({
        cloud: { baseUrl: "https://platform.local/share/cadet/assistants/vellum.ai", subdomain: "" },
      }),
    );
    const parsed = JSON.parse(out!) as { cloud: { baseUrl: string; subdomain: string } };
    expect(parsed.cloud.baseUrl).toBe(CADET_CLOUD_BASE_URL);
    expect(parsed.cloud.subdomain).toBe("");
  });

  test("a self-hosted non-vellum platform URL passes through untouched", () => {
    expect(
      renamePlatformConfigSection(JSON.stringify({ cloud: { baseUrl: "https://assistant.internal.corp" } })),
    ).toBeNull();
    expect(normalizeCloudBaseUrl("https://assistant.internal.corp")).toBe(
      "https://assistant.internal.corp",
    );
  });

  test("empty baseUrl normalizes to the product cloud", () => {
    expect(normalizeCloudBaseUrl("")).toBe(CADET_CLOUD_BASE_URL);
  });
});

describe("path substitutions never mangle URL hostnames", () => {
  test("platform.vellum.ai in prose/URLs survives applySubstitutions", () => {
    const { text } = applySubstitutions("docs at https://platform.vellum.ai/guide and api.vellum.ai\n");
    expect(text).toContain("https://platform.vellum.ai/guide");
    expect(text).not.toContain("platform.local");
  });

  test("real dotfile paths still rewrite", () => {
    const { text } = applySubstitutions("root=~/.vellum workspace=~/.vellum/workspace\n");
    expect(text).not.toContain(".vellum");
    expect(text).toContain(".local/share/cadet");
  });

  test("findLegacyTokens ignores preserved URL hosts but flags real leftovers", () => {
    expect(findLegacyTokens("docs at https://api.vellum.example/guide")).toEqual([]);
    expect(findLegacyTokens("root=~/.vellum")).toHaveLength(1);
    expect(findLegacyTokens("import from @vellumai/plugin-api")).toHaveLength(1);
  });
});
