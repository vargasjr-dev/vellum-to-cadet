import { describe, test } from "node:test";
import * as net from "node:net";

import {
  adoptExistingPorts,
  basePortsForEnvSuffix,
  declashEntryPorts,
  defaultIsPortFree,
  rewriteRuntimeUrlPort,
} from "../../src/port-declash.js";
import { expect } from "../helpers/expect.js";

/** A probe where every port is free except the ones in `held`. */
const freeExcept =
  (held: ReadonlySet<number>) =>
  async (port: number): Promise<boolean> =>
    !held.has(port);

const everythingFree = freeExcept(new Set<number>());

function localEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assistantId: "grand-ram",
    cloud: "local",
    runtimeUrl: "http://127.0.0.1:7830",
    resources: { instanceDir: "/cadet-root/assistants/grand-ram", gatewayPort: 7830, daemonPort: 7821 },
    ...overrides,
  };
}

describe("port-declash: declashEntryPorts", () => {
  test("a local entry gets fresh ports — never its vellum ports, even when free", async () => {
    const entry = localEntry();
    const result = await declashEntryPorts(entry, {
      envSuffix: "",
      isPortFree: everythingFree,
    });
    const resources = entry.resources as Record<string, unknown>;
    expect(result?.moves).toEqual([
      { field: "daemonPort", from: 7821, to: 7822 },
      { field: "gatewayPort", from: 7830, to: 7831 },
    ]);
    expect(resources.daemonPort).toBe(7822);
    expect(resources.gatewayPort).toBe(7831);
    // the runtime url's port follows the gateway
    expect(entry.runtimeUrl).toBe("http://127.0.0.1:7831");
  });

  test("occupied candidates are skipped — the walk moves upward", async () => {
    const entry = localEntry();
    // 7822 and 7831 (the first choices) are held by someone else.
    const result = await declashEntryPorts(entry, {
      envSuffix: "",
      isPortFree: freeExcept(new Set([7822, 7831])),
    });
    expect(result?.moves).toEqual([
      { field: "daemonPort", from: 7821, to: 7823 },
      { field: "gatewayPort", from: 7830, to: 7832 },
    ]);
    expect(entry.runtimeUrl).toBe("http://127.0.0.1:7832");
  });

  test("a second entry never lands on the first entry's fresh ports", async () => {
    const first = localEntry({ assistantId: "a" });
    await declashEntryPorts(first, { envSuffix: "", isPortFree: everythingFree });
    const firstResources = first.resources as Record<string, number>;
    const claimed = new Set(
      Object.entries(firstResources)
        .filter(([, v]) => typeof v === "number")
        .map(([, v]) => v as number),
    );
    const second = localEntry({ assistantId: "b" });
    await declashEntryPorts(second, { envSuffix: "", claimed, isPortFree: everythingFree });
    const resources = second.resources as Record<string, unknown>;
    expect(resources.daemonPort).toBe(7823);
    expect(resources.gatewayPort).toBe(7832);
  });

  test("non-prod env suffixes walk from their cadet port block", async () => {
    const entry = localEntry();
    await declashEntryPorts(entry, { envSuffix: "-staging", isPortFree: everythingFree });
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.daemonPort).toBe(17000);
    expect(resources.gatewayPort).toBe(17100);
  });

  test("a docker entry with resources is de-clashed; containerInfo stays untouched", async () => {
    const entry = {
      assistantId: "prime-quail",
      cloud: "docker",
      runtimeUrl: "http://MacBook-Pro-8.local:7830/x",
      containerInfo: { assistantImage: "mycadet/mycadet-assistant:v1", assistantPort: 7821 },
      resources: { gatewayPort: 7830, daemonPort: 7821 },
    };
    const result = await declashEntryPorts(entry, { envSuffix: "", isPortFree: everythingFree });
    expect(result?.moves.length).toBe(2);
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.gatewayPort).toBe(7831);
    // docker runtime urls keep their host — only the port follows the gateway
    expect(entry.runtimeUrl).toBe("http://MacBook-Pro-8.local:7831/x");
    expect((entry.containerInfo as Record<string, unknown>).assistantPort).toBe(7821);
  });

  test("paired and vellum-cloud entries pass through untouched", async () => {
    for (const cloud of ["paired", "vellum"]) {
      const entry = localEntry({ cloud });
      const result = await declashEntryPorts(entry, { envSuffix: "", isPortFree: everythingFree });
      expect(result).toBe(null);
      expect(entry.resources).toEqual({
        instanceDir: "/cadet-root/assistants/grand-ram",
        gatewayPort: 7830,
        daemonPort: 7821,
      });
    }
  });

  test("a local entry with no resources passes through untouched", async () => {
    const entry = localEntry({ resources: undefined });
    const result = await declashEntryPorts(entry, { envSuffix: "", isPortFree: everythingFree });
    expect(result).toBe(null);
    expect(entry.resources).toBe(undefined);
  });

  test("an entry recording no ports passes through untouched", async () => {
    const entry = { assistantId: "a", cloud: "local", resources: { instanceDir: "/x" } };
    const result = await declashEntryPorts(entry, { envSuffix: "", isPortFree: everythingFree });
    expect(result).toBe(null);
    expect(entry.resources).toEqual({ instanceDir: "/x" });
  });

  test("keepFields survive untouched while the rest still moves", async () => {
    const entry = localEntry();
    const result = await declashEntryPorts(entry, {
      envSuffix: "",
      isPortFree: everythingFree,
      keepFields: new Set(["gatewayPort"]),
    });
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.gatewayPort).toBe(7830);
    expect(resources.daemonPort).toBe(7822);
    expect(result?.moves).toEqual([{ field: "daemonPort", from: 7821, to: 7822 }]);
    // the gateway kept 7830, so the runtime url keeps it too
    expect(entry.runtimeUrl).toBe("http://127.0.0.1:7830");
  });

  test("exhausting the 100-port walk throws", async () => {
    const entry = localEntry();
    let threw: Error | null = null;
    try {
      await declashEntryPorts(entry, { envSuffix: "", isPortFree: async () => false });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw?.message?.startsWith("no free port scanning from 7821") ?? false).toBe(true);
  });

  test("the real 0.0.0.0 bind probe sees a live listener", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const held = (blocker.address() as net.AddressInfo).port;
    try {
      expect(await defaultIsPortFree(held)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    expect(await defaultIsPortFree(held)).toBe(true);
  });
});

describe("port-declash: adoptExistingPorts", () => {
  test("adopts the existing entry's numeric ports and names the fields", () => {
    const converted = localEntry();
    const existing = {
      resources: { instanceDir: "/elsewhere", gatewayPort: 7900, daemonPort: 7901, cesPort: 7902 },
    };
    const adopted = adoptExistingPorts(converted, existing);
    expect(adopted?.gatewayPort).toBe(7900);
    expect(adopted?.fields).toEqual(["daemonPort", "gatewayPort", "cesPort"]);
    expect((converted.resources as Record<string, unknown>).gatewayPort).toBe(7900);
    expect((converted.resources as Record<string, unknown>).daemonPort).toBe(7901);
    expect((converted.resources as Record<string, unknown>).cesPort).toBe(7902);
  });

  test("an existing entry without usable ports adopts nothing", () => {
    const converted = localEntry();
    expect(adoptExistingPorts(converted, { resources: { instanceDir: "/x" } })).toBe(null);
    expect(adoptExistingPorts(converted, {})).toBe(null);
    expect(adoptExistingPorts(converted, { resources: "junk" })).toBe(null);
  });
});

describe("port-declash: helpers", () => {
  test("basePortsForEnvSuffix maps known envs and falls back to production", () => {
    expect(basePortsForEnvSuffix("")).toEqual({ daemon: 7821, gateway: 7830, qdrant: 6333, ces: 8090 });
    expect(basePortsForEnvSuffix("-staging")).toEqual({
      daemon: 17000,
      gateway: 17100,
      qdrant: 17200,
      ces: 17300,
    });
    expect(basePortsForEnvSuffix("-dev").daemon).toBe(18000);
    expect(basePortsForEnvSuffix("-preview").gateway).toBe(7830);
  });

  test("rewriteRuntimeUrlPort replaces the port segment; portless urls pass through", () => {
    expect(rewriteRuntimeUrlPort("http://127.0.0.1:7830", 7900)).toBe("http://127.0.0.1:7900");
    expect(rewriteRuntimeUrlPort("http://Mac.local:7830/api/v1", 7900)).toBe(
      "http://Mac.local:7900/api/v1",
    );
    expect(rewriteRuntimeUrlPort("http://127.0.0.1", 7900)).toBe("http://127.0.0.1");
    expect(rewriteRuntimeUrlPort("not a url", 7900)).toBe("not a url");
  });
});
