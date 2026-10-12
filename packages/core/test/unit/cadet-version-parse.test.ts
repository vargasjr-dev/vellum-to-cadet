import { describe, test } from "node:test";

import { parseCadetVersion } from "../../src/process.js";
import { expect } from "../helpers/expect.js";

describe("parseCadetVersion", () => {
  test("parses the scoped-package form the cadet CLI prints", () => {
    // Field QA: `cadet --version` prints "@mycadet/cli v0.12.9" — the old
    // parser stripped only a leading "cadet " and called the version
    // unavailable on a working cadet.
    expect(parseCadetVersion("@mycadet/cli v0.12.9\n")).toEqual({ version: "0.12.9" });
  });

  test("parses the older shapes the same way", () => {
    expect(parseCadetVersion("cadet 0.12.7\n")).toEqual({ version: "0.12.7" });
    expect(parseCadetVersion("0.12.7\n")).toEqual({ version: "0.12.7" });
    expect(parseCadetVersion("v0.12.7\n")).toEqual({ version: "0.12.7" });
  });

  test("a non-version answer yields null with the verbatim line", () => {
    const result = parseCadetVersion("some unrelated binary\n");
    expect(result.version).toBe(null);
    expect(result.detail).toContain("some unrelated binary");
  });

  test("empty output yields null with a detail", () => {
    const result = parseCadetVersion("");
    expect(result.version).toBe(null);
    expect(result.detail).toBeTruthy();
  });
});
