import { Database } from "bun:sqlite";
import type { DomainHealthStats, RegressionCase, TraceRunRecord, TraceStore } from "@harnex/interfaces";
import type { ChatMessage, EvolutionProposal, Thread } from "@harnex/protocol";

const migrations = [
  `CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, domain TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE regression_cases (id TEXT PRIMARY KEY, domain TEXT NOT NULL, body TEXT NOT NULL);`,
  `CREATE INDEX messages_thread ON messages(thread_id);
   CREATE INDEX runs_thread ON runs(thread_id, created_at);
   CREATE INDEX runs_domain ON runs(domain, created_at);
   CREATE INDEX regression_cases_domain ON regression_cases(domain);`,
] as const;

const boundedLimit = (limit: number) => Number.isFinite(limit) ? Math.min(10_000, Math.max(0, Math.trunc(limit))) : 0;

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

export class SqliteTraceStore implements TraceStore {
  readonly schemaVersion: number;
  private readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.run("PRAGMA busy_timeout = 5000");
      configureIncrementalAutoVacuum(this.db, path === ":memory:");
      this.schemaVersion = this.db.transaction(() => {
        this.db.run("CREATE TABLE IF NOT EXISTS schemaVersion (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
        const { version } = this.db.query<{ version: number }, []>("SELECT coalesce(max(version), 0) AS version FROM schemaVersion").get()!;
        if (version > migrations.length) throw new Error(`Unsupported trace schema version: ${version}`);
        for (let i = version; i < migrations.length; i++) {
          this.db.exec(migrations[i]!);
          this.db.run("INSERT INTO schemaVersion VALUES (?, ?)", [i + 1, new Date().toISOString()]);
        }
        return migrations.length;
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  reclaimSpace(maxPages = 256): number {
    return reclaimFreePages(this.db, maxPages);
  }

  private one<T>(sql: string, id: string): T | null {
    const row = this.db.query<{ body: string }, [string]>(sql).get(id);
    return row ? JSON.parse(row.body) as T : null;
  }

  private many<T>(sql: string, ...params: (string | number)[]): T[] {
    return this.db.query<{ body: string }, (string | number)[]>(sql).all(...params).map((row) => JSON.parse(row.body) as T);
  }

  async upsertThread(thread: Thread): Promise<void> {
    this.db.run(`INSERT INTO threads VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body`,
      [thread.id, thread.updatedAt, JSON.stringify(thread)]);
  }

  async getThread(threadId: string): Promise<Thread | null> { return this.one("SELECT body FROM threads WHERE id = ?", threadId); }
  async listThreads(): Promise<Thread[]> { return this.many("SELECT body FROM threads ORDER BY updated_at DESC, rowid DESC"); }

  async deleteThread(threadId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
      this.db.run("DELETE FROM runs WHERE thread_id = ?", [threadId]);
      this.db.run("DELETE FROM threads WHERE id = ?", [threadId]);
    })();
    reclaimFreePages(this.db, 256);
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const sanitized: ChatMessage = message.attachments?.length
      ? {
          ...message,
          attachments: message.attachments.map(({ id, name, mimeType, sizeBytes, width, height }) => ({
            id,
            name,
            mimeType,
            sizeBytes,
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
          })),
        }
      : message;
    this.db.run("INSERT INTO messages VALUES (?, ?, ?)", [sanitized.id, sanitized.threadId, JSON.stringify(sanitized)]);
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    return this.many("SELECT body FROM messages WHERE thread_id = ? ORDER BY rowid", threadId);
  }

  async saveTraceRun(record: TraceRunRecord): Promise<void> {
    this.db.run(`INSERT INTO runs VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id, domain = excluded.domain, created_at = excluded.created_at, body = excluded.body`,
    [record.runId, record.threadId, record.domain, record.createdAt, JSON.stringify(record)]);
  }

  async getTraceRun(runId: string): Promise<TraceRunRecord | null> { return this.one("SELECT body FROM runs WHERE id = ?", runId); }

  async listTraceRunsByThread(threadId: string): Promise<TraceRunRecord[]> {
    return this.many("SELECT body FROM runs WHERE thread_id = ? ORDER BY created_at, rowid", threadId);
  }

  async getDomainHealth(domain: string, windowSize = 10): Promise<DomainHealthStats> {
    const runs = this.many<TraceRunRecord>("SELECT body FROM runs WHERE domain = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      domain, boundedLimit(windowSize));
    const firstSuccess = runs.findIndex((run) => run.succeeded);
    return {
      domain, recentRuns: runs.length,
      failureRate: runs.filter((run) => !run.succeeded).length / (runs.length || 1),
      consecutiveFailures: firstSuccess < 0 ? runs.length : firstSuccess,
      avgSteps: runs.reduce((sum, run) => sum + run.metrics.steps, 0) / (runs.length || 1),
    };
  }

  async saveProposal(proposal: EvolutionProposal): Promise<void> {
    this.db.run(`INSERT INTO proposals VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body`,
      [proposal.id, proposal.status, JSON.stringify(proposal)]);
  }

  async getProposal(proposalId: string): Promise<EvolutionProposal | null> { return this.one("SELECT body FROM proposals WHERE id = ?", proposalId); }

  async listProposals(includeArchived = false): Promise<EvolutionProposal[]> {
    return this.many("SELECT body FROM proposals WHERE (? OR status <> 'archived_no_entry') ORDER BY rowid", includeArchived ? 1 : 0);
  }

  async appendRegressionCase(item: RegressionCase): Promise<void> {
    const body = JSON.stringify(item);
    if (item.sizeBytes > 1_000_000 || Buffer.byteLength(body) > 1_000_000) throw new Error("Regression case exceeds 1 MB");
    this.db.transaction(() => {
      this.db.run("INSERT INTO regression_cases VALUES (?, ?, ?)", [item.id, item.domain, body]);
      this.db.run("DELETE FROM regression_cases WHERE rowid IN (SELECT rowid FROM regression_cases ORDER BY rowid DESC LIMIT -1 OFFSET 200)");
    })();
  }

  async listRegressionCases(domain?: string, limit = 20): Promise<RegressionCase[]> {
    const items = domain ? this.many<RegressionCase>("SELECT body FROM regression_cases WHERE domain = ? ORDER BY rowid DESC LIMIT ?", domain, boundedLimit(limit)) :
      this.many<RegressionCase>("SELECT body FROM regression_cases ORDER BY rowid DESC LIMIT ?", boundedLimit(limit));
    return items.reverse();
  }

  async exportJsonl(threadId?: string): Promise<string> {
    const rows = threadId ? await this.listTraceRunsByThread(threadId) : this.many<TraceRunRecord>("SELECT body FROM runs ORDER BY created_at, rowid");
    return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  }
}
