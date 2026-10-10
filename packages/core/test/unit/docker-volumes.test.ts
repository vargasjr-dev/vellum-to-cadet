import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { describe, test } from "node:test";

import { cadetImageRefs } from "../../src/cadet-images.js";
import { migrateDockerVolumes, verifyDockerVolumes } from "../../src/steps/migrate-docker-volumes.js";
import { wakeAssistants } from "../../src/steps/wake.js";
import type { ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";

/**
 * A docker volume simulator: `dockerDirToVolume` copies a dir into the
 * simulated volume, `dockerVolumeToDir` copies the volume back out. The
 * tests assert against the SIMULATED volume contents — exactly what the
 * real docker volumes would hold after the step ran.
 */
function makeVolumeStore() {
  const volumes = new Map<string, string>();
  const copyDir = async (src: string, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(src, dest, { recursive: true });
  };
  return {
    ops: {
      async dockerVolumeToDir(volume: string, destDir: string) {
        const src = volumes.get(volume);
        if (!src) throw new Error(`simulator: no such volume ${volume}`);
        await copyDir(src, destDir);
      },
      async dockerDirToVolume(srcDir: string, volume: string) {
        const dest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vtc-sim-")), "root");
        await copyDir(srcDir, dest);
        volumes.set(volume, dest);
      },
      async dockerAvailable() {
        return true;
      },
    } satisfies Pick<ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable">,
    readVolume: (volume: string) => volumes.get(volume),
  };
}

/** A vellum-branded assistant db, as the workspace volume holds it. */
async function writeBrandedAssistantDb(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "data/db"), { recursive: true });
  const db = new Database(path.join(dir, "data/db/assistant.db"));
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, user_message_channel TEXT)");
  db.exec("INSERT INTO messages (content, user_message_channel) VALUES ('see vellum://a.png', 'vellum')");
  db.close();
}

/** A vellum-branded gateway db, as the gateway-security volume holds it. */
async function writeBrandedGatewayDb(dir: string): Promise<void> {
  const db = new Database(path.join(dir, "gateway.sqlite"));
  db.exec("CREATE TABLE contact_channels (id INTEGER PRIMARY KEY, type TEXT)");
  db.exec("INSERT INTO contact_channels (type) VALUES ('vellum')");
  db.close();
}

/** An encrypted store carrying vellum-namespace credentials. */
async function writeBrandedCredentialStore(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "keys.enc"),
    JSON.stringify(
      { entries: { "credential/vellum/api_key": { x: 1 }, "credential/webhook/secret": { x: 2 } } },
      null, 2,
    ) + "\n",
  );
}

const INSTANCE = "vellum-prime-quail-3ezfs4";
const MIGRATED = "prime-quail-3ezfs4";

function baseOps(): ProcessOps {
  return {
    find: async () => [],
    vellumVersion: async () => null,
    vellumSleep: async () => {},
    cadetSleep: async () => {},
    installCadet: async () => {},
    cadetWakeAll: async () => {},
    cadetVersion: async () => null,
    dockerVolumeToDir: async () => {},
    dockerDirToVolume: async () => {},
    dockerAvailable: async () => false,
    cadetLogin: async () => {},
    cadetBinAvailable: async () => true,
    npmGlobalRoot: async () => null,
  };
}

describe("cadet-images", () => {
  test("stable versions tag the plain repos with v<version>", () => {
    expect(cadetImageRefs("0.12.7")).toEqual({
      assistant: "mycadet/mycadet-assistant:v0.12.7",
      gateway: "mycadet/mycadet-gateway:v0.12.7",
      credentialExecutor: "mycadet/mycadet-credential-executor:v0.12.7",
    });
  });

  test("dev builds use the -dev repos", () => {
    const refs = cadetImageRefs("0.12.6-dev.202610081023.3a27b77");
    expect(refs.assistant).toBe("mycadet/mycadet-assistant-dev:v0.12.6-dev.202610081023.3a27b77");
    expect(refs.credentialExecutor).toBe("mycadet/mycadet-credential-executor-dev:v0.12.6-dev.202610081023.3a27b77");
  });
});

describe("migrate-docker-volumes", () => {
  test("extracts the three volumes, value-migrates them, and imports under the migrated name", async () => {
    const sim = makeVolumeStore();
    // Seed the VELLUM-side volumes (raw instance id names).
    const seed = async (volume: string, fn: (dir: string) => Promise<void>) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-seed-"));
      await fn(dir);
      // Route the seed through the simulator so extraction reads it back.
      await sim.ops.dockerDirToVolume(dir, volume);
    };
    await seed(`${INSTANCE}-workspace`, async (dir) => {
      await writeBrandedAssistantDb(dir);
      await fs.writeFile(path.join(dir, "config.json"), '{"provider":"vellum"}');
    });
    await seed(`${INSTANCE}-gateway-sec`, writeBrandedGatewayDb);
    await seed(`${INSTANCE}-ces-sec`, writeBrandedCredentialStore);

    const result = await migrateDockerVolumes({
      ops: baseOps(),
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: ["vellumai/vellum-assistant:0.12.6"],
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("1 docker instance");
    // The db value steps' info bullets ride along; no warnings.
    expect((result.issues ?? []).filter((i) => i.severity !== "info")).toEqual([]);

    // The cadet-side volumes (migrated name) hold migrated data: dbs clean
    // of vellum rows, provider values flipped, credentials scrubbed.
    const workspace = sim.readVolume(`${MIGRATED}-workspace`);
    expect(workspace).toBeDefined();
    const db = new Database(path.join(workspace!, "data/db/assistant.db"), { readOnly: true });
    const channels = db.prepare(`SELECT user_message_channel AS c FROM messages`).all();
    expect(channels).toEqual([{ c: "cadet" }]);
    db.close();
    const config = await fs.readFile(path.join(workspace!, "config.json"), "utf8");
    expect(config).toContain('"cadet"');

    const gw = sim.readVolume(`${MIGRATED}-gateway-sec`);
    const gwDb = new Database(path.join(gw!, "gateway.sqlite"), { readOnly: true });
    const types = gwDb.prepare(`SELECT type AS t FROM contact_channels`).all();
    expect(types).toEqual([{ t: "cadet" }]);
    gwDb.close();

    const ces = sim.readVolume(`${MIGRATED}-ces-sec`);
    const store = JSON.parse(await fs.readFile(path.join(ces!, "keys.enc"), "utf8"));
    expect(Object.keys(store.entries)).toEqual(["credential/webhook/secret"]);
  });

  test("an unreachable docker daemon warns and completes without migrating", async () => {
    const ops = baseOps();
    const result = await migrateDockerVolumes({
      ops,
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => false,
      },
      instances: [INSTANCE],
      images: [],
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("docker daemon unreachable");
    expect(result.issues?.some((i) => i.message.includes("were NOT migrated"))).toBe(true);
  });

  test("no docker instances skips", async () => {
    const result = await migrateDockerVolumes({
      ops: baseOps(),
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => true,
      },
      instances: [],
      images: [],
    });
    expect(result.status).toBe("skipped");
  });
});

describe("verify-docker-volumes", () => {
  test("re-extracts the cadet volumes and reports the migrated data clean", async () => {
    const sim = makeVolumeStore();
    // Seed the cadet-side volumes with already-migrated data.
    const seed = async (volume: string, fn: (dir: string) => Promise<void>) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-seed-"));
      await fn(dir);
      await sim.ops.dockerDirToVolume(dir, volume);
    };
    await seed(`${MIGRATED}-workspace`, async (dir) => {
      await fs.mkdir(path.join(dir, "data/db"), { recursive: true });
      const db = new Database(path.join(dir, "data/db/assistant.db"));
      db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, user_message_channel TEXT)");
      db.exec("INSERT INTO messages (content, user_message_channel) VALUES ('see cadet://a.png', 'cadet')");
      db.close();
    });
    await seed(`${MIGRATED}-gateway-sec`, async (dir) => {
      const db = new Database(path.join(dir, "gateway.sqlite"));
      db.exec("CREATE TABLE contact_channels (id INTEGER PRIMARY KEY, type TEXT)");
      db.exec("INSERT INTO contact_channels (type) VALUES ('cadet')");
      db.close();
    });
    await seed(`${MIGRATED}-ces-sec`, async (dir) => {
      await fs.writeFile(path.join(dir, "keys.enc"), JSON.stringify({ entries: { "credential/cadet/k": {} } }));
    });

    const result = await verifyDockerVolumes({
      ops: baseOps(),
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: [],
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("2 volume db(s) free of vellum rows");
  });

  test("leftover vellum rows and credentials surface as warnings", async () => {
    const sim = makeVolumeStore();
    const seed = async (volume: string, fn: (dir: string) => Promise<void>) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-seed-"));
      await fn(dir);
      await sim.ops.dockerDirToVolume(dir, volume);
    };
    await seed(`${MIGRATED}-workspace`, writeBrandedAssistantDb);
    await seed(`${MIGRATED}-gateway-sec`, writeBrandedGatewayDb);
    await seed(`${MIGRATED}-ces-sec`, writeBrandedCredentialStore);

    const result = await verifyDockerVolumes({
      ops: baseOps(),
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: [],
    });

    expect(result.status).toBe("completed");
    const messages = (result.issues ?? []).map((i) => i.message);
    expect(messages.some((m) => m.includes("still has") && m.includes("vellum-branded row(s)") && m.includes(`${MIGRATED}-workspace`))).toBe(true);
    expect(messages.some((m) => m.includes(`${MIGRATED}-gateway-sec`) && m.includes("vellum-branded row(s)"))).toBe(true);
    expect(messages.some((m) => m.includes(`${MIGRATED}-ces-sec`) && m.includes("vellum-namespace credential"))).toBe(true);
  });
});

describe("wake-assistants: failure reporting", () => {
  test("the wake warning carries the command's actual stderr, not just 'Command failed'", async () => {
    const ops = baseOps();
    ops.cadetWakeAll = async () => {
      const err = new Error("Command failed: cadet wake --all") as Error & { stderr?: string };
      err.stderr = "Error response from daemon: No such container: prime-quail-3ezfs4-assistant\nError: failed to start containers: prime-quail-3ezfs4-assistant";
      throw err;
    };
    const wake = await wakeAssistants(ops, 1, true);
    const warning = wake.issues?.[0]?.message ?? "";
    expect(warning.startsWith("cadet wake --all failed:")).toBe(true);
    expect(warning).toContain("No such container: prime-quail-3ezfs4-assistant");
    expect(warning).not.toContain("Command failed");
  });
});
