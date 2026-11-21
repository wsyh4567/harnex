import { describe, expect, test } from "bun:test";
import {
  BudgetStatusSchema,
  EvolutionProposalSchema,
  ExecHookIntentSchema,
  isHighPrivilegeHarnessPath,
  JsonRpcRequestSchema,
  OnboardingReplayTraceSchema,
  PROTOCOL_VERSION,
  RunnerEventSchema,
  ThreadSchema,
  TokenUsageSchema,
} from "../src/index.ts";

describe("@harnex/protocol frozen schemas", () => {
  test("billing telemetry accepts legacy payloads and retains optional usage and budget fields", () => {
    const legacyUsage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 5, reasoningTokens: 2, costUsd: 0.01 };
    expect(TokenUsageSchema.parse(legacyUsage)).toEqual(legacyUsage);
    const actual = { ...legacyUsage, upstreamCostUsd: 0.01 };
    expect(TokenUsageSchema.parse(actual)).toEqual(actual);
    const legacyBudget = { dailyLimitUsd: 5, spentTodayUsd: 0.01, tokensToday: 55, tripped: false, pricingTable: [] };
    expect(BudgetStatusSchema.parse(legacyBudget)).toEqual(legacyBudget);
    const transparent = { ...legacyBudget, costSource: "mixed" as const, unpricedTokensToday: 25, unpricedModelsToday: ["vendor/unknown"] };
    expect(BudgetStatusSchema.parse(transparent)).toEqual(transparent);
  });

  test("exports protocol version and validates JSON-RPC 2.0 request", () => {
    expect(PROTOCOL_VERSION).toBe("1.0.0");
    const parsed = JsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "runner.start",
      params: { threadId: "t1", prompt: "hello" },
    });
    expect(parsed.method).toBe("runner.start");
  });

  test("identifies high-privilege harness paths", () => {
    expect(isHighPrivilegeHarnessPath("scripts/safe_gbk_parse.ts")).toBe(true);
    expect(isHighPrivilegeHarnessPath("hooks/example_trim_output.ts")).toBe(true);
    expect(isHighPrivilegeHarnessPath("mcp/servers.json")).toBe(true);
    expect(isHighPrivilegeHarnessPath("systemprompt.md")).toBe(true);
    expect(isHighPrivilegeHarnessPath("guardrails.md")).toBe(true);
    expect(isHighPrivilegeHarnessPath("memory/LongTermMEMORY.md")).toBe(false);
    expect(isHighPrivilegeHarnessPath("tool_descriptions/shell.md")).toBe(false);
  });

  test("validates F1/F2/F3/F0 payloads", () => {
    const thread = ThreadSchema.parse({
      id: "th-1",
      workspacePath: "/work",
      title: "Bill Cleanup",
      mode: "craft",
      status: "running",
      pinnedCommitSha: "abc1234",
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T00:00:00Z",
    });
    expect(thread.pinnedCommitSha).toBe("abc1234");

    const ev = RunnerEventSchema.parse({
      type: "runner.steered",
      threadId: "th-1",
      instruction: "Use gb18030 decoding",
      markedForEvolution: true,
    });
    expect(ev.type).toBe("runner.steered");

    const hookIntent = ExecHookIntentSchema.parse({
      threadId: "th-1",
      workspaceRoot: "/work",
      hookPath: "hooks/example_trim_output.ts",
      event: "PostToolUse",
      payloadJson: "{}",
    });
    expect(hookIntent.timeoutMs).toBe(10_000);

    const proposal = EvolutionProposalSchema.parse({
      id: "prop-1",
      threadId: "th-1",
      domain: "file_ops",
      title: "Add GB18030 CSV parser script",
      mode: "parallel",
      k: 1,
      triggerSource: "steer",
      sourceTags: ["local"],
      requiresHumanTrust: true,
      baseCommitSha: "abc1234",
      status: "ready",
      metricsBefore: { steps: 7, errors: 3, durationMs: 12000, tokens: 4000, costUsd: 0.04 },
      metricsAfter: { steps: 2, errors: 0, durationMs: 4200, tokens: 1500, costUsd: 0.015 },
      diffs: [
        {
          path: "scripts/safe_gbk_parse.ts",
          changeType: "added",
          before: "",
          after: "console.log('ok');",
          unifiedDiff: "+console.log('ok');",
          isHighPrivilege: true,
        },
      ],
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T00:00:00Z",
    });
    expect(proposal.requiresHumanTrust).toBe(true);

    const replay = OnboardingReplayTraceSchema.parse({
      id: "replay-1",
      title: "GBK CSV Rescue",
      isRecordedReplay: true,
      disclaimer: "Recorded replay (no API key required)",
      recordedModel: "gpt-4o-mini",
      recordedAt: "2026-11-20T00:00:00Z",
      steps: [],
      v0Metrics: { steps: 7, errors: 3, durationMs: 12000, tokens: 4000, costUsd: 0.04 },
      v1Metrics: { steps: 2, errors: 0, durationMs: 4200, tokens: 1500, costUsd: 0.015 },
    });
    expect(replay.isRecordedReplay).toBe(true);
  });
});
