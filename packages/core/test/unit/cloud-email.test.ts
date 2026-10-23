import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname, userInfo } from "node:os";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { readCesStore } from "../../src/ces-keys.js";
import {
  cloudEmailFindings,
  detectCloudEmailStep,
  provisionCloudDomainsStep,
  type CloudEmailFetcher,
} from "../../src/steps/cloud-email.js";
import { expect } from "../helpers/expect.js";

// ── test-side seal helpers (the migrator only ever decrypts) ──

function seal(value: string, key: Buffer): { iv: string; tag: string; data: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}

/** Replicates the vellum store's v1 entropy recipe — pins the wire contract. */
function v1TestKey(saltHex: string): Buffer {
  const parts: string[] = [];
  try {
    parts.push(hostname());
  } catch {
    parts.push("unknown-host");
  }
  try {
    parts.push(userInfo().username);
  } catch {
    parts.push("unknown-user");
  }
  parts.push(process.platform);
  parts.push(process.arch);
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return pbkdf2Sync(parts.join(":"), Buffer.from(saltHex, "hex"), 100_000, 32, "sha512");
}

async function writeV2Store(dir: string, entries: Record<string, string>): Promise<void> {
  const key = randomBytes(32);
  const sealed: Record<string, { iv: string; tag: string; data: string }> = {};
  for (const [name, value] of Object.entries(entries)) sealed[name] = seal(value, key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "keys.enc"), JSON.stringify({ version: 2, entries: sealed }));
  await fs.writeFile(path.join(dir, "store.key"), key);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function recordingFetcher(
  responder: (url: string, init?: RequestInit) => Response,
): { fetcher: CloudEmailFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher: CloudEmailFetcher = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetcher, calls };
}

// ── env sandboxing (the provision step reads XDG_CONFIG_HOME + CADET_CLOUD_URL) ──

const SAVED_ENV = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ["XDG_CONFIG_HOME", "CADET_CLOUD_URL"]) {
    SAVED_ENV.set(name, process.env[name]);
  }
});

afterEach(() => {
  for (const [name, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  SAVED_ENV.clear();
});

const API_KEY_ENTRY = "credential/vellum/assistant_api_key";
const BASE_URL_ENTRY = "credential/vellum/platform_base_url";

describe("readCesStore (the offline CES decrypt)", () => {
  test("decrypts a v2 store keyed by its sibling store.key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-ces-v2-"));
    await writeV2Store(dir, {
      [API_KEY_ENTRY]: "vak_live_key",
      [BASE_URL_ENTRY]: "https://platform.vellum.ai",
      "credential/vellum/webhook_secret": "whsec",
    });

    const store = await readCesStore(dir);
    expect("entries" in store).toBe(true);
    if (!("entries" in store)) return;
    expect(store.entries[API_KEY_ENTRY]).toBe("vak_live_key");
    expect(store.entries[BASE_URL_ENTRY]).toBe("https://platform.vellum.ai");
    expect(store.entries["credential/vellum/webhook_secret"]).toBe("whsec");
  });

  test("decrypts a legacy v1 store via the machine-entropy PBKDF2 recipe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-ces-v1-"));
    const salt = randomBytes(16).toString("hex");
    const key = v1TestKey(salt);
    await fs.writeFile(
      path.join(dir, "keys.enc"),
      JSON.stringify({ version: 1, salt, entries: { [API_KEY_ENTRY]: seal("vak_legacy", key) } }),
    );

    const store = await readCesStore(dir);
    expect("entries" in store).toBe(true);
    if (!("entries" in store)) return;
    expect(store.entries[API_KEY_ENTRY]).toBe("vak_legacy");
  });

  test("a missing store.key refuses honestly instead of decrypting garbage", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-ces-nokey-"));
    const key = randomBytes(32);
    await fs.writeFile(
      path.join(dir, "keys.enc"),
      JSON.stringify({ version: 2, entries: { [API_KEY_ENTRY]: seal("x", key) } }),
    );

    const store = await readCesStore(dir);
    expect("error" in store).toBe(true);
    if (!("error" in store)) return;
    expect(store.error).toContain("store.key");
  });
});

function detectResponder(url: string): Response {
  if (url === "https://platform.vellum.ai/v1/internal/assistants/validate/") {
    return jsonResponse({ assistant_id: "assistant-uuid-1", organization_id: "org", user_id: "user" });
  }
  if (url === "https://platform.vellum.ai/v1/assistants/assistant-uuid-1/domains/") {
    return jsonResponse({
      count: 1,
      results: [{ id: "dom-1", domain: "prime.vellum.me", subdomain: "prime" }],
    });
  }
  if (url === "https://platform.vellum.ai/v1/assistants/assistant-uuid-1/email-addresses/") {
    return jsonResponse({ count: 1, results: [{ id: "em-1", address: "hello@prime.vellum.me" }] });
  }
  return jsonResponse({ detail: "not found" }, 404);
}

describe("detect-cloud-email (offline detection, no vellum daemon)", () => {
  test("decrypts the CES store, validates the key, and reads the domain + email address", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-detect-"));
    await writeV2Store(path.join(root, "assistants/prime/ces-security"), {
      [API_KEY_ENTRY]: "vak_live_key",
    });
    const { fetcher, calls } = recordingFetcher(detectResponder);

    const result = await detectCloudEmailStep({ roots: [root], fetcher });

    expect(result.status).toBe("completed");
    expect(result.data?.["detected"]).toBe(true);
    expect(cloudEmailFindings(result)).toEqual([
      {
        assistantId: "assistant-uuid-1",
        domain: "prime.vellum.me",
        subdomain: "prime",
        emailAddress: "hello@prime.vellum.me",
      },
    ]);
    // The vellum contract, verbatim: Api-Key auth on the validate call.
    expect(calls.length).toBe(3);
    expect(calls[0]?.url).toBe("https://platform.vellum.ai/v1/internal/assistants/validate/");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Api-Key vak_live_key");
    expect(result.summary).toContain("prime.vellum.me");
  });

  test("a re-run detects from the untouched vellum root after the working copy was scrubbed", async () => {
    const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-detect-work-"));
    const vellumRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-detect-vellum-"));
    await writeV2Store(path.join(vellumRoot, "protected"), { [API_KEY_ENTRY]: "vak_live_key" });
    const { fetcher, calls } = recordingFetcher(detectResponder);

    const result = await detectCloudEmailStep({ roots: [workingRoot], vellumRoot, fetcher });

    expect(result.status).toBe("completed");
    expect(cloudEmailFindings(result)).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/internal/assistants/validate/");
  });

  test("no keys.enc anywhere is a quiet skip", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-detect-empty-"));
    const { fetcher, calls } = recordingFetcher(detectResponder);

    const result = await detectCloudEmailStep({ roots: [root], fetcher });

    expect(result.status).toBe("skipped");
    expect(result.data?.["detected"]).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an unreadable store warns and does not fail the run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-detect-corrupt-"));
    await fs.mkdir(path.join(root, "ces-security"), { recursive: true });
    await fs.writeFile(path.join(root, "ces-security/keys.enc"), "not json");
    const { fetcher, calls } = recordingFetcher(detectResponder);

    const result = await detectCloudEmailStep({ roots: [root], fetcher });

    expect(result.status).toBe("skipped");
    expect(result.issues?.some((i) => i.severity === "warning")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("an unreachable platform warns — the migration still carries on", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-detect-down-"));
    await writeV2Store(path.join(root, "ces-security"), { [API_KEY_ENTRY]: "vak_live_key" });
    const fetcher: CloudEmailFetcher = async () => {
      throw new Error("network down");
    };

    const result = await detectCloudEmailStep({ roots: [root], fetcher });

    expect(result.status).toBe("skipped");
    expect(result.data?.["detected"]).toBe(false);
    expect(
      result.issues?.some((i) => i.severity === "warning" && i.message.includes("could not be reached")),
    ).toBe(true);
  });
});

describe("provision-cloud-domains (only after a cadet account exists)", () => {
  function provisionResponder(url: string, init?: RequestInit): Response {
    if (url === "https://test-cloud.mycadet.ai/v1/assistants") {
      return jsonResponse({ results: [{ id: "cloud-asst-1", name: "prime", status: "active" }] });
    }
    if (url === "https://test-cloud.mycadet.ai/v1/assistants/cloud-asst-1/domains/") {
      void init;
      return jsonResponse({ subdomain: "prime", email_address: "hello@prime.mycadet.ai" }, 201);
    }
    return jsonResponse({ detail: "not found" }, 404);
  }

  async function seedToken(configHome: string): Promise<void> {
    await fs.mkdir(path.join(configHome, "cadet"), { recursive: true });
    await fs.writeFile(path.join(configHome, "cadet", "cloud-token"), "sess_token_123\n");
  }

  test("no token file (no cadet account) reports pending instead of failing", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-prov-xdg-"));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
    const { fetcher, calls } = recordingFetcher(provisionResponder);

    const result = await provisionCloudDomainsStep({
      findings: [{ assistantId: "a", domain: "prime.vellum.me", subdomain: "prime", emailAddress: null }],
      envSuffix: "",
      fetcher,
    });

    expect(result.status).toBe("skipped");
    expect(result.data?.["pending"]).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("registers the detected subdomain + email username on the matched cloud assistant", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-prov-xdg-"));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
    await seedToken(configHome);
    const { fetcher, calls } = recordingFetcher(provisionResponder);

    const result = await provisionCloudDomainsStep({
      findings: [
        {
          assistantId: "assistant-uuid-1",
          domain: "prime.vellum.me",
          subdomain: "prime",
          emailAddress: "hello@prime.vellum.me",
        },
      ],
      envSuffix: "",
      fetcher,
    });

    expect(result.status).toBe("completed");
    expect(result.data?.["provisioned"]).toBe(1);
    expect(result.data?.["pending"]).toBe(false);
    const post = calls[1];
    expect(post?.url).toBe("https://test-cloud.mycadet.ai/v1/assistants/cloud-asst-1/domains/");
    expect(new Headers(post?.init?.headers).get("x-session-token")).toBe("sess_token_123");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ subdomain: "prime", email_username: "hello" });
  });

  test("a single detection with a single cloud row matches even when the names differ", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-prov-xdg-"));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
    await seedToken(configHome);
    const calls: RecordedCall[] = [];
    const fetcher: CloudEmailFetcher = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/assistants")) {
        return jsonResponse({ results: [{ id: "cloud-asst-9", name: "Cadet 1", status: "active" }] });
      }
      return jsonResponse({ subdomain: "prime" }, 201);
    };

    const result = await provisionCloudDomainsStep({
      findings: [
        {
          assistantId: "assistant-uuid-1",
          domain: "prime.vellum.me",
          subdomain: "prime",
          emailAddress: null,
        },
      ],
      envSuffix: "",
      fetcher,
    });

    expect(result.data?.["provisioned"]).toBe(1);
    expect(calls[1]?.url).toContain("/v1/assistants/cloud-asst-9/domains/");
  });

  test("no matching cloud assistant warns with the re-run guidance", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-prov-xdg-"));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
    await seedToken(configHome);
    const { fetcher } = recordingFetcher(() =>
      jsonResponse({ results: [{ id: "x", name: "someone-else", status: "active" }, { id: "y", name: "other", status: "active" }] }),
    );

    const result = await provisionCloudDomainsStep({
      findings: [
        {
          assistantId: "assistant-uuid-1",
          domain: "prime.vellum.me",
          subdomain: "prime",
          emailAddress: null,
        },
      ],
      envSuffix: "",
      fetcher,
    });

    expect(result.status).toBe("completed");
    expect(result.data?.["provisioned"]).toBe(0);
    expect(
      result.issues?.some((i) => i.message.includes("has not registered yet")),
    ).toBe(true);
  });

  test("a field-shaped 400 surfaces the cloud's own message", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-prov-xdg-"));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
    await seedToken(configHome);
    const fetcher: CloudEmailFetcher = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/assistants")) {
        return jsonResponse({ results: [{ id: "cloud-asst-1", name: "prime", status: "active" }] });
      }
      return jsonResponse({ subdomain: ["This subdomain is reserved."] }, 400);
    };

    const result = await provisionCloudDomainsStep({
      findings: [
        {
          assistantId: "assistant-uuid-1",
          domain: "mail.vellum.me",
          subdomain: "mail",
          emailAddress: null,
        },
      ],
      envSuffix: "",
      fetcher,
    });

    expect(result.status).toBe("completed");
    expect(result.data?.["provisioned"]).toBe(0);
    expect(result.issues?.some((i) => i.message.includes("This subdomain is reserved."))).toBe(true);
  });

  test("no findings is a quiet skip with nothing pending", async () => {
    const { fetcher } = recordingFetcher(provisionResponder);
    const result = await provisionCloudDomainsStep({ findings: [], envSuffix: "", fetcher });
    expect(result.status).toBe("skipped");
    expect(result.data?.["pending"]).toBe(false);
  });
});
