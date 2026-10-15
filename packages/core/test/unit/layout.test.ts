import { describe, test } from "node:test";

import {
  applySubstitutions,
  isRewriteEligible,
  renameRelativePath,
} from "../../src/fs-utils.js";
import {
  CADET_PROCESS_PATTERNS,
  cutOverManagedSpeechProviders,
  isConversationLog,
  isPersonaPrompt,
  isPluginSource,
  isRuntimeLog,
  isSkillFrontmatter,
  isSkillInstallMeta,
  isWorkspaceConfigContract,
  rewriteSkillFrontmatter,
  rewriteWorkspaceJsonValues,
} from "../../src/layout.js";
import { expect } from "../helpers/expect.js";

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

describe("layout: gateway-state relocations", () => {
  test("the state-root gateway DB relocates into gateway-security", () => {
    expect(renameRelativePath("data/gateway.sqlite")).toBe("gateway-security/gateway.sqlite");
    expect(renameRelativePath("data/gateway.sqlite-wal")).toBe("gateway-security/gateway.sqlite-wal");
    expect(renameRelativePath("data/gateway.sqlite-shm")).toBe("gateway-security/gateway.sqlite-shm");
  });

  test("root-level guardian-init locks relocate", () => {
    expect(renameRelativePath("guardian-init.lock")).toBe("gateway-security/guardian-init.lock");
    expect(renameRelativePath("guardian-init-consumed.json")).toBe("gateway-security/guardian-init-consumed.json");
  });

  test("relocations match the modern per-instance form too", () => {
    expect(renameRelativePath("assistants/velly/.vellum/data/gateway.sqlite")).toBe(
      "assistants/velly/gateway-security/gateway.sqlite",
    );
    expect(renameRelativePath("assistants/velly/.vellum/guardian-init.lock")).toBe(
      "assistants/velly/gateway-security/guardian-init.lock",
    );
  });

  test("the workspace data dir is NOT relocated (assistant DBs stay there)", () => {
    expect(renameRelativePath("workspace/data/db/assistant.db")).toBe("workspace/data/db/assistant.db");
  });
});

describe("layout: text substitutions", () => {
  test("env prefix, npm scope, and paths all rewrite", () => {
    const { text, counts } = applySubstitutions(
      'cmd: "VELLUM_HOOK_EVENT", pkg: "@vellumai/slack", root: "~/.vellum"',
    );
    expect(text).toBe(
      'cmd: "CADET_HOOK_EVENT", pkg: "@mycadet/slack", root: "~/.local/share/cadet/assistants/vellum"',
    );
    expect(counts["env-prefix"]).toBe(1);
    expect(counts["npm-scope"]).toBe(1);
    expect(counts["paths-and-dotfiles"]).toBe(1);
  });

  test("bare .vellum does not eat longer names", () => {
    const { text } = applySubstitutions("run .vellum-assistant now");
    expect(text).toBe("run .cadetAssistant now");
  });

  test("security-dir env values split per variable", () => {
    const { text, counts } = applySubstitutions(
      [
        "export GATEWAY_SECURITY_DIR=~/.local/share/cadet/protected",
        'CREDENTIAL_SECURITY_DIR="/home/u/.local/share/cadet/protected"',
        "UNRELATED_DIR=/x/protected",
      ].join("\n"),
    );
    expect(text).toContain("GATEWAY_SECURITY_DIR=~/.local/share/cadet/gateway-security");
    expect(text).toContain('CREDENTIAL_SECURITY_DIR="/home/u/.local/share/cadet/ces-security"');
    // Unrelated vars keep their paths — the split only follows the
    // security-dir variables.
    expect(text).toContain("UNRELATED_DIR=/x/protected");
    expect(counts["protected-layout"]).toBe(2);
  });

  test("the CES data-root env value maps to ces-data", () => {
    const { text } = applySubstitutions(
      'export CES_BOOTSTRAP_SOCKET_DIR="/home/u/.local/share/cadet/protected/credential-executor"',
    );
    // The value tail is the CES local data root (where the bootstrap socket
    // lived) under the old combined dir.
    expect(text).toBe(
      'export CES_BOOTSTRAP_SOCKET_DIR="/home/u/.local/share/cadet/ces-data"',
    );
  });

  test("absolute home paths rewrite to the legacy instance dir", () => {
    const { text } = applySubstitutions("binds /Users/someone/.vellum:/data");
    expect(text).toBe("binds /Users/someone/.local/share/cadet/assistants/vellum:/data");
  });

  test("legacy env-suffixed roots become env-scoped instances", () => {
    const { text } = applySubstitutions("root=/home/x/.vellum-staging/workspace");
    expect(text).toBe("root=/home/x/.local/share/cadet-staging/assistants/vellum/workspace");
  });

  test("legacy lockfile names keep their pre-XDG cadet spellings", () => {
    const { text } = applySubstitutions("lock=/home/x/.vellum.lock.json and /home/x/.vellum.lockfile.json");
    expect(text).toBe("lock=/home/x/.cadet.lock.json and /home/x/.cadet.lockfile.json");
  });
});

describe("layout: rewrite eligibility", () => {
  test("never rewrites the user workspace — except named machine files + the env sweep", () => {
    // Workspace text files ARE rewrite-eligible now — but only for the
    // single-token VELLUM_WORKSPACE_DIR sweep (see fs-utils dispatch). A
    // file without the token is a byte-for-byte no-op.
    expect(isRewriteEligible("workspace/notes/README.md")).toBe(true);
    // The frontmatter metadata block is a machine contract (its own substep);
    // the notes file is user content.
    expect(isRewriteEligible("workspace/skills/github-summary/SKILL.md")).toBe(true);
    // The gateway-facing config contract carries vellum provider ids.
    expect(isRewriteEligible("workspace/config.json")).toBe(true);
    // Dbs, vendor dirs, and binaries stay verbatim.
    expect(isRewriteEligible("workspace/data/db/assistant.db")).toBe(false);
    expect(isRewriteEligible("workspace/node_modules/x/index.js")).toBe(false);
    expect(isRewriteEligible("workspace/avatar.png")).toBe(false);
  });

  test("never rewrites protected keys", () => {
    expect(isRewriteEligible("protected/actor-token-signing-key")).toBe(false);
    expect(isRewriteEligible("protected/credential-executor/grants.json")).toBe(false);
    // The dissolved destinations stay verbatim too.
    expect(isRewriteEligible("gateway-security/actor-token-signing-key")).toBe(false);
    expect(isRewriteEligible("ces-security/keys.enc")).toBe(false);
  });

  describe("layout: protected dir dissolves per service", () => {
    test("gateway material lands in gateway-security", () => {
      expect(renameRelativePath("protected/actor-token-signing-key")).toBe(
        "gateway-security/actor-token-signing-key",
      );
      expect(renameRelativePath("protected/trust.json")).toBe(
        "gateway-security/trust.json",
      );
    });

    test("the CES store lands in ces-security", () => {
      expect(renameRelativePath("protected/keys.enc")).toBe("ces-security/keys.enc");
      expect(renameRelativePath("protected/store.key")).toBe("ces-security/store.key");
    });

    test("the CES local data root lands in ces-data", () => {
      expect(renameRelativePath("protected/credential-executor/grants.json")).toBe(
        "ces-data/grants.json",
      );
    });

    test("assistant sync state lands in platform-sync", () => {
      expect(renameRelativePath("protected/platform-sync/avatar.json")).toBe(
        "platform-sync/avatar.json",
      );
    });

    test("non-protected paths pass through untouched", () => {
      expect(renameRelativePath("workspace/notes/README.md")).toBe(
        "workspace/notes/README.md",
      );
    });
  });

  test("rewrites machine-owned config and scripts", () => {
    expect(isRewriteEligible("config.json")).toBe(true);
    expect(isRewriteEligible("hooks/on-wake.sh")).toBe(true);
    expect(isRewriteEligible("skills/github-summary/SKILL.md")).toBe(true);
    expect(isRewriteEligible(".env")).toBe(true);
  });
});

describe("layout: modern instance-state paths", () => {
  test("absolute state paths dissolve the .vellum level and rename the root", () => {
    const { text, counts } = applySubstitutions(
      "dir: ~/.local/share/vellum/assistants/velly/.vellum/workspace/data",
    );
    expect(text).toBe("dir: ~/.local/share/cadet/assistants/velly/workspace/data");
    expect(counts["instance-state-paths"]).toBe(1);
    expect(counts["xdg-root-paths"]).toBe(1);
  });

  test("env-suffixed roots keep their suffix", () => {
    const { text } = applySubstitutions(
      "dir: /home/u/.local/share/vellum-dev/assistants/velly/.vellum/workspace",
    );
    expect(text).toBe("dir: /home/u/.local/share/cadet-dev/assistants/velly/workspace");
  });

  test("relative state paths dissolve too", () => {
    const { text } = applySubstitutions(
      'log: "assistants/velly/.vellum/workspace/data/logs"',
    );
    expect(text).toBe('log: "assistants/velly/workspace/data/logs"');
  });

  test("prose mentioning vellum is untouched", () => {
    const { text } = applySubstitutions("I used vellum before it was cadet");
    expect(text).toBe("I used vellum before it was cadet");
  });
});

describe("layout: workspace machine files", () => {
  test("each explicit target matches its own named case", () => {
    expect(isWorkspaceConfigContract("workspace/config.json")).toBe(true);
    expect(isSkillInstallMeta("workspace/skills/github-summary/install-meta.json")).toBe(true);
    expect(isPluginSource("workspace/plugins/greeter/index.ts")).toBe(true);
    expect(isPluginSource("workspace/plugins/greeter/package.json")).toBe(true);
  });

  test("the explicit targets never match user content", () => {
    for (const check of [isWorkspaceConfigContract, isSkillInstallMeta, isPluginSource]) {
      expect(check("workspace/notes/README.md")).toBe(false);
      expect(check("workspace/skills/github-summary/SKILL.md")).toBe(false);
      expect(check("config.json")).toBe(false);
    }
    expect(isWorkspaceConfigContract("workspace/skills/x/install-meta.json")).toBe(false);
    expect(isSkillInstallMeta("workspace/plugins/greeter/index.ts")).toBe(false);
    // DB values are the assistant-db step's job, not a text rewrite.
    expect(isPluginSource("workspace/data/db/assistant.db")).toBe(false);
    expect(isRewriteEligible("workspace/data/db/assistant.db")).toBe(false);
  });

  test("rewriteWorkspaceJsonValues rewrites exact vellum values", () => {
    const { text, changed } = rewriteWorkspaceJsonValues(
      JSON.stringify({
        profiles: [{ provider: "vellum" }, { provider: "anthropic" }],
        services: { tts: { provider: "vellum" } },
        url: "https://api.vellum.ai",
        note: "vellum was great",
      }),
    );
    expect(changed).toBe(2);
    const parsed = JSON.parse(text);
    expect(parsed.profiles[0].provider).toBe("cadet");
    expect(parsed.profiles[1].provider).toBe("anthropic");
    expect(parsed.services.tts.provider).toBe("cadet");
    // Containing values (URLs, prose) stay untouched.
    expect(parsed.url).toBe("https://api.vellum.ai");
    expect(parsed.note).toBe("vellum was great");
  });

  test("rewriteWorkspaceJsonValues leaves malformed JSON alone", () => {
    expect(rewriteWorkspaceJsonValues("not json")).toEqual({ text: "not json", changed: 0 });
  });

  test("rewriteWorkspaceJsonValues is a no-op when nothing matches", () => {
    const raw = JSON.stringify({ provider: "anthropic" }, null, 2);
    expect(rewriteWorkspaceJsonValues(raw)).toEqual({ text: raw, changed: 0 });
  });
});

describe("layout: managed speech provider cutover", () => {
  test("cuts vellum-era managed speech over to deepgram/elevenlabs and drops the dead blocks", () => {
    const result = cutOverManagedSpeechProviders(
      JSON.stringify({
        services: {
          stt: { provider: "vellum", language: "multi", providers: { vellum: {} } },
          tts: {
            provider: "vellum",
            providers: { elevenlabs: { voiceId: "x" }, vellum: { model: "old-voice" } },
          },
        },
      }),
    );
    expect(result).not.toBe(null);
    const parsed = JSON.parse(result!.text);
    expect(parsed.services.stt.provider).toBe("deepgram");
    expect(parsed.services.tts.provider).toBe("elevenlabs");
    // The managed provider's settings blocks are meaningless post-cutover.
    expect(parsed.services.stt.providers.vellum).toBeUndefined();
    expect(parsed.services.tts.providers.vellum).toBeUndefined();
    // Real providers' blocks ride untouched.
    expect(parsed.services.tts.providers.elevenlabs).toEqual({ voiceId: "x" });
    // stt provider + tts provider + the two dead blocks.
    expect(result!.changes).toBe(4);
  });

  test("accepts the renamed spelling — roots migrated by older migrator releases", () => {
    // The generic token sweep rewrites the ids textually before the JSON
    // passes run, and an already-migrated root carries "cadet".
    const result = cutOverManagedSpeechProviders(
      JSON.stringify({
        services: {
          stt: { provider: "cadet", roles: { live: { provider: "cadet" } } },
          tts: { provider: "cadet", providers: { cadet: {} } },
        },
      }),
    );
    expect(result).not.toBe(null);
    const parsed = JSON.parse(result!.text);
    expect(parsed.services.stt.provider).toBe("deepgram");
    expect(parsed.services.stt.roles.live.provider).toBe("deepgram");
    expect(parsed.services.tts.provider).toBe("elevenlabs");
    expect(parsed.services.tts.providers.cadet).toBeUndefined();
  });

  test("is idempotent — a cut-over config has nothing left to do", () => {
    const raw = JSON.stringify({
      services: { stt: { provider: "deepgram" }, tts: { provider: "elevenlabs" } },
    });
    expect(cutOverManagedSpeechProviders(raw)).toBe(null);
  });

  test("leaves configs without managed speech (or a services block) alone", () => {
    expect(cutOverManagedSpeechProviders("not json")).toBe(null);
    expect(cutOverManagedSpeechProviders('{"llm": {}}')).toBe(null);
    expect(
      cutOverManagedSpeechProviders(
        JSON.stringify({ services: { stt: { provider: "openai-whisper" } } }),
      ),
    ).toBe(null);
  });
});

describe("layout: skill frontmatter rewrites", () => {
  const FRONTMATTER = [
    "---",
    "name: github-summary",
    "description: Summarize commits",
    "metadata:",
    '  emoji: "octopus"',
    "  vellum:",
    '    display-name: GitHub Summary',
    "    category: productivity",
    "---",
    "",
    "# GitHub summary",
    "",
    "From the vellum catalog.",
    "",
  ].join("\n");

  test("flips the metadata.vellum key to cadet, leaving everything else", () => {
    const { text, changed } = rewriteSkillFrontmatter(FRONTMATTER);
    expect(changed).toBe(1);
    expect(text).toContain("  cadet:\n    display-name: GitHub Summary");
    expect(text).not.toContain("  vellum:");
    // Prose below the frontmatter is untouched.
    expect(text).toContain("From the vellum catalog.");
    // Other frontmatter keys keep their values verbatim.
    expect(text).toContain('  emoji: "octopus"');
    expect(text).toContain("name: github-summary");
  });

  test("isSkillFrontmatter matches workspace skills only", () => {
    // State-relative input — the executor normalizes via stateRelativePath
    // first (modern instance layouts dissolve to this shape).
    expect(isSkillFrontmatter("workspace/skills/github-summary/SKILL.md")).toBe(true);
    expect(isSkillFrontmatter("skills/github-summary/SKILL.md")).toBe(false); // state-root skills: generic substitutions
    expect(isSkillFrontmatter("workspace/skills/github-summary/install-meta.json")).toBe(false);
    expect(isSkillFrontmatter("workspace/notes/SKILL.md")).toBe(false);
  });

  test("a SKILL.md without frontmatter passes through unchanged", () => {
    const raw = "# Just prose\n\nmentions vellum freely\n";
    expect(rewriteSkillFrontmatter(raw)).toEqual({ text: raw, changed: 0 });
  });

  test("frontmatter without a metadata.vellum key is a no-op", () => {
    const raw = "---\nname: x\ndescription: y\nmetadata:\n  emoji: \"a\"\n---\n\nbody\n";
    expect(rewriteSkillFrontmatter(raw)).toEqual({ text: raw, changed: 0 });
  });

  test("a nested vellum key under a non-metadata top-level key is untouched", () => {
    const raw = "---\nname: x\nsomething:\n  vellum:\n    deep: 1\nmetadata:\n  cadet:\n    category: t\n---\n";
    const { text, changed } = rewriteSkillFrontmatter(raw);
    expect(changed).toBe(0);
    expect(text).toBe(raw);
  });
});

describe("layout: workspace content categories", () => {
  test("conversation logs live under workspace/conversations", () => {
    expect(isConversationLog("workspace/conversations/2026-10-01/x/messages.jsonl")).toBe(true);
    expect(isConversationLog("workspace/conversations/2026-10-01/x/.tool-results/abc.txt")).toBe(true);
    expect(isConversationLog("workspace/conversations")).toBe(false);
    expect(isConversationLog("workspace/data/logs/assistant-2026-10-09.log")).toBe(false);
  });

  test("runtime logs live under workspace/data/logs", () => {
    expect(isRuntimeLog("workspace/data/logs/assistant-2026-10-09.log")).toBe(true);
    expect(isRuntimeLog("workspace/data/logs/vellum.log")).toBe(true);
    expect(isRuntimeLog("workspace/data/db/assistant.db")).toBe(false);
    expect(isRuntimeLog("data/logs/assistant-2026-10-09.log")).toBe(false);
  });

  test("persona prompts are the known workspace-root prompt files only", () => {
    expect(isPersonaPrompt("workspace/SOUL.md")).toBe(true);
    expect(isPersonaPrompt("workspace/IDENTITY.md")).toBe(true);
    expect(isPersonaPrompt("workspace/notes/vellum-history.md")).toBe(false);
    expect(isPersonaPrompt("workspace/SOUL.md.bak")).toBe(false);
    expect(isPersonaPrompt("SOUL.md")).toBe(false);
  });

  test("cadet process patterns mirror the vellum component set", () => {
    expect(CADET_PROCESS_PATTERNS).toContain("cadet-assistant");
    expect(CADET_PROCESS_PATTERNS).toContain("cadet-gateway");
    expect(CADET_PROCESS_PATTERNS).toContain("credential-executor");
    expect(CADET_PROCESS_PATTERNS).not.toContain("vellum-daemon");
  });
});
