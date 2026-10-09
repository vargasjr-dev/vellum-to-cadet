import * as assert from "node:assert/strict";

/**
 * Minimal expect() shim over node:assert. The suite was ported from bun:test
 * (the repo runs on node now); keeping the matcher shape made that port
 * mechanical instead of a rewrite of every assertion. Extend it as tests
 * need more matchers.
 */
export function expect<T>(actual: T): Match<T> {
  return new Match(actual);
}

class Match<T> {
  constructor(
    private readonly actual: T,
    private readonly negated = false,
  ) {}

  private static of<T>(actual: T, negated: boolean): Match<T> {
    return new Match(actual, negated);
  }

  get not(): Match<T> {
    return Match.of(this.actual, !this.negated);
  }

  toBe(expected: unknown): void {
    if (this.negated) assert.notStrictEqual(this.actual, expected);
    else assert.strictEqual(this.actual, expected);
  }

  toEqual(expected: unknown): void {
    if (this.negated) assert.notDeepStrictEqual(plain(this.actual), plain(expected));
    else assert.deepStrictEqual(plain(this.actual), plain(expected));
  }

  toContain(expected: unknown): void {
    const haystack = this.actual as unknown;
    const includes =
      typeof haystack === "string"
        ? haystack.includes(expected as string)
        : Array.isArray(haystack) && (haystack as unknown[]).includes(expected);
    if (this.negated) {
      assert.ok(!includes, `expected ${stringify(haystack)} NOT to contain ${stringify(expected)}`);
    } else {
      assert.ok(includes, `expected ${stringify(haystack)} to contain ${stringify(expected)}`);
    }
  }

  toBeGreaterThan(expected: number): void {
    if (this.negated) {
      assert.ok(!((this.actual as number) > expected), `expected ${this.actual} NOT to be > ${expected}`);
    } else {
      assert.ok((this.actual as number) > expected, `expected ${this.actual} to be > ${expected}`);
    }
  }

  toHaveLength(expected: number): void {
    const len = (this.actual as { length?: number })?.length;
    if (this.negated) assert.notStrictEqual(len, expected);
    else assert.strictEqual(len, expected, `expected length ${expected}`);
  }

  toBeUndefined(): void {
    if (this.negated) assert.notStrictEqual(this.actual, undefined);
    else assert.strictEqual(this.actual, undefined, "expected undefined");
  }

  toBeDefined(): void {
    if (this.negated) assert.strictEqual(this.actual, undefined);
    else assert.notStrictEqual(this.actual, undefined, "expected a defined value");
  }

  toBeNull(): void {
    if (this.negated) assert.notStrictEqual(this.actual, null);
    else assert.strictEqual(this.actual, null, "expected null");
  }

  toBeTruthy(): void {
    if (this.negated) assert.ok(!this.actual, "expected falsy");
    else assert.ok(this.actual, "expected truthy");
  }
}

function stringify(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * node:sqlite returns rows with a null prototype; assert.deepStrictEqual is
 * prototype-sensitive, so rebuild values as ordinary objects/arrays before
 * comparing. The suite compares rows, strings, and numbers only.
 */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, plain(v)]),
    );
  }
  return value;
}
