import { Database } from "bun:sqlite";
import { AppConfigSchema, ProviderConfigSchema, type AppConfig, type ProviderConfig } from "@harnex/protocol";
import { z } from "zod";

const stateSchema = z.object({ config: AppConfigSchema, providers: z.array(ProviderConfigSchema) });

export class SidecarSettings {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS sidecar_settings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)");
  }

  load(): z.infer<typeof stateSchema> {
    const stored = this.db.query<{ body: string }, []>("SELECT body FROM sidecar_settings WHERE id = 1").get();
    return stateSchema.parse(stored ? JSON.parse(stored.body) : { config: {}, providers: [] });
  }

  save(config: AppConfig, providers: ProviderConfig[]): void {
    const body = JSON.stringify(stateSchema.parse({ config, providers }));
    this.db.run("INSERT INTO sidecar_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", [body]);
  }

  close(): void { this.db.close(); }
}
