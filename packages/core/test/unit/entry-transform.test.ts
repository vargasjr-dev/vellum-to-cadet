import { describe, test } from "node:test";

import { localRuntimeUrlToLoopback, transformAssistantEntry } from "../../src/entry-transform.js";
import { expect } from "../helpers/expect.js";

describe("entry-transform: assistant entries", () => {
  test("strips the vellum- prefix from ids and names, drops species and cloud identity", () => {
    const result = transformAssistantEntry(
      {
        assistantId: "vellum-grand-ram",
        name: "vellum-grand-ram",
        cloud: "local",
        species: "cinderling",
        organizationId: "org_1",
        platformAssistantId: "pa_1",
        platformBaseUrl: "https://platform.vellum.ai",
        platformOrganizationId: "org_2",
        hatchedAt: "2026-09-01T10:00:00.000Z",
      },
      { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/cadet/assistants/x" },
    );
    expect(result.changed).toBe(true);
    expect(result.hadLegacyPlatformCredentials).toBe(true);
    expect(result.entry.assistantId).toBe("grand-ram");
    expect(result.entry.name).toBe("grand-ram");
    expect("species" in result.entry).toBe(false);
    expect("organizationId" in result.entry).toBe(false);
    expect("platformAssistantId" in result.entry).toBe(false);
    expect("platformBaseUrl" in result.entry).toBe(false);
    expect("platformOrganizationId" in result.entry).toBe(false);
    expect(result.entry.hatchedAt).toBe("2026-09-01T10:00:00.000Z");
  });

  test("strips the renamed cloud spellings of the same vellum identity", () => {
    const result = transformAssistantEntry(
      {
        assistantId: "grand-ram",
        name: "grand-ram",
        cloud: "local",
        cloudBaseUrl: "https://platform.vellum.ai",
        cloudOrganizationId: "org_2",
        hatchedAt: "2026-09-01T10:00:00.000Z",
      },
      { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/cadet/assistants/x" },
    );
    expect(result.changed).toBe(true);
    expect(result.hadLegacyPlatformCredentials).toBe(true);
    expect("cloudBaseUrl" in result.entry).toBe(false);
    expect("cloudOrganizationId" in result.entry).toBe(false);
    expect(result.entry.hatchedAt).toBe("2026-09-01T10:00:00.000Z");
  });

  test("rewrites the runtime url to loopback for local assistants only", () => {
    const local = transformAssistantEntry(
      { assistantId: "a", cloud: "local", runtimeUrl: "http://MacBook-Pro-8.local:7830" },
      { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/x" },
    );
    expect(local.entry.runtimeUrl).toBe("http://127.0.0.1:7830");
    expect(local.changed).toBe(true);

    // docker / paired / vellum-cloud urls are not the migrator's to touch.
    for (const cloud of ["docker", "paired", "vellum"]) {
      const other = transformAssistantEntry(
        { assistantId: "a", cloud, runtimeUrl: "http://MacBook-Pro-8.local:7830" },
        { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/x" },
      );
      expect(other.entry.runtimeUrl).toBe("http://MacBook-Pro-8.local:7830");
    }
  });

  test("repoints data dirs at the cadet destination and makes baseDataDir agree", () => {
    const result = transformAssistantEntry(
      {
        assistantId: "vellum-grand-ram",
        baseDataDir: "/vellum-root",
        resources: { instanceDir: "/vellum-root/assistants/vellum-grand-ram" },
      },
      {
        // Mirrors the real mapper: root prefix map + the instance-name strip.
        mapInstanceDir: (d) => d.replace("/vellum-root", "/cadet-root").replace("vellum-grand-ram", "grand-ram"),
        defaultInstanceDirFor: () => "/cadet-root/assistants/never",
      },
    );
    expect(result.entry.resources).toEqual({
      instanceDir: "/cadet-root/assistants/grand-ram",
    });
    expect(result.entry.baseDataDir).toBe("/cadet-root/assistants/grand-ram");
  });

  test("falls back to the derived cadet instance dir when no resources record one", () => {
    const result = transformAssistantEntry(
      { assistantId: "vellum-grand-ram", baseDataDir: "/vellum-root" },
      {
        mapInstanceDir: (d) => d,
        defaultInstanceDirFor: (id) => `/cadet-root/assistants/${id}`,
      },
    );
    // baseDataDir points at the cadet instance dir, which ends with the
    // assistant's name — never at a bare vellum root.
    expect(result.entry.baseDataDir).toBe("/cadet-root/assistants/grand-ram");
  });

  test("unknown and sensitive fields ride through untouched", () => {
    const result = transformAssistantEntry(
      {
        assistantId: "vellum-a",
        signingKey: "hex",
        bearerToken: "tok",
        containerInfo: { assistantImage: "x" },
      },
      { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/x" },
    );
    expect(result.entry.signingKey).toBe("hex");
    expect(result.entry.bearerToken).toBe("tok");
    expect(result.entry.containerInfo).toEqual({ assistantImage: "x" });
  });

  test("a non-vellum identity with no cloud registration is unchanged", () => {
    const raw = {
      assistantId: "grand-ram",
      name: "grand-ram",
      cloud: "local",
      resources: { instanceDir: "/cadet-root/assistants/grand-ram" },
    };
    const result = transformAssistantEntry(raw, {
      mapInstanceDir: (d) => d,
      defaultInstanceDirFor: () => "/x",
    });
    expect(result.changed).toBe(false);
    expect(result.hadLegacyPlatformCredentials).toBe(false);
    expect(result.entry).toEqual(raw);
  });
});

describe("entry-transform: localRuntimeUrlToLoopback", () => {
  test("rewrites the hostname and keeps the port", () => {
    expect(localRuntimeUrlToLoopback("http://MacBook-Pro-8.local:7830")).toBe(
      "http://127.0.0.1:7830",
    );
    expect(localRuntimeUrlToLoopback("https://my-machine.local:7830/api")).toBe(
      "https://127.0.0.1:7830/api",
    );
  });

  test("already-loopback and unparseable urls pass through", () => {
    expect(localRuntimeUrlToLoopback("http://127.0.0.1:7830")).toBe("http://127.0.0.1:7830");
    expect(localRuntimeUrlToLoopback("http://localhost:7830")).toBe("http://localhost:7830");
    expect(localRuntimeUrlToLoopback("not a url")).toBe("not a url");
    expect(localRuntimeUrlToLoopback("")).toBe("");
  });
});

describe("entry-transform: docker containerInfo", () => {
  const vellumImages = {
    assistantImage: "us-central1-docker.pkg.dev/vellum-ai-prod/sandbox-images/assistant-server@sha256:c737",
    gatewayImage: "us-central1-docker.pkg.dev/vellum-ai-prod/sandbox-images/gateway@sha256:beef",
    cesImage: "us-central1-docker.pkg.dev/vellum-ai-prod/sandbox-images/ces@sha256:dead",
    assistantDigest: "sha256:aaa",
    gatewayDigest: "sha256:bbb",
    cesDigest: "sha256:ccc",
    networkName: "vellum-prime-quail-3ezfs4-net",
    assistantPort: 7821,
  };

  test("repoints the service images at cadet's and drops the digest/network bookkeeping", () => {
    const result = transformAssistantEntry(
      {
        assistantId: "vellum-prime-quail-3ezfs4",
        cloud: "docker",
        containerInfo: { ...vellumImages },
      },
      {
        mapInstanceDir: (d) => d,
        defaultInstanceDirFor: () => "/x",
        cadetImages: {
          assistant: "mycadet/mycadet-assistant:v0.12.7",
          gateway: "mycadet/mycadet-gateway:v0.12.7",
          credentialExecutor: "mycadet/mycadet-credential-executor:v0.12.7",
        },
      },
    );
    expect(result.changed).toBe(true);
    expect(result.dockerImagesUnresolved).toBeUndefined();
    const info = result.entry.containerInfo as Record<string, unknown>;
    expect(info.assistantImage).toBe("mycadet/mycadet-assistant:v0.12.7");
    expect(info.gatewayImage).toBe("mycadet/mycadet-gateway:v0.12.7");
    expect(info.cesImage).toBe("mycadet/mycadet-credential-executor:v0.12.7");
    for (const field of ["assistantDigest", "gatewayDigest", "cesDigest", "networkName"]) {
      expect(field in info).toBe(false);
    }
    expect(info.assistantPort).toBe(7821);
  });

  test("without cadet images the vellum refs stay (warned) and the digests still drop", () => {
    const result = transformAssistantEntry(
      {
        assistantId: "vellum-prime-quail-3ezfs4",
        cloud: "docker",
        containerInfo: { ...vellumImages },
      },
      { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/x" },
    );
    expect(result.dockerImagesUnresolved).toBe(true);
    const info = result.entry.containerInfo as Record<string, unknown>;
    expect(info.assistantImage).toBe(vellumImages.assistantImage);
    expect("assistantDigest" in info).toBe(false);
    expect("networkName" in info).toBe(false);
  });

  test("non-docker entries keep their containerInfo untouched", () => {
    const containerInfo = { assistantImage: "x", assistantDigest: "sha256:aaa" };
    const result = transformAssistantEntry(
      { assistantId: "a", cloud: "local", containerInfo },
      { mapInstanceDir: (d) => d, defaultInstanceDirFor: () => "/x" },
    );
    expect(result.dockerImagesUnresolved).toBeUndefined();
    expect((result.entry.containerInfo as Record<string, unknown>).assistantDigest).toBe("sha256:aaa");
  });
});
