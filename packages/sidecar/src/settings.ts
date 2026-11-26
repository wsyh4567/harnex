import { Database } from "bun:sqlite";
import { AppConfigSchema, ProviderConfigSchema, type AppConfig, type ProviderConfig } from "@harnex/protocol";
import { z } from "zod";

const stateSchema = z.object({ config: AppConfigSchema, providers: z.array(ProviderConfigSchema) });

function configureIncrementalAutoVacuum(db: Database, isMemory: boolean): void {
  const mode = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum ?? 0;
  if (mode === 2) return;
  const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  try {
    db.run("PRAGMA auto_vacuum = INCREMENTAL");
    if (!isMemory && pageCount > 0) {
      db.run("VACUUM");
    }
  } catch {
    // Busy or read-only DB: skip one-time VACUUM rather than crashing startup.
  }
}

export function reclaimFreePages(db: Database, maxPages = 256): number {
  const limit = Number.isFinite(maxPages) ? Math.max(0, Math.trunc(maxPages)) : 0;
  if (limit <= 0) return 0;
  try {
    const mode = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum ?? 0;
    if (mode !== 2) return 0;
    const before = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
    if (before <= 0) return 0;
    db.query(`PRAGMA incremental_vacuum(${limit})`).all();
    const after = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
    return Math.max(0, before - after);
  } catch {
    return 0;
  }
}

export class SidecarSettings {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.run("PRAGMA busy_timeout = 5000");
      configureIncrementalAutoVacuum(this.db, path === ":memory:");
      this.db.exec("CREATE TABLE IF NOT EXISTS sidecar_settings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  load(): z.infer<typeof stateSchema> {
    const stored = this.db.query<{ body: string }, []>("SELECT body FROM sidecar_settings WHERE id = 1").get();
    return stateSchema.parse(stored ? JSON.parse(stored.body) : { config: {}, providers: [] });
  }

  save(config: AppConfig, providers: ProviderConfig[]): void {
    const body = JSON.stringify(stateSchema.parse({ config, providers }));
    this.db.run("INSERT INTO sidecar_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", [body]);
  }

  reclaimSpace(maxPages = 256): number {
    return reclaimFreePages(this.db, maxPages);
  }

  close(): void { this.db.close(); }
}
