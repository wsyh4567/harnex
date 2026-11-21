import type {
  ApprovalDecision,
  ApprovalRequest,
  BudgetStatus,
  EvolutionEvent,
  ExecDeleteFileIntent,
  ExecHookIntent,
  ExecResult,
  ExecScriptIntent,
  ExecShellIntent,
  ExecWriteFileIntent,
  GenomeCommit,
  GitCommitPatchParams,
  GitCommitPatchResult,
  GuardianDecision,
  RunnerEvent,
  SecurityEvent,
  TokenUsage,
} from "@harnex/protocol";
import { IMMUTABLE_L0_PATH_PATTERNS } from "@harnex/protocol";

export interface BudgetCheckResult {
  allowed: boolean;
  status: BudgetStatus;
  reason?: string;
}

export type HarnexBridgeEvent = RunnerEvent | SecurityEvent | EvolutionEvent;

/**
 * Frozen contract between TS Sidecar (runtime + evolution) and Rust L0 executor.
 * TS NEVER executes writes, shells, scripts, hooks, or Git commits directly on disk.
 */
export interface RustBridge {
  // L0 side-effect executors
  execWriteFile(intent: ExecWriteFileIntent): Promise<ExecResult>;
  execDeleteFile(intent: ExecDeleteFileIntent): Promise<ExecResult>;
  execShell(intent: ExecShellIntent): Promise<ExecResult>;
  execScript(intent: ExecScriptIntent): Promise<ExecResult>;
  execHook(intent: ExecHookIntent): Promise<ExecResult>;

  // L0 Git (single writer via libgit2)
  gitHeadSha(): Promise<string>;
  gitLog(limit?: number): Promise<GenomeCommit[]>;
  gitReadTree(commitSha: string): Promise<Record<string, string>>;
  gitCommitPatch(params: GitCommitPatchParams): Promise<GitCommitPatchResult>;
  gitRevert(targetSha: string, reason: string): Promise<GitCommitPatchResult>;

  // L0 Budget & Keyring
  checkBudget(estimatedCostUsd?: number): Promise<BudgetCheckResult>;
  recordUsage(modelId: string, usage: TokenUsage): Promise<BudgetStatus>;
  keyringGet(keyringRef: string): Promise<string | null>;

  // L0 Approval & Guardian
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  guardianReview(request: ApprovalRequest): Promise<GuardianDecision>;

  // Event emission to Desktop UI
  emitEvent(event: HarnexBridgeEvent): void;
}

export interface RecordedBridgeCall {
  method: string;
  payload: unknown;
}

export class MockRustBridge implements RustBridge {
  public readonly recordedCalls: RecordedBridgeCall[] = [];
  public readonly emittedEvents: HarnexBridgeEvent[] = [];
  public readonly virtualFiles = new Map<string, string>();
  public readonly commits = new Map<string, { commit: GenomeCommit; tree: Record<string, string> }>();
  public headSha = "0000000000000000000000000000000000000001";
  public budgetLimitUsd = 5.0;
  public spentTodayUsd = 0.0;
  public tokensToday = 0;
  public budgetTripped = false;
  public defaultApproval: ApprovalDecision = "allow_once";
  public trustedHookHashes = new Map<string, string>();
  public secrets = new Map<string, string>();
  public shellHandler?: (intent: ExecShellIntent) => ExecResult | Promise<ExecResult>;
  public scriptHandler?: (intent: ExecScriptIntent) => ExecResult | Promise<ExecResult>;

  constructor(initialTree: Record<string, string> = {}) {
    this.commits.set(this.headSha, {
      commit: {
        sha: this.headSha,
        versionTag: "v0",
        message: "Initial harness seed",
        timestamp: new Date(0).toISOString(),
        changedComponents: [],
        isRollback: false,
      },
      tree: { ...initialTree },
    });
  }

  private assertNotImmutable(targetPath: string): string | null {
    const norm = targetPath.replace(/\\/g, "/");
    for (const pat of IMMUTABLE_L0_PATH_PATTERNS) {
      if (norm === pat || norm.startsWith(pat) || norm.includes(`/${pat}`)) {
        return `Blocked by L0 immutable guard: ${targetPath}`;
      }
    }
    return null;
  }

  async execWriteFile(intent: ExecWriteFileIntent): Promise<ExecResult> {
    this.recordedCalls.push({ method: "execWriteFile", payload: intent });
    const violation = this.assertNotImmutable(intent.targetPath);
    if (violation) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: violation,
        durationMs: 1,
        sandboxBackend: "mock-sandbox",
        deniedReason: violation,
      };
    }
    this.virtualFiles.set(intent.targetPath, intent.content);
    return {
      ok: true,
      exitCode: 0,
      stdout: `wrote ${intent.targetPath}`,
      stderr: "",
      durationMs: 1,
      sandboxBackend: "mock-sandbox",
    };
  }

  async execDeleteFile(intent: ExecDeleteFileIntent): Promise<ExecResult> {
    this.recordedCalls.push({ method: "execDeleteFile", payload: intent });
    const violation = this.assertNotImmutable(intent.targetPath);
    if (violation) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: violation,
        durationMs: 1,
        sandboxBackend: "mock-sandbox",
        deniedReason: violation,
      };
    }
    this.virtualFiles.delete(intent.targetPath);
    return {
      ok: true,
      exitCode: 0,
      stdout: `deleted ${intent.targetPath}`,
      stderr: "",
      durationMs: 1,
      sandboxBackend: "mock-sandbox",
    };
  }

  async execShell(intent: ExecShellIntent): Promise<ExecResult> {
    this.recordedCalls.push({ method: "execShell", payload: intent });
    if (this.shellHandler) {
      return await this.shellHandler(intent);
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: `mock-shell:${intent.command} ${intent.args.join(" ")}`.trim(),
      stderr: "",
      durationMs: 2,
      sandboxBackend: "mock-sandbox",
    };
  }

  async execScript(intent: ExecScriptIntent): Promise<ExecResult> {
    this.recordedCalls.push({ method: "execScript", payload: intent });
    if (this.scriptHandler) {
      return await this.scriptHandler(intent);
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: `mock-script:${intent.scriptPath}`,
      stderr: "",
      durationMs: 2,
      sandboxBackend: "mock-sandbox",
    };
  }

  async execHook(intent: ExecHookIntent): Promise<ExecResult> {
    this.recordedCalls.push({ method: "execHook", payload: intent });
    if (!this.trustedHookHashes.has(intent.hookPath)) {
      return {
        ok: false,
        exitCode: 126,
        stdout: "",
        stderr: `Untrusted hook: ${intent.hookPath}`,
        durationMs: 1,
        sandboxBackend: "mock-sandbox",
        deniedReason: "hook_untrusted",
      };
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ decision: "allow" }),
      stderr: "",
      durationMs: 1,
      sandboxBackend: "mock-sandbox",
    };
  }

  async gitHeadSha(): Promise<string> {
    return this.headSha;
  }

  async gitLog(limit = 50): Promise<GenomeCommit[]> {
    return Array.from(this.commits.values())
      .map((entry) => entry.commit)
      .reverse()
      .slice(0, limit);
  }

  async gitReadTree(commitSha: string): Promise<Record<string, string>> {
    const entry = this.commits.get(commitSha);
    if (!entry) {
      throw new Error(`Unknown commit SHA: ${commitSha}`);
    }
    return { ...entry.tree };
  }

  async gitCommitPatch(params: GitCommitPatchParams): Promise<GitCommitPatchResult> {
    this.recordedCalls.push({ method: "gitCommitPatch", payload: params });
    for (const op of params.operations) {
      const violation = this.assertNotImmutable(op.path);
      if (violation) {
        return { ok: false, conflict: false, conflictingFiles: [], error: violation };
      }
    }
    const baseEntry = this.commits.get(params.baseCommitSha);
    if (!baseEntry) {
      return {
        ok: false,
        conflict: false,
        conflictingFiles: [],
        error: `Unknown baseCommitSha: ${params.baseCommitSha}`,
      };
    }
    const nextTree = { ...baseEntry.tree };
    for (const op of params.operations) {
      if (op.op === "delete") {
        delete nextTree[op.path];
      } else {
        nextTree[op.path] = op.content ?? "";
      }
    }
    const nextNum = this.commits.size + 1;
    const nextSha = nextNum.toString(16).padStart(40, "0");
    this.commits.set(nextSha, {
      commit: {
        sha: nextSha,
        parentSha: this.headSha,
        versionTag: `v${nextNum - 1}`,
        message: params.message,
        timestamp: new Date().toISOString(),
        domain: params.domain,
        changedComponents: [],
        isRollback: false,
      },
      tree: nextTree,
    });
    this.headSha = nextSha;
    return { ok: true, newCommitSha: nextSha, conflict: false, conflictingFiles: [] };
  }

  async gitRevert(targetSha: string, reason: string): Promise<GitCommitPatchResult> {
    this.recordedCalls.push({ method: "gitRevert", payload: { targetSha, reason } });
    const target = this.commits.get(targetSha);
    if (!target) {
      return { ok: false, conflict: false, conflictingFiles: [], error: `Unknown SHA: ${targetSha}` };
    }
    const nextNum = this.commits.size + 1;
    const nextSha = nextNum.toString(16).padStart(40, "0");
    this.commits.set(nextSha, {
      commit: {
        sha: nextSha,
        parentSha: this.headSha,
        versionTag: `v${nextNum - 1}`,
        message: `Revert to ${targetSha}: ${reason}`,
        timestamp: new Date().toISOString(),
        changedComponents: [],
        isRollback: true,
      },
      tree: { ...target.tree },
    });
    this.headSha = nextSha;
    return { ok: true, newCommitSha: nextSha, conflict: false, conflictingFiles: [] };
  }

  async checkBudget(estimatedCostUsd = 0): Promise<BudgetCheckResult> {
    const projected = this.spentTodayUsd + estimatedCostUsd;
    const tripped = this.budgetTripped || projected > this.budgetLimitUsd;
    return {
      allowed: !tripped,
      status: {
        dailyLimitUsd: this.budgetLimitUsd,
        spentTodayUsd: this.spentTodayUsd,
        tokensToday: this.tokensToday,
        tripped,
        pricingTable: [],
      },
      reason: tripped ? "Daily budget limit exceeded" : undefined,
    };
  }

  async recordUsage(_modelId: string, usage: TokenUsage): Promise<BudgetStatus> {
    this.spentTodayUsd += usage.costUsd;
    this.tokensToday += usage.inputTokens + usage.outputTokens;
    if (this.spentTodayUsd > this.budgetLimitUsd) {
      this.budgetTripped = true;
    }
    return {
      dailyLimitUsd: this.budgetLimitUsd,
      spentTodayUsd: this.spentTodayUsd,
      tokensToday: this.tokensToday,
      tripped: this.budgetTripped,
      pricingTable: [],
    };
  }

  async keyringGet(keyringRef: string): Promise<string | null> {
    return this.secrets.get(keyringRef) ?? null;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.recordedCalls.push({ method: "requestApproval", payload: request });
    return this.defaultApproval;
  }

  async guardianReview(request: ApprovalRequest): Promise<GuardianDecision> {
    this.recordedCalls.push({ method: "guardianReview", payload: request });
    return {
      requestId: request.requestId,
      threadId: request.threadId,
      decision: request.riskLevel === "low" ? "allow" : "escalate",
      riskLevel: request.riskLevel,
      reason: "Mock guardian evaluation",
      commandOrPath: request.commandOrPath,
      modelId: "mock-guardian",
      sanitizedInputOnly: true,
      timestamp: new Date().toISOString(),
    };
  }

  emitEvent(event: HarnexBridgeEvent): void {
    this.emittedEvents.push(event);
  }
}
