import type {
  ExecutionMode,
  RunMetrics,
  SideChatAskResult,
  UntrustedSourceTag,
} from "@harnex/protocol";
import type { HarnessTree } from "./harness_store.ts";

export interface TaskRunRequest {
  threadId: string;
  workspacePath: string;
  prompt: string;
  mode: ExecutionMode;
  domain: string;
  pinnedCommitSha: string;
  /** Optional shadow override tree used by CoW probing / replay comparison */
  overrideHarnessTree?: HarnessTree;
  /** When true, external side effects run in dry-run mock mode */
  dryRunShadow?: boolean;
  providerIdOverride?: string;
  modelOverride?: string;
}

export interface TaskRunResult {
  runId: string;
  succeeded: boolean;
  delivered: boolean;
  finalOutput: string;
  trajectoryMarkdown: string;
  deliverables: Record<string, string>;
  touchedFiles: string[];
  metrics: RunMetrics;
  hadHumanSteer: boolean;
  steerInstructions: string[];
  sourceTags: UntrustedSourceTag[];
  error?: string;
}

export interface TaskRunner {
  runTask(request: TaskRunRequest): Promise<TaskRunResult>;
  pause(threadId: string): Promise<void>;
  steer(threadId: string, instruction: string): Promise<void>;
  resume(threadId: string): Promise<void>;
  abort(threadId: string): Promise<void>;
  askSideChat(threadId: string, question: string): Promise<SideChatAskResult>;
}

export type MockTaskRunHandler = (
  request: TaskRunRequest,
  callIndex: number,
) => TaskRunResult | Promise<TaskRunResult>;

export class MockTaskRunner implements TaskRunner {
  public readonly runs: TaskRunRequest[] = [];
  public readonly pausedThreads = new Set<string>();
  public readonly steers = new Map<string, string[]>();
  private handler: MockTaskRunHandler;

  constructor(handler?: MockTaskRunHandler) {
    this.handler =
      handler ??
      ((req, idx) => ({
        runId: `mock-run-${idx + 1}`,
        succeeded: true,
        delivered: true,
        finalOutput: `Mock output for: ${req.prompt}`,
        trajectoryMarkdown: `[ACTION] Process task\n[OBSERVATION] Completed ${req.prompt}`,
        deliverables: { "output.txt": `Mock output for: ${req.prompt}` },
        touchedFiles: [],
        metrics: {
          steps: 2,
          errors: 0,
          durationMs: 120,
          tokens: 300,
          costUsd: 0.002,
        },
        hadHumanSteer: false,
        steerInstructions: [],
        sourceTags: ["local"],
      }));
  }

  setHandler(handler: MockTaskRunHandler): void {
    this.handler = handler;
  }

  async runTask(request: TaskRunRequest): Promise<TaskRunResult> {
    const idx = this.runs.length;
    this.runs.push(request);
    return await this.handler(request, idx);
  }

  async pause(threadId: string): Promise<void> {
    this.pausedThreads.add(threadId);
  }

  async steer(threadId: string, instruction: string): Promise<void> {
    const list = this.steers.get(threadId) ?? [];
    list.push(instruction);
    this.steers.set(threadId, list);
  }

  async resume(threadId: string): Promise<void> {
    this.pausedThreads.delete(threadId);
  }

  async abort(threadId: string): Promise<void> {
    this.pausedThreads.delete(threadId);
  }

  async askSideChat(threadId: string, question: string): Promise<SideChatAskResult> {
    return {
      answer: `Side-chat (${threadId}): ${question}`,
      usage: {
        inputTokens: 50,
        outputTokens: 30,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.0005,
      },
      isolatedFromMainTrace: true,
    };
  }
}
