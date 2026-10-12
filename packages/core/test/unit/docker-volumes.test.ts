import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { describe, test } from "node:test";

import { cadetImageRefs } from "../../src/cadet-images.js";
import { fetchDockerVolumes, loadDockerVolumes, verifyDockerVolumeData } from "../../src/steps/migrate-docker-volumes.js";
import { findStateDbs, migrateAssistantDb, migrateGatewayDb } from "../../src/steps/migrate-assistant-db.js";
import { migrateCredentialsStep } from "../../src/steps/scrub-credentials.js";
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
    cadetVersion: async () => ({ version: null }),
    dockerVolumeToDir: async () => {},
    dockerDirToVolume: async () => {},
    dockerAvailable: async () => false,
    cadetLogin: async () => {},
    cadetBinAvailable: async () => true,
    npmGlobalRoot: async () => null,
  };
}

/** Seed the VELLUM-side volumes with branded data and return a scratch workRoot. */
async function seededVolumes(sim: ReturnType<typeof makeVolumeStore>) {
  const seed = async (volume: string, fn: (dir: string) => Promise<void>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-seed-"));
    await fn(dir);
    await sim.ops.dockerDirToVolume(dir, volume);
  };
  await seed(`${INSTANCE}-workspace`, async (dir) => {
    await writeBrandedAssistantDb(dir);
    await fs.writeFile(path.join(dir, "config.json"), '{"provider":"vellum"}');
  });
  await seed(`${INSTANCE}-gateway-sec`, writeBrandedGatewayDb);
  await seed(`${INSTANCE}-ces-sec`, writeBrandedCredentialStore);
  return await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-"));
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

describe("fetch-docker-volumes", () => {
  test("extracts the three volumes into the scratch tree and applies the workspace content transforms", async () => {
    const sim = makeVolumeStore();
    const workRoot = await seededVolumes(sim);
    const items: Array<{ name: string; status: string; summary?: string }> = [];

    const result = await fetchDockerVolumes({
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: ["vellumai/vellum-assistant:0.12.6"],
      workRoot,
      onItem: (item) => items.push(item),
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("1 docker instance(s)");
    // The per-instance events: started, then completed with a summary.
    expect(items.map((i) => i.status)).toEqual(["started", "completed"]);
    // (v0.0.16 field feedback: the summary carries the bytes + duration.)
    expect(items[1]?.summary).toMatch(/3 volume\(s\), .* extracted in /);

    // The extracted trees are STATE-SHAPED — one state root per assistant,
    // the layout the value steps' discovery expects. Workspace content
    // transformed in place...
    const workspace = path.join(workRoot, INSTANCE, "workspace");
    const config = await fs.readFile(path.join(workspace, "config.json"), "utf8");
    expect(config).toContain('"cadet"');
    // ...the dbs ride as-is here — the shared db steps migrate them.
    const gateway = path.join(workRoot, INSTANCE, "gateway-security");
    expect(await fs.stat(path.join(gateway, "gateway.sqlite"))).toBeTruthy();
    const ces = path.join(workRoot, INSTANCE, "ces-security");
    expect(await fs.stat(path.join(ces, "keys.enc"))).toBeTruthy();
  });

  test("an unreachable docker daemon warns and completes without fetching", async () => {
    const result = await fetchDockerVolumes({
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => false,
      },
      instances: [INSTANCE],
      images: [],
      workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-")),
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("docker daemon unreachable");
    expect(result.issues?.some((i) => i.message.includes("were NOT migrated"))).toBe(true);
  });

  test("a failed extraction fails the step with an error issue", async () => {
    // v0.0.13 run feedback: the transfer failure used to be a warning and
    // the run continued over a tree that was never fetched.
    const result = await fetchDockerVolumes({
      dockerOps: {
        dockerVolumeToDir: async () => {
          throw new Error("extract vellum-prime-quail-3ezfs4-workspace: exited 125 — no space left on device");
        },
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => true,
      },
      instances: [INSTANCE],
      images: [],
      workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-")),
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("volume extraction failed for 1 of 1 docker instance(s)");
    const error = (result.issues ?? []).find((i) => i.severity === "error");
    expect(error?.message).toContain("volume extraction failed");
    expect(error?.message).toContain("exited 125");
  });

  test("no docker instances skips", async () => {
    const result = await fetchDockerVolumes({
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => true,
      },
      instances: [],
      images: [],
      workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-")),
    });
    expect(result.status).toBe("skipped");
  });

  test("docker ops byte progress rides the item events as `progress`", async () => {
    const sim = makeVolumeStore();
    const workRoot = await seededVolumes(sim);
    const items: Array<{ name: string; status: string; progress?: { bytes: number; totalBytes?: number; label?: string } }> = [];

    // Wrap the simulator: capture the onProgress callbacks the step hands
    // the ops (one per volume, in order), fire the first as a transfer
    // would, assert the event shape.
    const reports: Array<(bytes: number, totalBytes?: number) => void> = [];
    const ops = {
      ...sim.ops,
      dockerVolumeToDir: async (volume: string, destDir: string, image?: string, onProgress?: (bytes: number, totalBytes?: number) => void) => {
        if (onProgress) reports.push(onProgress);
        await sim.ops.dockerVolumeToDir(volume, destDir);
      },
    } satisfies Pick<import("../../src/types.js").ProcessOps, "dockerVolumeToDir" | "dockerDirToVolume" | "dockerAvailable">;

    await fetchDockerVolumes({
      dockerOps: ops,
      instances: [INSTANCE],
      images: [],
      workRoot,
      onItem: (item) => items.push(item),
    });

    expect(reports.length).toBe(3); // one per volume — the three now stream CONCURRENTLY
    items.length = 0; // drop the started/completed pair — pin progress alone
    // Each stream taps its own bytes; the item event carries the
    // AGGREGATE across the volumes, totalBytes once every denominator is
    // measured (v0.0.16: parallel transfers, one summed progress line).
    reports[0]?.(300, 400);
    expect(items.at(-1)).toEqual({
      name: INSTANCE,
      status: "progress",
      progress: { bytes: 300, label: "volumes" },
    });
    reports[1]?.(50, 100);
    reports[2]?.(7, 10);
    expect(items.at(-1)).toEqual({
      name: INSTANCE,
      status: "progress",
      progress: { bytes: 357, totalBytes: 510, label: "volumes" },
    });
  });
});

describe("the shared value steps over the extracted trees", () => {
  test("migrate-assistant-db + migrate-gateway-db migrate the extracted dbs; credentials scrub the ces tree", async () => {
    const sim = makeVolumeStore();
    const workRoot = await seededVolumes(sim);
    await fetchDockerVolumes({
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: [],
      workRoot,
    });

    const assistantStep = await migrateAssistantDb([workRoot]);
    expect(assistantStep.step).toBe("migrate-assistant-db");
    expect(assistantStep.status).toBe("completed");
    expect(assistantStep.summary).toContain("assistant db — 2 row(s)");
    const assistantDb = new Database(
      path.join(workRoot, INSTANCE, "workspace", "data/db/assistant.db"),
      { readOnly: true },
    );
    const channels = assistantDb.prepare(`SELECT user_message_channel AS c FROM messages`).all();
    expect(channels).toEqual([{ c: "cadet" }]);
    assistantDb.close();

    const gatewayStep = await migrateGatewayDb([workRoot]);
    expect(gatewayStep.step).toBe("migrate-gateway-db");
    expect(gatewayStep.status).toBe("completed");
    const gatewayDb = new Database(
      path.join(workRoot, INSTANCE, "gateway-security", "gateway.sqlite"),
      { readOnly: true },
    );
    const types = gatewayDb.prepare(`SELECT type AS t FROM contact_channels`).all();
    expect(types).toEqual([{ t: "cadet" }]);
    gatewayDb.close();

    // The shared credentials step scrubs every working root — the whole
    // state-shaped scratch tree (it walks for keys.enc) plus the (here
    // empty) host cadet root.
    const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-host-"));
    const credentials = await migrateCredentialsStep([workRoot, hostRoot]);
    expect(credentials.status).toBe("completed");
    expect(credentials.summary).toContain("1 encrypted store(s)");
    const store = JSON.parse(
      await fs.readFile(path.join(workRoot, INSTANCE, "ces-security", "keys.enc"), "utf8"),
    );
    expect(Object.keys(store.entries)).toEqual(["credential/webhook/secret"]);
  });

  test("load imports the migrated trees into the cadet volumes under the migrated name", async () => {
    const sim = makeVolumeStore();
    const workRoot = await seededVolumes(sim);
    await fetchDockerVolumes({
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: [],
      workRoot,
    });
    await migrateAssistantDb([workRoot]);
    await migrateGatewayDb([workRoot]);
    const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-host-"));
    await migrateCredentialsStep([workRoot, hostRoot]);

    const result = await loadDockerVolumes({
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: [],
      workRoot,
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("1 docker instance(s)");

    // End state: the cadet-side volumes (migrated name) hold migrated data.
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

  test("verifyDockerVolumeData reports the migrated data clean", async () => {
    const sim = makeVolumeStore();
    const workRoot = await seededVolumes(sim);
    await fetchDockerVolumes({
      dockerOps: sim.ops,
      instances: [INSTANCE],
      images: [],
      workRoot,
    });
    await migrateAssistantDb([workRoot]);
    await migrateGatewayDb([workRoot]);
    // The credentials step is part of the pipeline too — without it the
    // ces-security tree still carries its vellum-namespace entry.
    const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-host-"));
    await migrateCredentialsStep([workRoot, hostRoot]);

    const verifyData = await verifyDockerVolumeData(workRoot);
    expect(verifyData.issues).toEqual([]);
    expect(verifyData.dbsChecked).toBe(2);
    expect(verifyData.storesChecked).toBe(1);
  });

  test("verifyDockerVolumeData surfaces leftover vellum rows and credentials as warnings", async () => {
    // Seed the extracted trees directly with branded data — as if the
    // shared value steps had not run (or a bug put legacy rows back).
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-"));
    const workspace = path.join(workRoot, INSTANCE, "workspace");
    const gateway = path.join(workRoot, INSTANCE, "gateway-security");
    const ces = path.join(workRoot, INSTANCE, "ces-security");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(gateway, { recursive: true });
    await fs.mkdir(ces, { recursive: true });
    await writeBrandedAssistantDb(workspace);
    await writeBrandedGatewayDb(gateway);
    await writeBrandedCredentialStore(ces);

    const verifyData = await verifyDockerVolumeData(workRoot);
    expect(verifyData.dbsChecked).toBe(2);
    expect(verifyData.storesChecked).toBe(1);
    const messages = verifyData.issues.map((i) => i.message);
    // Labels read under the MIGRATED name — the raw vellum- prefix is
    // stripped (v0.0.16 field feedback).
    expect(
      messages.some(
        (m) =>
          m.includes("still has") &&
          m.includes("vellum-branded row(s)") &&
          m.includes(`${MIGRATED}/workspace/data/db/assistant.db`),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes(`${MIGRATED}/gateway-security/gateway.sqlite`) &&
          m.includes("vellum-branded row(s)") &&
          // The breakdown names the offending tables/columns (v0.0.16).
          m.includes("contact_channels.type = 'vellum'"),
      ),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("ces-security/keys.enc") && m.includes("vellum-namespace credential")),
    ).toBe(true);
  });

  test("load without instances skips", async () => {
    const result = await loadDockerVolumes({
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => true,
      },
      instances: [],
      images: [],
      workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-")),
    });
    expect(result.status).toBe("skipped");
  });

  test("load with an unreachable daemon warns that the extracted data was not imported", async () => {
    const result = await loadDockerVolumes({
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {},
        dockerAvailable: async () => false,
      },
      instances: [INSTANCE],
      images: [],
      workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-")),
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("docker daemon unreachable");
    expect(result.issues?.some((i) => i.message.includes("were NOT migrated"))).toBe(true);
  });

  test("a failed import fails the step with an error issue", async () => {
    // v0.0.13 run feedback: a failed import used to be a warning and the
    // run ended "✔ Migration complete" with the cadet volumes incomplete.
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-work-"));
    await fs.mkdir(path.join(workRoot, INSTANCE, "workspace"), { recursive: true });
    const result = await loadDockerVolumes({
      dockerOps: {
        dockerVolumeToDir: async () => {},
        dockerDirToVolume: async () => {
          throw new Error("Command failed: docker volume create prime-quail-3ezfs4-workspace");
        },
        dockerAvailable: async () => true,
      },
      instances: [INSTANCE],
      images: [],
      workRoot,
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("volume import failed for 1 of 1 docker instance(s)");
    const error = (result.issues ?? []).find((i) => i.severity === "error");
    expect(error?.message).toContain("volume import failed");
  });
});

describe("findStateDbs — the one discovery both surfaces share", () => {
  test("finds dbs at the state-tree paths of every tree shape", async () => {
    // The value steps' discovery must agree across: the legacy cadet root
    // (state root at the top), the modern one (assistants/<name>/ nesting),
    // the docker scratch root (one state tree per assistant), and volume
    // content that kept a nested level.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-scan-"));
    const put = async (rel: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), "x");
    };
    await put("workspace/data/db/assistant.db"); // legacy cadet root
    await put("assistants/velly/workspace/data/db/assistant.db"); // modern root
    await put("vellum-prime-quail-3ezfs4/workspace/data/db/assistant.db"); // docker scratch
    await put("vellum-prime-quail-3ezfs4/gateway-security/gateway.sqlite");
    await put("vellum-prime-quail-3ezfs4/gateway-security/data/gateway.sqlite"); // nested volume level
    await put("assistants/velly/gateway-security/gateway.sqlite");
    await put("retired/velly/workspace/data/db/assistant.db"); // cold storage — skipped
    await put(".cadet-migration-backups/x/workspace/data/db/assistant.db"); // bookkeeping — skipped
    await put("workspace/data/db/assistant.db-wal"); // sidecar — folded by open, not a db

    const { assistantDbs, gatewayDbs } = await findStateDbs(root);
    expect(assistantDbs.sort()).toEqual([
      "assistants/velly/workspace/data/db/assistant.db",
      "vellum-prime-quail-3ezfs4/workspace/data/db/assistant.db",
      "workspace/data/db/assistant.db",
    ]);
    expect(gatewayDbs.sort()).toEqual([
      "assistants/velly/gateway-security/gateway.sqlite",
      "vellum-prime-quail-3ezfs4/gateway-security/data/gateway.sqlite",
      "vellum-prime-quail-3ezfs4/gateway-security/gateway.sqlite",
    ]);
  });

  test("a missing root scans as empty (unreachable daemon, nothing materialized)", async () => {
    const { assistantDbs, gatewayDbs } = await findStateDbs(
      path.join(os.tmpdir(), "vtc-scan-missing-" + Date.now()),
    );
    expect(assistantDbs).toEqual([]);
    expect(gatewayDbs).toEqual([]);
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
