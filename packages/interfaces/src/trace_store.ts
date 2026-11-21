import type {
  ChatMessage,
  EvolutionProposal,
  RunMetrics,
  Thread,
  UntrustedSourceTag,
} from "@harnex/protocol";

export interface TraceRunRecord {
  runId: string;
  threadId: string;
  domain: string;
  pinnedCommitSha: string;
  prompt: string;
  finalOutput: string;
  trajectoryMarkdown: string;
  touchedFiles: string[];
  metrics: RunMetrics;
  succeeded: boolean;
  hadHumanSteer: boolean;
  steerInstructions: string[];
  sourceTags: UntrustedSourceTag[];
  createdAt: string;
}

export interface RegressionCase {
  id: string;
  domain: string;
  prompt: string;
  expectedSignal: string;
  sourceFilesSnapshot: Record<string, string>;
  sizeBytes: number;
  createdAt: string;
}

export interface DomainHealthStats {
  domain: string;
  recentRuns: number;
  failureRate: number;
  consecutiveFailures: number;
  avgSteps: number;
}

export interface TraceStore {
  readonly schemaVersion: number;

  // Threads & messages
  upsertThread(thread: Thread): Promise<void>;
  getThread(threadId: string): Promise<Thread | null>;
  listThreads(): Promise<Thread[]>;
  deleteThread(threadId: string): Promise<void>;
  appendMessage(message: ChatMessage): Promise<void>;
  listMessages(threadId: string): Promise<ChatMessage[]>;

  // Run traces & domain health
  saveTraceRun(record: TraceRunRecord): Promise<void>;
  getTraceRun(runId: string): Promise<TraceRunRecord | null>;
  listTraceRunsByThread(threadId: string): Promise<TraceRunRecord[]>;
  getDomainHealth(domain: string, windowSize?: number): Promise<DomainHealthStats>;

  // Evolution proposals
  saveProposal(proposal: EvolutionProposal): Promise<void>;
  getProposal(proposalId: string): Promise<EvolutionProposal | null>;
  listProposals(includeArchived?: boolean): Promise<EvolutionProposal[]>;

  // Regression cases (bounded volume)
  appendRegressionCase(item: RegressionCase): Promise<void>;
  listRegressionCases(domain?: string, limit?: number): Promise<RegressionCase[]>;
}

export class InMemoryTraceStore implements TraceStore {
  public readonly schemaVersion = 1;
  private readonly threads = new Map<string, Thread>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly runs = new Map<string, TraceRunRecord>();
  private readonly proposals = new Map<string, EvolutionProposal>();
  private readonly regressionCases: RegressionCase[] = [];

  async upsertThread(thread: Thread): Promise<void> {
    this.threads.set(thread.id, { ...thread });
  }

  async getThread(threadId: string): Promise<Thread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async listThreads(): Promise<Thread[]> {
    return Array.from(this.threads.values());
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    this.messages.delete(threadId);
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const list = this.messages.get(message.threadId) ?? [];
    list.push({ ...message });
    this.messages.set(message.threadId, list);
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    return [...(this.messages.get(threadId) ?? [])];
  }

  async saveTraceRun(record: TraceRunRecord): Promise<void> {
    this.runs.set(record.runId, { ...record });
  }

  async getTraceRun(runId: string): Promise<TraceRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listTraceRunsByThread(threadId: string): Promise<TraceRunRecord[]> {
    return Array.from(this.runs.values()).filter((r) => r.threadId === threadId);
  }

  async getDomainHealth(domain: string, windowSize = 10): Promise<DomainHealthStats> {
    const domainRuns = Array.from(this.runs.values())
      .filter((r) => r.domain === domain)
      .slice(-windowSize);
    if (domainRuns.length === 0) {
      return { domain, recentRuns: 0, failureRate: 0, consecutiveFailures: 0, avgSteps: 0 };
    }
    const failures = domainRuns.filter((r) => !r.succeeded).length;
    let consecutiveFailures = 0;
    for (let i = domainRuns.length - 1; i >= 0; i--) {
      if (!domainRuns[i]?.succeeded) consecutiveFailures++;
      else break;
    }
    const avgSteps =
      domainRuns.reduce((acc, r) => acc + r.metrics.steps, 0) / domainRuns.length;
    return {
      domain,
      recentRuns: domainRuns.length,
      failureRate: failures / domainRuns.length,
      consecutiveFailures,
      avgSteps,
    };
  }

  async saveProposal(proposal: EvolutionProposal): Promise<void> {
    this.proposals.set(proposal.id, { ...proposal });
  }

  async getProposal(proposalId: string): Promise<EvolutionProposal | null> {
    return this.proposals.get(proposalId) ?? null;
  }

  async listProposals(includeArchived = false): Promise<EvolutionProposal[]> {
    return Array.from(this.proposals.values()).filter(
      (p) => includeArchived || p.status !== "archived_no_entry",
    );
  }

  async appendRegressionCase(item: RegressionCase): Promise<void> {
    this.regressionCases.push({ ...item });
  }

  async listRegressionCases(domain?: string, limit = 20): Promise<RegressionCase[]> {
    const filtered = domain
      ? this.regressionCases.filter((c) => c.domain === domain)
      : this.regressionCases;
    return filtered.slice(-limit);
  }
}
