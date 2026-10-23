/**
 * Cloud-email migration: detect the migrated assistants' vellum-era managed
 * domain + email address OFFLINE (no vellum daemon involved), then register
 * the same domain + email on the cadet cloud — if and only after the user
 * creates a cadet account.
 *
 * Detection decrypts the CES credential store directly: the vellum daemon
 * seals its credentials in `keys.enc` ({version, entries: {key: {iv, tag,
 * data}}}, AES-256-GCM) with the sealing key in the sibling `store.key` file
 * (the "CES token") — see ces-keys.ts. From the unsealed values we take
 * `credential/vellum/assistant_api_key` (plus `platform_base_url` when set)
 * and trade it for the bound platform identity via the vellum platform's
 * `POST /v1/internal/assistants/validate/`; the assistant's managed domain
 * and email address then read off the platform's own listing routes. The
 * step runs BEFORE the credential scrub: that scrub is the last thing that
 * can delete the key from the working copy, so detection reads first — and
 * the original vellum root is never touched, so a re-run re-detects from it
 * even after the working copy was scrubbed.
 *
 * Provisioning runs AFTER cadet-login and wake-assistants: a domain can
 * only be created on the cadet cloud once the user has a cadet account
 * (`cadet login` wrote its session token) and the migrated assistant has
 * registered with it (the wake). Without an account the step reports
 * `pending` and the run's next steps tell the user to re-run the migrator
 * after `cadet login`.
 *
 * Both steps are best-effort: the network can be down and the platform is
 * being sunset, so every failure is a warning — the migration itself must
 * never fail or block on these.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readCesStore } from "../ces-keys.js";
import { walkTree } from "../fs-utils.js";
import type { StepIssue, StepResult } from "../types.js";

const VELLUM_API_KEY_ENTRY = "credential/vellum/assistant_api_key";
const VELLUM_BASE_URL_ENTRY = "credential/vellum/platform_base_url";
const DEFAULT_VELLUM_PLATFORM = "https://platform.vellum.ai";
const DEFAULT_CADET_CLOUD = "https://cloud.mycadet.ai";
const REQUEST_TIMEOUT_MS = 10_000;
// A DNS label: the shape both the vellum and the cadet managed domains use
// for their handles (lowercase alphanumerics + hyphens, 1–63 chars).
const EMAIL_USERNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Loose fetch seam so tests can stub the wire. */
export type CloudEmailFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudEmailFinding {
  assistantId: string;
  /** The managed domain as the platform lists it (e.g. "prime.vellum.me"). */
  domain: string | null;
  /** The domain's handle (e.g. "prime") — the cadet registration's subdomain. */
  subdomain: string | null;
  /** The managed email address (e.g. "hello@prime.vellum.me"). */
  emailAddress: string | null;
}

interface WireListEnvelope {
  results?: unknown;
}

/** One JSON request; null = unreachable/timed out (distint from a non-2xx). */
async function fetchJson(
  fetcher: CloudEmailFetcher,
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  try {
    const res = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return null;
  }
}

/** First human-readable message from a field-shaped error body, if any. */
function fieldError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  const detail = (body as Record<string, unknown>).detail;
  return typeof detail === "string" ? detail : null;
}

function firstListRow(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  const results = (body as WireListEnvelope).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const row = results[0];
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

export interface DetectCloudEmailOptions {
  /** Working roots to walk for keys.enc (docker scratch + the cadet root). */
  roots: ReadonlyArray<string>;
  /**
   * The untouched vellum root — its `protected/` store is the source of
   * truth a re-run can re-read after the working copy was scrubbed.
   */
  vellumRoot?: string;
  fetcher?: CloudEmailFetcher;
}

export interface CloudEmailDetectionData {
  detected: boolean;
  findings: CloudEmailFinding[];
}

/** The detect-cloud-email step. Never fails the run. */
export async function detectCloudEmailStep(opts: DetectCloudEmailOptions): Promise<StepResult> {
  const fetcher = opts.fetcher ?? fetch;
  const issues: StepIssue[] = [];
  const findings: CloudEmailFinding[] = [];

  // Candidate store dirs: keys.enc anywhere in the working roots (docker
  // scratch trees + the copied cadet root), plus the vellum root's own
  // protected/ dir when it exists.
  const storeDirs = new Set<string>();
  for (const root of opts.roots) {
    let tree;
    try {
      tree = await walkTree(root);
    } catch {
      continue;
    }
    for (const entry of tree) {
      if (entry.isDirectory) continue;
      const segments = entry.relPath.split("/");
      if (segments.includes("retired")) continue; // Cold storage keeps its copy.
      if (segments[segments.length - 1] !== "keys.enc") continue;
      storeDirs.add(path.dirname(entry.absPath));
    }
  }
  if (opts.vellumRoot) {
    const protectedDir = path.join(opts.vellumRoot, "protected");
    try {
      await fs.access(path.join(protectedDir, "keys.enc"));
      storeDirs.add(protectedDir);
    } catch {
      // No root-level store — docker deployments keep the CES in volumes.
    }
  }

  if (storeDirs.size === 0) {
    return {
      step: "detect-cloud-email",
      status: "skipped",
      summary: "no vellum credential store found — no cloud email to carry over",
      issues,
      data: { detected: false, findings: [] },
    };
  }

  const seenKeys = new Set<string>();
  for (const dir of storeDirs) {
    const store = await readCesStore(dir);
    if ("error" in store) {
      issues.push({ severity: "warning", message: store.error });
      continue;
    }
    const apiKey = store.entries[VELLUM_API_KEY_ENTRY]?.trim() ?? "";
    if (!apiKey || seenKeys.has(apiKey)) continue;
    seenKeys.add(apiKey);

    const baseUrl = (
      store.entries[VELLUM_BASE_URL_ENTRY]?.trim() || DEFAULT_VELLUM_PLATFORM
    ).replace(/\/+$/, "");

    // Trade the key for its bound platform identity (the vellum client's
    // own validate call, verbatim contract).
    const validated = await fetchJson(fetcher, `${baseUrl}/v1/internal/assistants/validate/`, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (validated === null) {
      issues.push({
        severity: "warning",
        message:
          "the vellum platform could not be reached — the domain and email address could not be looked up; the original vellum root keeps the key, re-run the migrator once the platform answers",
      });
      continue;
    }
    if (!validated.ok) {
      issues.push({
        severity: "warning",
        message: `the vellum platform refused the assistant api key (HTTP ${validated.status}) — the domain and email address could not be looked up; the original vellum root keeps the key, re-run the migrator once the platform answers`,
      });
      continue;
    }
    const assistantId =
      typeof (validated.body as Record<string, unknown> | null)?.assistant_id === "string"
        ? ((validated.body as Record<string, unknown>).assistant_id as string)
        : "";
    if (!assistantId) {
      issues.push({
        severity: "warning",
        message: "the vellum platform's validate response carried no assistant id",
      });
      continue;
    }

    // The managed domain + email address are platform-side state — the
    // listings are the only source of truth (workspace config never held
    // the email address).
    const domains = await fetchJson(fetcher, `${baseUrl}/v1/assistants/${assistantId}/domains/`);
    const emails = await fetchJson(
      fetcher,
      `${baseUrl}/v1/assistants/${assistantId}/email-addresses/`,
    );

    let domain: string | null = null;
    let subdomain: string | null = null;
    const domainRow = domains?.ok === true ? firstListRow(domains.body) : null;
    if (domains && !domains.ok) {
      issues.push({
        severity: "warning",
        message: `the vellum platform's domain listing answered HTTP ${domains.status}`,
      });
    }
    if (domainRow) {
      if (typeof domainRow.domain === "string" && domainRow.domain) domain = domainRow.domain;
      if (typeof domainRow.subdomain === "string" && domainRow.subdomain) {
        subdomain = domainRow.subdomain;
      } else if (domain && domain.endsWith(".vellum.me")) {
        subdomain = domain.slice(0, -".vellum.me".length);
      }
    }

    let emailAddress: string | null = null;
    const emailRow = emails?.ok === true ? firstListRow(emails.body) : null;
    if (emails && !emails.ok) {
      issues.push({
        severity: "warning",
        message: `the vellum platform's email listing answered HTTP ${emails.status}`,
      });
    }
    if (emailRow && typeof emailRow.address === "string" && emailRow.address) {
      emailAddress = emailRow.address;
    }

    findings.push({ assistantId, domain, subdomain, emailAddress });
  }

  if (findings.length === 0) {
    return {
      step: "detect-cloud-email",
      status: "skipped",
      summary: "no vellum platform credentials found in the stores — nothing to carry over",
      issues,
      data: { detected: false, findings: [] },
    };
  }

  const described = findings
    .map((f) => [f.domain, f.emailAddress, f.assistantId].filter(Boolean).join(" + "))
    .join(", ");
  return {
    step: "detect-cloud-email",
    status: "completed",
    summary: `found ${findings.length} vellum cloud identity(ies) to carry over: ${described}`,
    issues,
    data: { detected: true, findings },
  };
}

export interface ProvisionCloudDomainsOptions {
  findings: ReadonlyArray<CloudEmailFinding>;
  /** cadet env suffix for the config dir (envSuffixFor(vellumRoot)). */
  envSuffix: string;
  fetcher?: CloudEmailFetcher;
}

export interface CloudEmailProvisionData {
  provisioned: number;
  pending: boolean;
}

/** The cadet cloud account's email username for a vellum email address. */
function emailUsername(address: string | null): string | null {
  if (!address) return null;
  const local = address.split("@")[0]?.trim().toLowerCase() ?? "";
  return EMAIL_USERNAME_RE.test(local) ? local : null;
}

/** The provision-cloud-domains step. Never fails the run. */
export async function provisionCloudDomainsStep(
  opts: ProvisionCloudDomainsOptions,
): Promise<StepResult> {
  const fetcher = opts.fetcher ?? fetch;
  const issues: StepIssue[] = [];
  const step = "provision-cloud-domains";

  if (opts.findings.length === 0) {
    return {
      step,
      status: "skipped",
      summary: "no vellum cloud identity was detected — nothing to provision",
      issues,
      data: { provisioned: 0, pending: false },
    };
  }

  // The cadet account exists when `cadet login` wrote its session token —
  // the file the cadet CLI itself reads back (cloud-token, with the legacy
  // platform-token spelling as a fallback).
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const cadetConfigDir = path.join(configHome, `cadet${opts.envSuffix}`);
  let token: string | null = null;
  for (const name of ["cloud-token", "platform-token"]) {
    try {
      const raw = (await fs.readFile(path.join(cadetConfigDir, name), "utf8")).trim();
      if (raw) {
        token = raw;
        break;
      }
    } catch {
      // Try the next compatible location.
    }
  }
  if (!token) {
    return {
      step,
      status: "skipped",
      summary:
        "no cadet account yet — run `cadet login` and re-run the migrator to register the domain and email address",
      issues,
      data: { provisioned: 0, pending: true },
    };
  }

  const cloudUrl = (process.env.CADET_CLOUD_URL?.trim() || DEFAULT_CADET_CLOUD).replace(
    /\/+$/,
    "",
  );
  const listed = await fetchJson(fetcher, `${cloudUrl}/v1/assistants`, {
    headers: { "x-session-token": token },
  });
  if (listed === null || !listed.ok || typeof listed.body !== "object" || listed.body === null) {
    issues.push({
      severity: "warning",
      message:
        listed && !listed.ok
          ? `the cadet cloud's assistant list answered HTTP ${listed.status}`
          : "the cadet cloud could not be reached",
    });
    return {
      step,
      status: "completed",
      summary: "the cadet cloud's assistant list was not readable — nothing provisioned (re-run to retry)",
      issues,
      data: { provisioned: 0, pending: true },
    };
  }
  const results = (listed.body as WireListEnvelope).results;
  const rows: Array<Record<string, unknown>> = Array.isArray(results)
    ? results.filter(
        (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
      )
    : [];

  let provisioned = 0;
  for (const finding of opts.findings) {
    if (!finding.subdomain) {
      issues.push({
        severity: "warning",
        message: `assistant ${finding.assistantId}: no managed domain was detected on the vellum platform — nothing to register`,
      });
      continue;
    }
    // Match the migrated assistant's cadet cloud identity: by name when
    // the handle matches (the usual case), else the only-row fallback for
    // the single-assistant install.
    let row: Record<string, unknown> | null = null;
    const byName = rows.find((r) => r.name === finding.subdomain);
    if (byName) {
      row = byName;
    } else if (opts.findings.length === 1 && rows.length === 1) {
      row = rows[0] ?? null;
    }
    if (!row || typeof row.id !== "string" || !row.id) {
      issues.push({
        severity: "warning",
        message: `no cadet cloud assistant named "${finding.subdomain}" — the migrated assistant has not registered yet; re-run the migrator after its first wake`,
      });
      continue;
    }

    const body: Record<string, unknown> = { subdomain: finding.subdomain };
    const username = emailUsername(finding.emailAddress);
    if (finding.emailAddress && !username) {
      issues.push({
        severity: "warning",
        message: `the vellum email address ${finding.emailAddress} has no usable username — only the domain will be registered`,
      });
    }
    if (username) body.email_username = username;

    const registered = await fetchJson(
      fetcher,
      `${cloudUrl}/v1/assistants/${row.id}/domains/`,
      {
        method: "POST",
        headers: { "x-session-token": token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (registered === null) {
      issues.push({
        severity: "warning",
        message: `${finding.subdomain}: the cadet cloud could not be reached — re-run the migrator to retry`,
      });
      continue;
    }
    if (!registered.ok) {
      const detail = fieldError(registered.body);
      issues.push({
        severity: "warning",
        message: `${finding.subdomain}: the cadet cloud refused the registration (HTTP ${registered.status})${detail ? `: ${detail}` : ""}`,
      });
      continue;
    }
    provisioned++;
  }

  return {
    step,
    status: "completed",
    summary: `registered ${provisioned} of ${opts.findings.length} vellum domain(s)/email(s) on the cadet cloud`,
    issues,
    data: { provisioned, pending: false },
  };
}

/** Pull the detection findings back out of a detect-cloud-email StepResult. */
export function cloudEmailFindings(result: StepResult): CloudEmailFinding[] {
  const raw = result.data?.["findings"];
  return Array.isArray(raw) ? (raw as CloudEmailFinding[]) : [];
}
