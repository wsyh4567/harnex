import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChatMessageSchema, ThreadSchema, type ChatMessage } from "@harnex/protocol";
import { SqliteTraceStore, reclaimFreePages } from "./sqlite.ts";

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".sqlite-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 2 });
  }
});

describe("SqliteTraceStore incremental auto-vacuum & attachment safety", () => {
  test("initializes new DBs with auto_vacuum = INCREMENTAL (2) and migrates legacy DBs from mode 0", async () => {
    const dir = await tmpDir();
    const freshPath = join(dir, "fresh.sqlite");
    const store = new SqliteTraceStore(freshPath);
    store.close();

    const inspectFresh = new Database(freshPath, { readonly: true });
    expect(inspectFresh.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(2);
    inspectFresh.close();

    // Create a legacy DB explicitly with auto_vacuum = NONE (0) and existing data
    const legacyPath = join(dir, "legacy.sqlite");
    const legacy = new Database(legacyPath, { create: true });
    legacy.run("PRAGMA auto_vacuum = NONE");
    legacy.exec(`
      CREATE TABLE schemaVersion (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schemaVersion VALUES (1, '2026-01-01T00:00:00Z');
      CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, domain TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE regression_cases (id TEXT PRIMARY KEY, domain TEXT NOT NULL, body TEXT NOT NULL);
    `);
    const thread = ThreadSchema.parse({
      id: "legacy-thread",
      workspacePath: "/work",
      title: "Legacy",
      mode: "ask",
      status: "idle",
      pinnedCommitSha: "a".repeat(40),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    legacy.run("INSERT INTO threads VALUES (?, ?, ?)", [thread.id, thread.updatedAt, JSON.stringify(thread)]);
    expect(legacy.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(0);
    legacy.close();

    const migrated = new SqliteTraceStore(legacyPath);
    try {
      expect(await migrated.getThread("legacy-thread")).toMatchObject({ title: "Legacy" });
    } finally {
      migrated.close();
    }

    const inspectLegacy = new Database(legacyPath, { readonly: true });
    expect(inspectLegacy.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(2);
    inspectLegacy.close();
  });

  test("reclaims freed pages via incremental_vacuum on deleteThread and reclaimSpace", async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, "reclaim.sqlite");
    const store = new SqliteTraceStore(dbPath);
    const at = "2026-11-26T00:00:00Z";

    try {
      const thread = ThreadSchema.parse({
        id: "big-thread",
        workspacePath: "/work",
        title: "Large Thread",
        mode: "craft",
        status: "completed",
        pinnedCommitSha: "b".repeat(40),
        createdAt: at,
        updatedAt: at,
      });
      await store.upsertThread(thread);

      // Write ~200 KB of messages so SQLite allocates many pages
      const payload = "A".repeat(4000);
      for (let i = 0; i < 60; i++) {
        await store.appendMessage({
          id: `msg-${i}`,
          threadId: "big-thread",
          role: "assistant",
          content: payload,
          createdAt: at,
        });
      }

      const beforeDelete = new Database(dbPath, { readonly: true });
      const pagesBefore = beforeDelete.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
      beforeDelete.close();
      expect(pagesBefore).toBeGreaterThan(40);

      // deleteThread triggers reclaimFreePages(this.db, 256)
      await store.deleteThread("big-thread");

      const afterDelete = new Database(dbPath, { readonly: true });
      const pagesAfter = afterDelete.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
      const freelistAfter = afterDelete.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
      afterDelete.close();

      expect(pagesAfter).toBeLessThan(pagesBefore);
      expect(freelistAfter).toBe(0);
      expect(store.reclaimSpace(64)).toBe(0);
    } finally {
      store.close();
    }

    // Verify bounded reclaimFreePages helper directly steps incremental_vacuum(N)
    const directDb = new Database(":memory:");
    try {
      directDb.run("PRAGMA auto_vacuum = INCREMENTAL");
      directDb.run("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)");
      const chunk = "Z".repeat(5000);
      for (let i = 0; i < 30; i++) directDb.run("INSERT INTO items VALUES (?, ?)", [i, chunk]);
      directDb.run("DELETE FROM items");
      const freeBefore = directDb.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
      expect(freeBefore).toBeGreaterThan(10);
      const reclaimed1 = reclaimFreePages(directDb, 5);
      expect(reclaimed1).toBe(5);
      const reclaimed2 = reclaimFreePages(directDb, 256);
      expect(reclaimed2).toBe(freeBefore - 5);
      expect(directDb.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count).toBe(0);
    } finally {
      directDb.close();
    }
  });

  test("appendMessage defensively strips dataBase64 from attachments before persisting", async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, "strip.sqlite");
    const store = new SqliteTraceStore(dbPath);
    const secretBase64 = "SUPER_LARGE_BASE64_PAYLOAD_SHOULD_NEVER_BE_STORED_IN_SQLITE";

    try {
      // Simulate accidental cast where a MessageAttachmentInput with dataBase64 is passed into appendMessage
      const dirtyMessage = {
        id: "msg-att",
        threadId: "t-att",
        role: "user",
        content: "See screenshot",
        attachments: [
          {
            id: "att-1",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            width: 800,
            height: 600,
            dataBase64: secretBase64,
          },
        ],
        createdAt: "2026-11-26T00:00:00Z",
      } as unknown as ChatMessage;

      await store.appendMessage(dirtyMessage);
      const stored = await store.listMessages("t-att");
      expect(stored).toHaveLength(1);
      const parsed = ChatMessageSchema.parse(stored[0]);
      expect(parsed.attachments).toEqual([
        {
          id: "att-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          width: 800,
          height: 600,
        },
      ]);
      expect(JSON.stringify(stored[0])).not.toContain("dataBase64");
      expect(JSON.stringify(stored[0])).not.toContain(secretBase64);
    } finally {
      store.close();
    }

    const rawBytes = await readFile(dbPath);
    expect(rawBytes.includes(Buffer.from(secretBase64))).toBe(false);
  });
});
