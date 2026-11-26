import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppConfigSchema, ProviderConfigSchema } from "@harnex/protocol";
import { SidecarSettings, reclaimFreePages } from "./settings.ts";

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".settings-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 2 });
  }
});

describe("SidecarSettings incremental auto-vacuum", () => {
  test("creates new settings DB with auto_vacuum = INCREMENTAL (2) and upgrades legacy mode-0 DBs", async () => {
    const dir = await tmpDir();
    const freshPath = join(dir, "fresh-settings.sqlite");
    const fresh = new SidecarSettings(freshPath);
    fresh.save(AppConfigSchema.parse({}), []);
    fresh.close();

    const inspectFresh = new Database(freshPath, { readonly: true });
    expect(inspectFresh.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(2);
    inspectFresh.close();

    // Legacy settings DB with auto_vacuum = 0
    const legacyPath = join(dir, "legacy-settings.sqlite");
    const legacy = new Database(legacyPath, { create: true });
    legacy.run("PRAGMA auto_vacuum = NONE");
    legacy.exec("CREATE TABLE sidecar_settings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)");
    const provider = ProviderConfigSchema.parse({
      id: "p-legacy",
      name: "Legacy",
      kind: "openai_compatible",
      baseUrl: "https://legacy.test/v1",
      keyringRef: "provider:p-legacy",
    });
    legacy.run("INSERT INTO sidecar_settings VALUES (1, ?)", [
      JSON.stringify({ config: AppConfigSchema.parse({}), providers: [provider] }),
    ]);
    expect(legacy.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(0);
    legacy.close();

    const upgraded = new SidecarSettings(legacyPath);
    try {
      const loaded = upgraded.load();
      expect(loaded.providers).toHaveLength(1);
      expect(loaded.providers[0]?.id).toBe("p-legacy");
      expect(upgraded.reclaimSpace()).toBe(0);
    } finally {
      upgraded.close();
    }

    const inspectLegacy = new Database(legacyPath, { readonly: true });
    expect(inspectLegacy.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(2);
    inspectLegacy.close();
  });

  test("reclaimFreePages steps PRAGMA incremental_vacuum(N) and returns reclaimed page count", () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA auto_vacuum = INCREMENTAL");
      db.run("CREATE TABLE blobs (id INTEGER PRIMARY KEY, body TEXT)");
      const blob = "X".repeat(5000);
      for (let i = 0; i < 20; i++) db.run("INSERT INTO blobs VALUES (?, ?)", [i, blob]);
      db.run("DELETE FROM blobs");
      const before = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
      expect(before).toBeGreaterThan(5);
      const reclaimed = reclaimFreePages(db, 256);
      expect(reclaimed).toBe(before);
      expect(db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count).toBe(0);
    } finally {
      db.close();
    }
  });
});
