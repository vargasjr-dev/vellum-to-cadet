import { describe, expect, test } from "bun:test";

import {
  applySubstitutions,
  isRewriteEligible,
  renameRelativePath,
} from "../../src/fs-utils.js";
import {
  isWorkspaceMachineFile,
  rewriteWorkspaceJsonValues,
} from "../../src/layout.js";

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
  test("never rewrites the user workspace — except named machine files", () => {
    expect(isRewriteEligible("workspace/notes/README.md")).toBe(false);
    expect(isRewriteEligible("workspace/skills/github-summary/SKILL.md")).toBe(false);
    // The gateway-facing config contract carries vellum provider ids.
    expect(isRewriteEligible("workspace/config.json")).toBe(true);
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
  test("isWorkspaceMachineFile matches the named contract files", () => {
    expect(isWorkspaceMachineFile("workspace/config.json")).toBe(true);
    expect(isWorkspaceMachineFile("workspace/skills/github-summary/install-meta.json")).toBe(true);
    expect(isWorkspaceMachineFile("workspace/plugins/greeter/index.ts")).toBe(true);
    expect(isWorkspaceMachineFile("workspace/plugins/greeter/package.json")).toBe(true);
  });

  test("isWorkspaceMachineFile never matches user content", () => {
    expect(isWorkspaceMachineFile("workspace/notes/README.md")).toBe(false);
    expect(isWorkspaceMachineFile("workspace/skills/github-summary/SKILL.md")).toBe(false);
    expect(isWorkspaceMachineFile("workspace/data/db/assistant.db")).toBe(false);
    expect(isWorkspaceMachineFile("config.json")).toBe(false);
  });

  test("eligibility is state-relative — modern instance layouts normalize first", () => {
    // The predicate takes state-relative paths; the plan/executor normalize
    // via stateRelativePath before asking.
    expect(isWorkspaceMachineFile("workspace/config.json")).toBe(true);
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
