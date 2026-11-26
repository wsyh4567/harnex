import { describe, expect, test } from "bun:test";
import { MockLlmClient, MockRustBridge, type HarnessTree, type LlmToolDef } from "@harnex/interfaces";
import { BudgetExceededError, DISABLED_ORGANS_PATH } from "../stubs/slots.ts";
import {
  DELEGATE_SUBAGENT_TOOL_DEF,
  DELEGATE_SUBAGENT_TOOL_NAME,
  runReadOnlySubagent,
  SUBAGENT_ALLOWED_TOOLS,
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_MAX_STEPS,
} from "./subagent.ts";

const makeTool = (name: string): LlmToolDef => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object", properties: {} },
});

const baseTree = (extra: HarnessTree = {}): HarnessTree => ({
  "sub_agents/researcher.md":
    "---\nname: researcher\ndescription: Focused investigator\n---\nCite exact paths and return concise facts.",
  ...extra,
});

describe("runReadOnlySubagent", () => {
  test("exports frozen constants and tool definition", () => {
    expect(DELEGATE_SUBAGENT_TOOL_NAME).toBe("delegate_subagent");
    expect(SUBAGENT_MAX_DEPTH).toBe(1);
    expect(SUBAGENT_MAX_STEPS).toBe(6);
    expect([...SUBAGENT_ALLOWED_TOOLS].sort()).toEqual([
      "find_files",
      "grep_files",
      "list_files",
      "read_file",
      "web_fetch",
    ]);
    expect(DELEGATE_SUBAGENT_TOOL_DEF.name).toBe("delegate_subagent");
    expect(DELEGATE_SUBAGENT_TOOL_DEF.inputSchema.required).toEqual(["profile", "task"]);
  });

  test("enforces hard recursion lock when depth >= SUBAGENT_MAX_DEPTH", async () => {
    const llm = new MockLlmClient();
    const bridge = new MockRustBridge();

    await expect(
      runReadOnlySubagent(
        {
          tree: baseTree(),
          llm,
          bridge,
          readOnlyTools: [makeTool("read_file")],
          executeReadOnlyTool: async () => ({ output: "ok" }),
          depth: SUBAGENT_MAX_DEPTH,
        },
        "researcher",
        "Inspect readme",
      ),
    ).rejects.toThrow("Sub-agent recursion depth limit (1) exceeded");

    expect(llm.calls).toHaveLength(0);
  });

  test("rejects disabled sub-agent profiles before calling LLM", async () => {
    const llm = new MockLlmClient();
    const bridge = new MockRustBridge();
    const tree = baseTree({
      [DISABLED_ORGANS_PATH]: JSON.stringify({ disabled: ["./sub_agents\\researcher.md"] }),
    });

    await expect(
      runReadOnlySubagent(
        {
          tree,
          llm,
          bridge,
          readOnlyTools: [makeTool("read_file")],
          executeReadOnlyTool: async () => ({ output: "ok" }),
        },
        "researcher",
        "Inspect readme",
      ),
    ).rejects.toThrow("Sub-agent profile is disabled: sub_agents/researcher.md");

    expect(llm.calls).toHaveLength(0);
  });

  test("filters disallowed tools before LLM call and blocks hallucinated disallowed tool calls", async () => {
    const executed: string[] = [];
    const llm = new MockLlmClient((_req, idx) => {
      if (idx === 0) {
        return {
          content: "Trying tools",
          toolCalls: [
            { id: "tc-1", name: "delegate_subagent", arguments: { profile: "researcher", task: "nested" } },
            { id: "tc-2", name: "write_file", arguments: { path: "a.txt", content: "bad" } },
            { id: "tc-3", name: "delete_file", arguments: { path: "a.txt" } },
            { id: "tc-4", name: "run_shell", arguments: { command: "rm -rf ." } },
            { id: "tc-5", name: "run_script", arguments: { scriptPath: "scripts/x.ts" } },
            { id: "tc-6", name: "read_file", arguments: { path: "README.md" } },
          ],
          finishReason: "tool_calls",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cachedInputTokens: 10,
            reasoningTokens: 5,
            costUsd: 0.002,
            upstreamCostUsd: 0.002,
          },
          modelId: "mock-solver",
        };
      }
      return {
        content: "Verified README.md line 1: Harnex.",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 180,
          outputTokens: 40,
          cachedInputTokens: 20,
          reasoningTokens: 0,
          costUsd: 0.003,
          upstreamCostUsd: 0.003,
        },
        modelId: "mock-solver",
      };
    });
    const bridge = new MockRustBridge();

    const result = await runReadOnlySubagent(
      {
        tree: baseTree(),
        llm,
        bridge,
        readOnlyTools: [
          makeTool("read_file"),
          makeTool("grep_files"),
          makeTool("write_file"),
          makeTool("delete_file"),
          makeTool("shell"),
          makeTool("run_shell"),
          makeTool("run_script"),
          DELEGATE_SUBAGENT_TOOL_DEF,
        ],
        executeReadOnlyTool: async (name) => {
          executed.push(name);
          return { output: "1: Harnex" };
        },
        modelId: "gpt-5-mini",
        providerIdOverride: "openai",
        reasoningEffort: "medium",
      },
      "researcher",
      "Inspect README.md",
    );

    // Disallowed tools were stripped from tools sent to the LLM
    expect(llm.calls[0]?.tools?.map((t) => t.name)).toEqual(["read_file", "grep_files"]);
    expect(llm.calls[0]?.modelId).toBe("gpt-5-mini");
    expect(llm.calls[0]?.providerIdOverride).toBe("openai");
    expect((llm.calls[0] as unknown as { reasoningEffort?: string }).reasoningEffort).toBe("medium");

    // Only read_file was actually executed; all 5 disallowed calls received tool error messages
    expect(executed).toEqual(["read_file"]);
    const toolMessages = llm.calls[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(6);
    for (let i = 0; i < 5; i++) {
      expect(toolMessages[i]?.content).toContain("is not allowed in read-only sub-agent mode");
    }
    expect(toolMessages[5]?.content).toBe("1: Harnex");

    expect(result).toEqual({
      profilePath: "sub_agents/researcher.md",
      profileName: "researcher",
      output: "Verified README.md line 1: Harnex.",
      steps: 2,
      toolCalls: 1,
      taintedWeb: false,
      usage: {
        inputTokens: 300,
        outputTokens: 70,
        cachedInputTokens: 30,
        reasoningTokens: 5,
        costUsd: 0.005,
        upstreamCostUsd: 0.005,
      },
    });
    expect(bridge.tokensToday).toBe(370);
  });

  test("marks taintedWeb when web_fetch is invoked or tool outcome sets taintedWeb", async () => {
    const llm = new MockLlmClient((_req, idx) =>
      idx === 0
        ? {
            content: "",
            toolCalls: [{ id: "w1", name: "web_fetch", arguments: { url: "https://example.com" } }],
            finishReason: "tool_calls",
            usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.001 },
            modelId: "mock-solver",
          }
        : {
            content: "Fetched summary.",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 60, outputTokens: 15, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.001 },
            modelId: "mock-solver",
          },
    );
    const bridge = new MockRustBridge();

    const resWeb = await runReadOnlySubagent(
      {
        tree: baseTree(),
        llm,
        bridge,
        readOnlyTools: [makeTool("web_fetch")],
        executeReadOnlyTool: async () => ({ output: "Example Domain" }),
      },
      "sub_agents/researcher.md",
      "Fetch docs",
    );
    expect(resWeb.taintedWeb).toBe(true);

    const llm2 = new MockLlmClient((_req, idx) =>
      idx === 0
        ? {
            content: "",
            toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "cached.html" } }],
            finishReason: "tool_calls",
            usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.001 },
            modelId: "mock-solver",
          }
        : {
            content: "Cached page summary.",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 60, outputTokens: 15, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.001 },
            modelId: "mock-solver",
          },
    );
    const resFlag = await runReadOnlySubagent(
      {
        tree: baseTree(),
        llm: llm2,
        bridge,
        readOnlyTools: [makeTool("read_file")],
        executeReadOnlyTool: async () => ({ output: "<html>", taintedWeb: true }),
      },
      "researcher",
      "Read cached html",
    );
    expect(resFlag.taintedWeb).toBe(true);
  });

  test("clamps maxSteps to SUBAGENT_MAX_STEPS and returns bounded summary with collected evidence", async () => {
    const llm = new MockLlmClient((_req, idx) => ({
      content: `Inspecting step ${idx + 1}`,
      toolCalls: [{ id: `tc-${idx}`, name: "list_files", arguments: { path: "." } }],
      finishReason: "tool_calls",
      usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.0005 },
      modelId: "mock-solver",
    }));
    const bridge = new MockRustBridge();

    const result = await runReadOnlySubagent(
      {
        tree: baseTree(),
        llm,
        bridge,
        readOnlyTools: [makeTool("list_files")],
        executeReadOnlyTool: async () => ({ output: "src/\nREADME.md" }),
        maxSteps: 99,
      },
      "researcher",
      "Survey everything",
    );

    expect(result.steps).toBe(SUBAGENT_MAX_STEPS);
    expect(result.toolCalls).toBe(SUBAGENT_MAX_STEPS);
    expect(llm.calls).toHaveLength(SUBAGENT_MAX_STEPS);
    expect(result.output).toContain(`maximum step limit (${SUBAGENT_MAX_STEPS})`);
    expect(result.output).toContain("src/\nREADME.md");
    expect(result.output).toContain(`Inspecting step ${SUBAGENT_MAX_STEPS}`);
  });

  test("enforces AbortSignal and budget checks before and during loop", async () => {
    const llm = new MockLlmClient();
    const bridge = new MockRustBridge();
    const controller = new AbortController();
    controller.abort(new Error("User cancelled"));

    await expect(
      runReadOnlySubagent(
        {
          tree: baseTree(),
          llm,
          bridge,
          readOnlyTools: [makeTool("read_file")],
          executeReadOnlyTool: async () => ({ output: "ok" }),
          signal: controller.signal,
        },
        "researcher",
        "Check files",
      ),
    ).rejects.toThrow("User cancelled");
    expect(llm.calls).toHaveLength(0);

    bridge.budgetTripped = true;
    await expect(
      runReadOnlySubagent(
        {
          tree: baseTree(),
          llm,
          bridge,
          readOnlyTools: [makeTool("read_file")],
          executeReadOnlyTool: async () => ({ output: "ok" }),
        },
        "researcher",
        "Check files",
      ),
    ).rejects.toThrow(BudgetExceededError);
    expect(llm.calls).toHaveLength(0);

    // Budget trips after recordUsage on step 1
    const bridge2 = new MockRustBridge();
    bridge2.budgetLimitUsd = 0.001;
    const llm2 = new MockLlmClient(() => ({
      content: "Done",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.005 },
      modelId: "mock-solver",
    }));

    await expect(
      runReadOnlySubagent(
        {
          tree: baseTree(),
          llm: llm2,
          bridge: bridge2,
          readOnlyTools: [makeTool("read_file")],
          executeReadOnlyTool: async () => ({ output: "ok" }),
        },
        "researcher",
        "Check files",
      ),
    ).rejects.toThrow(BudgetExceededError);
  });
});
