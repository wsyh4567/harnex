import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InMemoryTraceStore,
  MockLlmClient,
  MockRustBridge,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
} from "@harnex/interfaces";
import {
  ChatMessageSchema,
  RunnerEventSchema,
  type MessageAttachmentInput,
} from "@harnex/protocol";
import { DISABLED_ORGANS_PATH } from "../stubs/slots.ts";
import { SqliteTraceStore } from "../tracer/sqlite.ts";
import { ForegroundTaskRunner, type RuntimeRunRequest } from "./runner.ts";
import { DELEGATE_SUBAGENT_TOOL_NAME, SUBAGENT_ALLOWED_TOOLS } from "./subagent.ts";
import { runTool, toolsFor } from "./tools.ts";
import { WEB_FETCH_TOOL_NAME } from "./web_fetch.ts";

const tmpDirs: string[] = [];
async function createTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".runner-wire-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 2 });
  }
});

const baseUsage = {
  inputTokens: 100,
  outputTokens: 40,
  cachedInputTokens: 0,
  reasoningTokens: 10,
  costUsd: 0.005,
};

const makeResponse = (
  content = "done",
  toolCalls: LlmToolCall[] = [],
  usage = baseUsage,
): LlmResponse => ({
  content,
  toolCalls,
  modelId: "test-model",
  usage,
  finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
});

const makeCall = (
  name: string,
  args: Record<string, unknown> = {},
  id = `call-${name}-${Math.random().toString(36).slice(2, 7)}`,
): LlmToolCall => ({ id, name, arguments: args });

const makeRequest = (overrides: Partial<RuntimeRunRequest> = {}): RuntimeRunRequest => ({
  threadId: "thread-wire-1",
  mode: "craft",
  workspacePath: "/fixture-workspace",
  prompt: "Investigate and apply changes",
  domain: "general",
  pinnedCommitSha: "",
  ...overrides,
});

const publicLookup = async (_hostname: string): Promise<string[]> => ["93.184.216.34"];

const mockWebFetchImpl = (html: string, status = 200) =>
  (async () =>
    new Response(html, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;

describe("runner & tools Wave 2 wiring", () => {
  test("toolsFor exposes web_fetch in plan/craft and delegate_subagent only when enabled sub-agents exist", () => {
    const emptyTree = { "systemprompt.md": "Base" };
    const enabledTree = {
      "systemprompt.md": "Base",
      "sub_agents/researcher.md": "---\nname: researcher\ndescription: Research helper\n---\nCite exact paths.",
    };
    const disabledTree = {
      ...enabledTree,
      [DISABLED_ORGANS_PATH]: JSON.stringify({ disabled: ["sub_agents/researcher.md"] }),
    };

    expect(toolsFor("ask", enabledTree)).toEqual([]);

    const planEmpty = toolsFor("plan", emptyTree).map((t) => t.name);
    expect(planEmpty).toContain(WEB_FETCH_TOOL_NAME);
    expect(planEmpty).not.toContain(DELEGATE_SUBAGENT_TOOL_NAME);
    expect(planEmpty).not.toContain("write_file");

    const planDisabled = toolsFor("plan", disabledTree).map((t) => t.name);
    expect(planDisabled).toContain(WEB_FETCH_TOOL_NAME);
    expect(planDisabled).not.toContain(DELEGATE_SUBAGENT_TOOL_NAME);

    const planEnabled = toolsFor("plan", enabledTree).map((t) => t.name);
    expect(planEnabled).toContain(WEB_FETCH_TOOL_NAME);
    expect(planEnabled).toContain(DELEGATE_SUBAGENT_TOOL_NAME);
    expect(planEnabled).not.toContain("write_file");

    const craftEnabled = toolsFor("craft", enabledTree).map((t) => t.name);
    expect(craftEnabled).toContain(WEB_FETCH_TOOL_NAME);
    expect(craftEnabled).toContain(DELEGATE_SUBAGENT_TOOL_NAME);
    expect(craftEnabled).toContain("write_file");
    expect(craftEnabled).toContain("shell");
  });

  test("web_fetch marks web taint, persists deduplicated thread.sourceTags, and escalates subsequent L0 side-effect intents", async () => {
    const dir = await createTmpDir();
    const dbPath = join(dir, "trace.sqlite");
    const trace = new SqliteTraceStore(dbPath);
    const bridge = new MockRustBridge({
      "systemprompt.md": "Base prompt",
      "scripts/deploy.ts": "console.log('ok');",
    });

    try {
      const llm = new MockLlmClient((_req, idx) => {
        if (idx === 0) {
          return makeResponse("", [
            makeCall("web_fetch", { url: "https://example.com/docs" }, "tc-web-1"),
            makeCall("web_fetch", { url: "https://example.com/docs" }, "tc-web-2"),
            makeCall("write_file", { path: "notes.md", content: "from web" }, "tc-write-1"),
            makeCall("shell", { command: "echo", args: ["hi"] }, "tc-shell-1"),
          ]);
        }
        if (idx === 1) return makeResponse("Fetched and wrote notes.");
        if (idx === 2) {
          return makeResponse("", [
            makeCall("delete_file", { path: "notes.md" }, "tc-del-1"),
            makeCall("run_script", { scriptPath: "scripts/deploy.ts" }, "tc-script-1"),
          ]);
        }
        return makeResponse("Cleaned up.");
      });

      const runner = new ForegroundTaskRunner({
        bridge,
        trace,
        llm,
        webFetchOptions: {
          lookupHost: publicLookup,
          fetchImpl: mockWebFetchImpl("<html><head><title>Example Docs</title></head><body><h1>Hello</h1><p>Body text</p></body></html>"),
        },
      });

      const run1 = await runner.runTask(makeRequest({ workspacePath: dir, threadId: "thr-web" }));
      expect(run1.succeeded).toBe(true);
      expect(run1.sourceTags).toEqual(["local", "web"]);

      // Verify deduplicated persistence on thread in SQLite
      const storedThread = await trace.getThread("thr-web");
      expect(storedThread?.sourceTags).toEqual(["local", "web"]);

      // Verify L0 intents in turn 1 received "web" in sourceTags
      const writeCall = bridge.recordedCalls.find((c) => c.method === "execWriteFile");
      const shellCall = bridge.recordedCalls.find((c) => c.method === "execShell");
      expect(writeCall?.payload).toMatchObject({ sourceTags: ["local", "web"] });
      expect(shellCall?.payload).toMatchObject({ sourceTags: ["local", "web"] });

      // Verify runner.tool_call and runner.tool_result events emit clean summaries and match schema
      expect(bridge.emittedEvents.every((ev) => RunnerEventSchema.safeParse(ev).success)).toBe(true);
      const webCallEv = bridge.emittedEvents.find(
        (ev) => ev.type === "runner.tool_call" && ev.toolCall.id === "tc-web-1",
      );
      expect(webCallEv).toMatchObject({
        type: "runner.tool_call",
        toolCall: { name: "web_fetch", args: { url: "https://example.com/docs" }, status: "running" },
      });
      const webResEv = bridge.emittedEvents.find(
        (ev) => ev.type === "runner.tool_result" && ev.toolCallId === "tc-web-1",
      );
      expect(webResEv?.type === "runner.tool_result" && webResEv.output).toContain("Fetched https://example.com/docs");
      expect(webResEv?.type === "runner.tool_result" && webResEv.output).toContain("Example Docs");
      expect(webResEv?.type === "runner.tool_result" && webResEv.output).toContain("Body text");

      // Follow-up turn on the same thread must inherit persisted "web" taint for delete_file & run_script
      const run2 = await runner.runTask(makeRequest({ workspacePath: dir, threadId: "thr-web", prompt: "Now delete and run script" }));
      expect(run2.succeeded).toBe(true);
      expect(run2.sourceTags).toEqual(["local", "web"]);
      const delCall = bridge.recordedCalls.find((c) => c.method === "execDeleteFile");
      const scriptCall = bridge.recordedCalls.find((c) => c.method === "execScript");
      expect(delCall?.payload).toMatchObject({ sourceTags: ["local", "web"] });
      expect(scriptCall?.payload).toMatchObject({ sourceTags: ["local", "web"] });
    } finally {
      trace.close();
    }
  });

  test("blocked SSRF web_fetch fails cleanly without tainting thread.sourceTags", async () => {
    const dir = await createTmpDir();
    const bridge = new MockRustBridge({ "systemprompt.md": "Base" });
    const trace = new InMemoryTraceStore();
    const llm = new MockLlmClient((_req, idx) =>
      idx === 0
        ? makeResponse("", [makeCall("web_fetch", { url: "http://127.0.0.1:8080/admin" }, "tc-ssrf")])
        : makeResponse("Blocked."),
    );
    const runner = new ForegroundTaskRunner({ bridge, trace, llm });
    const result = await runner.runTask(makeRequest({ workspacePath: dir, threadId: "thr-ssrf" }));
    expect(result.succeeded).toBe(true);
    expect(result.metrics.errors).toBe(1);
    expect(result.sourceTags).toEqual(["local"]);
    expect((await trace.getThread("thr-ssrf"))?.sourceTags).toEqual(["local"]);
  });

  test("delegate_subagent runs read-only sub-agent, blocks recursion & write tools, propagates taintedWeb, and aggregates token usage without double-billing", async () => {
    const dir = await createTmpDir();
    await writeFile(join(dir, "README.md"), "Project documentation line 1\n");

    const bridge = new MockRustBridge({
      "systemprompt.md": "Main system prompt",
      "sub_agents/researcher.md":
        "---\nname: researcher\ndescription: Focused codebase & web investigator\n---\nInvestigate concisely and cite sources.",
    });
    const trace = new InMemoryTraceStore();

    const seenRequests: LlmRequest[] = [];
    const subUsage1 = { inputTokens: 60, outputTokens: 25, cachedInputTokens: 5, reasoningTokens: 4, costUsd: 0.002 };
    const subUsage2 = { inputTokens: 80, outputTokens: 35, cachedInputTokens: 10, reasoningTokens: 6, costUsd: 0.003 };
    const parentUsage1 = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, reasoningTokens: 5, costUsd: 0.004 };
    const parentUsage2 = { inputTokens: 150, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 8, costUsd: 0.006 };
    const parentUsage3 = { inputTokens: 90, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 2, costUsd: 0.002 };

    const llm = new MockLlmClient((req, idx) => {
      seenRequests.push(req);
      // Call 0: Parent delegates to researcher
      if (idx === 0) {
        expect(req.tools?.map((t) => t.name)).toContain(DELEGATE_SUBAGENT_TOOL_NAME);
        expect(req.systemPrompt).toContain("researcher (sub_agents/researcher.md)");
        return makeResponse(
          "",
          [
            makeCall(
              DELEGATE_SUBAGENT_TOOL_NAME,
              { profile: "researcher", task: "Read README.md and fetch https://example.com/spec" },
              "tc-sub-1",
            ),
          ],
          parentUsage1,
        );
      }
      // Call 1: Sub-agent step 1 attempts forbidden recursion + write + shell AND allowed read_file + web_fetch
      if (idx === 1) {
        const subToolNames = (req.tools ?? []).map((t) => t.name);
        expect(subToolNames.every((name) => SUBAGENT_ALLOWED_TOOLS.has(name))).toBe(true);
        expect(subToolNames).not.toContain(DELEGATE_SUBAGENT_TOOL_NAME);
        expect(subToolNames).not.toContain("write_file");
        expect(subToolNames).not.toContain("shell");
        expect(subToolNames).not.toContain("set_goals");
        expect(req.reasoningEffort).toBe("high");
        return makeResponse(
          "",
          [
            makeCall(DELEGATE_SUBAGENT_TOOL_NAME, { profile: "researcher", task: "nested" }, "sub-rec"),
            makeCall("write_file", { path: "evil.txt", content: "no" }, "sub-write"),
            makeCall("shell", { command: "rm", args: ["-rf", "."] }, "sub-shell"),
            makeCall("read_file", { path: "README.md" }, "sub-read"),
            makeCall("web_fetch", { url: "https://example.com/spec" }, "sub-web"),
          ],
          subUsage1,
        );
      }
      // Call 2: Sub-agent step 2 produces final synthesis after seeing tool denials + fetched content
      if (idx === 2) {
        const toolMsgs = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
        expect(toolMsgs.some((c) => c.includes("not allowed in read-only sub-agent mode"))).toBe(true);
        expect(toolMsgs.some((c) => c.includes("Project documentation line 1"))).toBe(true);
        expect(toolMsgs.some((c) => c.includes("Remote spec details"))).toBe(true);
        return makeResponse("Synthesis: README + remote spec verified.", [], subUsage2);
      }
      // Call 3: Parent now runs write_file (must carry propagated "web" taint!)
      if (idx === 3) {
        return makeResponse(
          "",
          [makeCall("write_file", { path: "summary.md", content: "Verified summary" }, "tc-write-after-sub")],
          parentUsage2,
        );
      }
      // Call 4: Parent finishes
      return makeResponse("All done.", [], parentUsage3);
    });

    const runner = new ForegroundTaskRunner({
      bridge,
      trace,
      llm,
      webFetchOptions: {
        lookupHost: publicLookup,
        fetchImpl: mockWebFetchImpl("<html><head><title>Spec</title></head><body><p>Remote spec details</p></body></html>"),
      },
    });

    const result = await runner.runTask(
      makeRequest({
        workspacePath: dir,
        threadId: "thr-sub",
        reasoningEffort: "high",
      }),
    );

    expect(result.succeeded).toBe(true);
    expect(result.sourceTags).toContain("external_file");
    expect(result.sourceTags).toContain("web");
    expect((await trace.getThread("thr-sub"))?.sourceTags).toContain("web");

    // Only the parent write_file reached L0 — sub-agent write/shell never touched bridge
    const execMethods = bridge.recordedCalls.filter((c) => c.method.startsWith("exec"));
    expect(execMethods).toHaveLength(1);
    expect(execMethods[0]).toMatchObject({
      method: "execWriteFile",
      payload: {
        targetPath: "summary.md",
        sourceTags: expect.arrayContaining(["local", "external_file", "web"]),
      },
    });

    // Token usage & cost must include both parent (3 calls) and sub-agent (2 calls)
    const expectedInput =
      parentUsage1.inputTokens + subUsage1.inputTokens + subUsage2.inputTokens + parentUsage2.inputTokens + parentUsage3.inputTokens;
    const expectedOutput =
      parentUsage1.outputTokens + subUsage1.outputTokens + subUsage2.outputTokens + parentUsage2.outputTokens + parentUsage3.outputTokens;
    const expectedCost =
      parentUsage1.costUsd + subUsage1.costUsd + subUsage2.costUsd + parentUsage2.costUsd + parentUsage3.costUsd;

    expect(result.metrics.tokens).toBe(expectedInput + expectedOutput);
    expect(result.metrics.costUsd).toBeCloseTo(expectedCost, 10);
    // Bridge ledger must NOT double-count sub-agent usage
    expect(bridge.spentTodayUsd).toBeCloseTo(expectedCost, 10);

    // Completed event usage must also reflect total usage
    const completedEv = bridge.emittedEvents.find((ev) => ev.type === "runner.completed");
    expect(completedEv?.type === "runner.completed" && completedEv.usage.inputTokens).toBe(expectedInput);
    expect(completedEv?.type === "runner.completed" && completedEv.usage.outputTokens).toBe(expectedOutput);

    // Tool call/result events for delegate_subagent must be clean and schema-valid
    expect(bridge.emittedEvents.every((ev) => RunnerEventSchema.safeParse(ev).success)).toBe(true);
    const subCallEv = bridge.emittedEvents.find(
      (ev) => ev.type === "runner.tool_call" && ev.toolCall.id === "tc-sub-1",
    );
    expect(subCallEv).toMatchObject({
      type: "runner.tool_call",
      toolCall: {
        name: DELEGATE_SUBAGENT_TOOL_NAME,
        args: { profile: "researcher", task: "Read README.md and fetch https://example.com/spec" },
      },
    });
    const subResEv = bridge.emittedEvents.find(
      (ev) => ev.type === "runner.tool_result" && ev.toolCallId === "tc-sub-1",
    );
    expect(subResEv?.type === "runner.tool_result" && subResEv.output).toContain("[sub-agent:researcher]");
    expect(subResEv?.type === "runner.tool_result" && subResEv.output).toContain("web-tainted");
    expect(subResEv?.type === "runner.tool_result" && subResEv.output).toContain("Synthesis: README + remote spec verified.");
  });

  test("runTool denies delegate_subagent when depth limit is reached or no enabled sub-agents exist", async () => {
    const dir = await createTmpDir();
    const bridge = new MockRustBridge();
    const llm = new MockLlmClient();

    const noSubagent = await runTool(
      makeCall(DELEGATE_SUBAGENT_TOOL_NAME, { profile: "researcher", task: "hello" }),
      makeRequest({ workspacePath: dir, mode: "plan" }),
      { "systemprompt.md": "Base" },
      bridge,
      ["local"],
      8000,
      { llm },
    );
    expect(noSubagent.status).toBe("denied");

    const treeWithSub = {
      "sub_agents/researcher.md": "---\nname: researcher\n---\nBe concise.",
    };
    await expect(
      runTool(
        makeCall(DELEGATE_SUBAGENT_TOOL_NAME, { profile: "researcher", task: "nested" }),
        makeRequest({ workspacePath: dir, mode: "plan" }),
        treeWithSub,
        bridge,
        ["local"],
        8000,
        { llm, subagentDepth: 1 },
      ),
    ).rejects.toThrow("Sub-agent recursion depth limit");
  });

  test("forwards reasoningEffort and runtime attachments to LLM while persisting metadata-only attachments (zero dataBase64) to SQLite", async () => {
    const dir = await createTmpDir();
    const dbPath = join(dir, "attachments.sqlite");
    const trace = new SqliteTraceStore(dbPath);
    const bridge = new MockRustBridge({ "systemprompt.md": "Vision assistant" });

    // Large synthetic base64 payload (~300KB) that would overflow raw byte token estimation if not handled properly
    const sentinelBase64 = `iVBORw0KGgoAAAANSUhEUg${"QUJDREVGR0hJSktMTU5P".repeat(15_000)}`;
    const attachment: MessageAttachmentInput = {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 225_000,
      width: 1280,
      height: 720,
      dataBase64: sentinelBase64,
    };

    try {
      const seenRequests: LlmRequest[] = [];
      const llm = new MockLlmClient((req) => {
        seenRequests.push(req);
        return makeResponse(`Saw ${req.messages.at(-1)?.attachments?.length ?? 0} attachment(s)`);
      });

      const runner = new ForegroundTaskRunner({
        bridge,
        trace,
        llm,
        contextMaxTokens: 32_000,
      });

      // Turn 1: with reasoningEffort + image attachment
      const run1 = await runner.runTask(
        makeRequest({
          threadId: "thr-vision",
          workspacePath: dir,
          mode: "ask",
          prompt: "Describe this architecture diagram",
          reasoningEffort: "medium",
          attachments: [attachment],
        }),
      );
      expect(run1.succeeded).toBe(true);
      expect(run1.finalOutput).toBe("Saw 1 attachment(s)");

      // Active user LlmMessage received full runtime attachment with dataBase64 + reasoningEffort
      expect(seenRequests[0]?.reasoningEffort).toBe("medium");
      expect(seenRequests[0]?.messages).toHaveLength(1);
      expect(seenRequests[0]?.messages[0]?.attachments).toEqual([attachment]);

      // Persisted ChatMessage in SQLite has metadata ONLY (strictly no dataBase64)
      const persisted = await trace.listMessages("thr-vision");
      expect(persisted).toHaveLength(2);
      const userMsg = ChatMessageSchema.parse(persisted[0]);
      expect(userMsg.attachments).toEqual([
        {
          id: "att-1",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 225_000,
          width: 1280,
          height: 720,
        },
      ]);
      expect("dataBase64" in (userMsg.attachments![0] as Record<string, unknown>)).toBe(false);

      // Turn 2 on same thread without attachments: historical user message must NOT carry runtime dataBase64
      const run2 = await runner.runTask(
        makeRequest({
          threadId: "thr-vision",
          workspacePath: dir,
          mode: "ask",
          prompt: "Follow up question",
          reasoningEffort: "low",
        }),
      );
      expect(run2.succeeded).toBe(true);
      expect(seenRequests[1]?.reasoningEffort).toBe("low");
      expect(seenRequests[1]?.messages.every((m) => m.attachments === undefined)).toBe(true);

      trace.close();

      // Raw SQLite bytes on disk must NEVER contain the base64 image payload
      const rawBytes = await readFile(dbPath);
      expect(rawBytes.includes(Buffer.from("iVBORw0KGgoAAAANSUhEUg"))).toBe(false);
      expect(rawBytes.includes(Buffer.from("dataBase64"))).toBe(false);
    } finally {
      try {
        trace.close();
      } catch {
        // already closed
      }
    }
  });
});
