import { describe, expect, test } from "bun:test";
import {
  InMemoryHarnessStore,
  InMemoryTraceStore,
  MockLlmClient,
  MockRustBridge,
  MockTaskRunner,
} from "../src/index.ts";

describe("@harnex/interfaces deterministic mocks", () => {
  test("MockRustBridge blocks immutable L0 paths and tracks budget", async () => {
    const bridge = new MockRustBridge({ "systemprompt.md": "hello" });
    const blocked = await bridge.execWriteFile({
      threadId: "t1",
      workspaceRoot: "/work",
      targetPath: ".git/HEAD",
      content: "evil",
      sandboxMode: "workspace-write",
      sourceTags: ["local"],
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.deniedReason).toContain("immutable");

    const store = new InMemoryHarnessStore(bridge);
    const badPatch = store.validatePatch([
      { path: "src-tauri/src/main.rs", op: "upsert", content: "hack" },
    ]);
    expect(badPatch.ok).toBe(false);

    const head = await store.getHeadSha();
    const okCommit = await store.commitPatch(
      head,
      [{ path: "memory/LongTermMEMORY.md", op: "upsert", content: "fact" }],
      "Update memory",
    );
    expect(okCommit.ok).toBe(true);
    expect(okCommit.newCommitSha).toBeTruthy();

    bridge.budgetLimitUsd = 0.01;
    await bridge.recordUsage("mock", {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.02,
    });
    const budget = await bridge.checkBudget();
    expect(budget.allowed).toBe(false);
    expect(budget.status.tripped).toBe(true);
  });

  test("MockLlmClient, MockTaskRunner, and InMemoryTraceStore work end-to-end", async () => {
    const llm = new MockLlmClient();
    const res = await llm.complete({
      slot: "solver",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("mock-response:solver");

    const runner = new MockTaskRunner();
    const run = await runner.runTask({
      threadId: "t1",
      workspacePath: "/work",
      prompt: "test task",
      mode: "craft",
      domain: "file_ops",
      pinnedCommitSha: "abc",
    });
    expect(run.succeeded).toBe(true);

    const traces = new InMemoryTraceStore();
    await traces.saveTraceRun({
      runId: run.runId,
      threadId: "t1",
      domain: "file_ops",
      pinnedCommitSha: "abc",
      prompt: "test task",
      finalOutput: run.finalOutput,
      trajectoryMarkdown: run.trajectoryMarkdown,
      touchedFiles: [],
      metrics: run.metrics,
      succeeded: false,
      hadHumanSteer: false,
      steerInstructions: [],
      sourceTags: ["local"],
      createdAt: new Date().toISOString(),
    });
    const health = await traces.getDomainHealth("file_ops");
    expect(health.failureRate).toBe(1);
    expect(health.consecutiveFailures).toBe(1);
  });
});
