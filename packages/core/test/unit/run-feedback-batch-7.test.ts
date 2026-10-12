import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { after, describe, test } from "node:test";

import { migrate } from "../../src/runner.js";
import { migrateAssistantDbAt, migrateGatewayDbAt } from "../../src/steps/migrate-assistant-db.js";
import { migrateLockfile } from "../../src/steps/migrate-lockfile.js";
import { runtimeVolumeNames, vellumVolumeNames } from "../../src/steps/migrate-docker-volumes.js";
import { gatherConfirmInfo } from "../../src/runner.js";
import { detect as detectStep } from "../../src/steps/detect.js";
import { EXIT_CODES, type ConfirmMigrationInfo, type DetectInfo, type ProcessOps } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { buildMinimal, cleanupFixtures } from "../helpers/build-fixture.js";

after(cleanupFixtures);

/** A contact_channels table with the REAL unique constraint (index_list on the live db pins it). */
async function writeContactChannelsTable(db: Database): Promise<void> {
  db.exec(`CREATE TABLE contact_channels (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    type TEXT NOT NULL,
    address TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    external_chat_id TEXT,
    updated_at INTEGER
  )`);
  db.exec(`CREATE UNIQUE INDEX idx_contact_channels_type_address ON contact_channels(type, address)`);
}

describe("contact_channels unique-collision dedupe (v0.0.15 field run)", () => {
  test("a cadet-spelled twin at the same address is merged away instead of aborting the UPDATE", async () => {
    // The field failure, reduced to its exact shape: the same address is
    // recorded twice — once under each brand spelling (the guardian
    // principal re-seed across the rebrand). The plain UPDATE collided
    // with the twin, the statement aborted, 0 rows were rewritten, and
    // every vellum row in the column survived to trip verify.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-dedupe-"));
    const dbRel = "workspace/data/db/assistant.db";
    await fs.mkdir(path.join(root, "workspace/data/db"), { recursive: true });
    const db = new Database(path.join(root, dbRel));
    await writeContactChannelsTable(db);
    db.exec(
      `INSERT INTO contact_channels (id, contact_id, type, address, created_at) VALUES
       ('vellum-row', 'contact-a', 'vellum', 'principal-123', 1),
       ('cadet-twin', 'contact-b', 'cadet', 'principal-123', 2),
       ('other-row',  'contact-a', 'vellum', 'other-principal', 3)`,
    );
    db.close();

    const result = await migrateAssistantDbAt(root, dbRel);
    expect(result.status).toBe("completed");
    // No warning: the collision was resolved, not skipped.
    expect(result.issues?.some((i) => i.severity === "warning")).toBe(false);
    // The merge is REPORTED.
    expect(
      result.issues?.some((i) => i.severity === "info" && i.message.includes("merged 1 duplicate row(s)")),
    ).toBe(true);

    const after = new Database(path.join(root, dbRel), { readOnly: true });
    const rows = after.prepare(`SELECT id, type, address FROM contact_channels ORDER BY id`).all() as Array<{
      id: string;
      type: string;
      address: string;
    }>;
    after.close();
    // The cadet twin WON (the renamed runtime seeded it and reads it); the
    // vellum row is gone; the non-colliding vellum row was rewritten.
    expect(rows).toEqual([
      { id: "cadet-twin", type: "cadet", address: "principal-123" },
      { id: "other-row", type: "cadet", address: "other-principal" },
    ]);
  });

  test("no twin — the plain update runs and nothing is merged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-dedupe-"));
    const dbRel = "workspace/data/db/assistant.db";
    await fs.mkdir(path.join(root, "workspace/data/db"), { recursive: true });
    const db = new Database(path.join(root, dbRel));
    await writeContactChannelsTable(db);
    db.exec(
      `INSERT INTO contact_channels (id, contact_id, type, address, created_at) VALUES
       ('row-1', 'contact-a', 'vellum', 'principal-9', 1)`,
    );
    db.close();

    const result = await migrateAssistantDbAt(root, dbRel);
    expect(result.status).toBe("completed");
    expect(result.issues?.some((i) => i.message.includes("merged"))).toBe(false);
    const after = new Database(path.join(root, dbRel), { readOnly: true });
    const rows = after.prepare(`SELECT type FROM contact_channels`).all();
    after.close();
    expect(rows).toEqual([{ type: "cadet" }]);
  });

  test("the gateway db's contact_channels copy gets the same dedupe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-dedupe-"));
    const dbRel = "gateway-security/gateway.sqlite";
    await fs.mkdir(path.join(root, "gateway-security"), { recursive: true });
    const db = new Database(path.join(root, dbRel));
    await writeContactChannelsTable(db);
    db.exec(
      `INSERT INTO contact_channels (id, contact_id, type, address, created_at) VALUES
       ('vellum-row', 'contact-a', 'vellum', 'principal-123', 1),
       ('cadet-twin', 'contact-b', 'cadet', 'principal-123', 2)`,
    );
    db.close();

    const result = await migrateGatewayDbAt(root, dbRel);
    expect(result.issues?.some((i) => i.severity === "warning")).toBe(false);
    const after = new Database(path.join(root, dbRel), { readOnly: true });
    const rows = after.prepare(`SELECT id, type FROM contact_channels ORDER BY id`).all();
    after.close();
    expect(rows).toEqual([{ id: "cadet-twin", type: "cadet" }]);
  });
});

describe("unreadable-db self-diagnosis (v0.0.15 field run)", () => {
  test("a db that cannot be opened names its absolute path and why", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-diagnose-"));
    // A DIRECTORY wearing the db's name — the EISDIR class.
    const dbRel = "workspace/data/db/assistant.db";
    await fs.mkdir(path.join(root, dbRel), { recursive: true });

    const result = await migrateAssistantDbAt(root, dbRel);
    expect(result.status).toBe("skipped");
    const warning = (result.issues ?? []).find((i) => i.severity === "warning");
    expect(warning?.message).toContain(path.join(root, dbRel));
    expect(warning?.message).toContain("it is a directory, not a sqlite file");
  });
});

describe("lockfile merge-and-replace (v0.0.15 field run)", () => {
  test("merges the vellum assistants into an existing cadet lockfile, replacing by id", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-home-"));
    const configDir = path.join(home, ".config", "cadet");
    await fs.mkdir(configDir, { recursive: true });
    const dest = path.join(configDir, "lockfile.json");
    // The live cadet lockfile: its own assistant + root identity fields.
    await fs.writeFile(
      dest,
      JSON.stringify({
        deviceId: "device-cadet-1",
        tokens: { access: "keep-me" },
        assistants: [{ assistantId: "cadet-own", name: "cadet-own", cloud: "local" }],
      }),
    );
    // The vellum lockfile: one assistant REPLACING a same-id entry, one NEW.
    await fs.writeFile(
      path.join(home, ".vellum.lock.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "vellum-prime-quail",
            name: "vellum-prime-quail",
            cloud: "docker",
            species: "cinderling",
            platformAssistantId: "pa_vellum_1",
          },
        ],
        activeAssistant: "vellum-prime-quail",
      }),
    );

    // The lockfile paths are env-pinned (read at call time).
    const prevHome = process.env.HOME;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    let result;
    try {
      result = await migrateLockfile({
        vellumRoot: path.join(home, ".vellum"),
        cadetRoot: path.join(home, ".local", "share", "cadet"),
        envSuffix: "",
        applyRenames: false,
        cadetImages: null,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    }

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("merged 1 assistant(s)");
    expect(result.issues?.some((i) => i.severity === "warning")).toBe(false);
    const merged = JSON.parse(await fs.readFile(dest, "utf8")) as {
      deviceId?: string;
      tokens?: unknown;
      assistants: Array<{ assistantId: string }>;
      activeAssistant?: string;
    };
    // The cadet lockfile's own root fields and assistant SURVIVE.
    expect(merged.deviceId).toBe("device-cadet-1");
    expect(merged.tokens).toEqual({ access: "keep-me" });
    expect(merged.assistants.map((a) => a.assistantId)).toContain("cadet-own");
    // The vellum assistant landed under its MIGRATED id.
    expect(merged.assistants.map((a) => a.assistantId)).toContain("prime-quail");
    expect(merged.assistants.map((a) => a.assistantId)).not.toContain("vellum-prime-quail");
    // The cadet lockfile had no active assistant — the vellum pick rides in.
    expect(merged.activeAssistant).toBe("prime-quail");
  });

  test("a corrupt destination lockfile is left alone with a warning", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vtc-home-"));
    const configDir = path.join(home, ".config", "cadet");
    await fs.mkdir(configDir, { recursive: true });
    const dest = path.join(configDir, "lockfile.json");
    await fs.writeFile(dest, "{ not json");
    await fs.writeFile(
      path.join(home, ".vellum.lock.json"),
      JSON.stringify({ assistants: [{ assistantId: "vellum-x", name: "vellum-x", cloud: "local" }] }),
    );

    const prevHome = process.env.HOME;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    let result;
    try {
      result = await migrateLockfile({
        vellumRoot: path.join(home, ".vellum"),
        cadetRoot: path.join(home, ".local", "share", "cadet"),
        envSuffix: "",
        applyRenames: false,
        cadetImages: null,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    }

    expect(result.summary).toContain("merge failed");
    expect(result.issues?.some((i) => i.severity === "warning" && i.message.includes("could not be merged"))).toBe(true);
    // Byte-identical: the corrupt file was NOT overwritten.
    expect(await fs.readFile(dest, "utf8")).toBe("{ not json");
  });
});

describe("volume naming", () => {
  test("runtime volumes are the three cadet hatch creates empty", () => {
    expect(runtimeVolumeNames("prime-quail-3ezfs4")).toEqual([
      "prime-quail-3ezfs4-socket",
      "prime-quail-3ezfs4-assistant-ipc",
      "prime-quail-3ezfs4-gateway-ipc",
    ]);
    expect(vellumVolumeNames("vellum-prime-quail-3ezfs4")).toEqual([
      "vellum-prime-quail-3ezfs4-workspace",
      "vellum-prime-quail-3ezfs4-gateway-sec",
      "vellum-prime-quail-3ezfs4-ces-sec",
    ]);
  });
});

describe("pre-migration confirmation", () => {
  test("gatherConfirmInfo counts assistants (migrated names), bytes, and volumes", async () => {
    const detect = {
      vellumRoot: "/fake/.vellum",
      cadetRoot: "/fake/.local/share/cadet",
      cadetRootExists: true,
      assistantHandles: ["vellum-prime-quail-3ezfs4"],
      retiredCount: 2,
      rootSizeBytes: 1500,
      docker: { instances: ["vellum-prime-quail-3ezfs4"], images: [] },
    } as unknown as DetectInfo;
    const sizes = new Map([["vellum-prime-quail-3ezfs4-workspace", 40e9]]);

    const info = await gatherConfirmInfo(detect, {
      dockerVolumeSize: async (volume: string) => sizes.get(volume),
    });

    expect(info.cadetRootExists).toBe(true);
    expect(info.assistants).toEqual([{ name: "prime-quail-3ezfs4", docker: true }]);
    expect(info.dockerVolumeCount).toBe(3);
    // Only the measured volume contributes; the unmeasured two yield null
    // only when NOTHING was measurable.
    expect(info.dockerVolumeBytes).toBe(40e9);
    expect(info.rootSizeBytes).toBe(1500);
    expect(info.retiredCount).toBe(2);
  });

  test("a declined confirmation exits notConfirmed with the vellum root untouched", async () => {
    const { root, home } = await buildMinimal();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    let prompted = 0;
    try {
      const report = await migrate({
        vellumRoot: root,
        cadetRoot: path.join(home, "cadet-out"),
        processOps: {
          vellumVersion: async () => null,
          find: async () => [],
          vellumSleep: async () => {},
          // detect + the confirm hook never reach the docker ops here (no
          // docker instances in the fixture) — the rest is dead weight the
          // ProcessOps contract demands.
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
        },
        confirm: async () => {
          prompted++;
          return false;
        },
      });
      expect(prompted).toBe(1);
      expect(report.exitCode).toBe(EXIT_CODES.notConfirmed);
      // Only detect ran — nothing mutated.
      expect(report.steps.map((s) => s.step)).toEqual(["detect"]);
      expect(await fs.readdir(root)).toContain("workspace");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("an accepted confirmation proceeds into the steps", async () => {
    const { root, home } = await buildMinimal();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const report = await migrate({
        vellumRoot: root,
        cadetRoot: path.join(home, "cadet-out"),
        processOps: {
          vellumVersion: async () => null,
          find: async () => [],
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
        },
        confirm: async (info: ConfirmMigrationInfo) => {
          // The prompt payload names the migrated instance and the root.
          expect(info.vellumRoot).toBe(root);
          return true;
        },
      });
      expect(report.ok).toBe(true);
      expect(report.steps.map((s) => s.step)).toContain("migrate-layout");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
