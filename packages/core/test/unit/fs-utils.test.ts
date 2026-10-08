import { describe, expect, test } from "bun:test";

import { applySubstitutions, formatBytes } from "../../src/fs-utils.js";
import { DEFAULT_TARGET_CTX } from "../../src/layout.js";

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
