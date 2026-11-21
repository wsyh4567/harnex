import { beforeEach, describe, expect, it } from "bun:test";
import {
  buildAggregatedModelCatalog,
  countActiveProviderKeys,
  filterCatalogEntries,
  groupCatalogByProvider,
  maskApiKey,
} from "../features/providers/modelCatalog.ts";
import { MockIpcAdapter, TauriIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("Multi-Key Pools, Provider -> Model Catalog & Chat Model Switcher", () => {
  let adapter: MockIpcAdapter;

  beforeEach(async () => {
    adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("supports multi-key pool CRUD, masking, cooldown counting, and keyStrategy switching", async () => {
    const store = useCommandDeckStore.getState();
    const openai = store.providers.find((p) => p.id === "prov-openai")!;
    expect(openai.keys?.length).toBe(2);
    expect(openai.keyStrategy).toBe("priority_failover");
    expect(countActiveProviderKeys(openai)).toBe(2);
    expect(maskApiKey("sk-proj-abcdef4f9a")).toBe("sk-••••4f9a");

    await store.saveProvider({
      provider: {
        id: openai.id,
        name: openai.name,
        kind: openai.kind,
        baseUrl: openai.baseUrl,
        models: openai.models,
        pinnedModels: openai.pinnedModels,
        keyringRef: openai.keyringRef,
        hasApiKey: openai.hasApiKey,
        keys: openai.keys,
        keyStrategy: "round_robin",
        isAggregator: openai.isAggregator,
        source: openai.source,
        enabled: openai.enabled,
      },
      keyAdditions: [{ label: "Burst Key #3", apiKey: "sk-burst-7788" }],
    });

    let updated = useCommandDeckStore.getState().providers.find((p) => p.id === "prov-openai")!;
    expect(updated.keyStrategy).toBe("round_robin");
    expect(updated.keys?.length).toBe(3);
    expect(updated.keys?.[2]?.maskedHint).toBe("sk-••••7788");
    expect(countActiveProviderKeys(updated)).toBe(3);

    await useCommandDeckStore.getState().saveProvider({
      provider: {
        id: updated.id,
        name: updated.name,
        kind: updated.kind,
        baseUrl: updated.baseUrl,
        models: updated.models,
        pinnedModels: updated.pinnedModels,
        keyringRef: updated.keyringRef,
        hasApiKey: updated.hasApiKey,
        keys: updated.keys,
        keyStrategy: updated.keyStrategy,
        isAggregator: updated.isAggregator,
        source: updated.source,
        enabled: updated.enabled,
      },
      keyRemovals: ["key-oa-2"],
    });

    updated = useCommandDeckStore.getState().providers.find((p) => p.id === "prov-openai")!;
    expect(updated.keys?.length).toBe(2);
    expect(updated.keys?.some((k) => k.id === "key-oa-2")).toBe(false);
  });

  it("groups catalog cleanly by Provider Name -> Model Name and filters by provider or model", () => {
    const state = useCommandDeckStore.getState();
    const groups = groupCatalogByProvider(state.aggregatedCatalog);

    expect(groups.map((g) => g.providerId)).toEqual([
      "prov-openai",
      "prov-anthropic",
      "prov-magpie",
      "prov-ollama",
    ]);

    const magpieGroup = groups.find((g) => g.providerId === "prov-magpie")!;
    expect(magpieGroup.providerName).toBe("Magpie Local Gateway (127.0.0.1:3425)");
    expect(magpieGroup.entries.map((e) => e.modelId)).toEqual([
      "group/smart-split",
      "demo-gateway/gpt-6.2-sol",
      "demo-gateway/deepseek-v4.1-flash",
      "ai-studio/gemini-4-hydrogen",
      "ai-studio/gemini-2.5-pro",
    ]);

    // Filter by provider name or model name
    const byProvider = groupCatalogByProvider(
      filterCatalogEntries(state.aggregatedCatalog, "anthropic"),
    );
    expect(byProvider.length).toBe(1);
    expect(byProvider[0]?.providerId).toBe("prov-anthropic");

    const byModel = groupCatalogByProvider(
      filterCatalogEntries(state.aggregatedCatalog, "gemini-4-hydrogen"),
    );
    expect(byModel.length).toBe(1);
    expect(byModel[0]?.entries[0]?.modelId).toBe("ai-studio/gemini-4-hydrogen");

    // Disabled providers are excluded from catalog
    const catalog = buildAggregatedModelCatalog([
      {
        id: "p-enabled",
        name: "Enabled Provider",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1"],
        keyringRef: "r1",
        hasApiKey: true,
        source: "manual",
        enabled: true,
      },
      {
        id: "p-disabled",
        name: "Disabled Provider",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4o"],
        keyringRef: "r2",
        hasApiKey: true,
        source: "manual",
        enabled: false,
      },
    ]);
    expect(catalog.map((e) => e.providerId)).toEqual(["p-enabled"]);
  });

  it("switches per-thread model in Chat and passes providerIdOverride + modelOverride to startRun", async () => {
    const store = useCommandDeckStore.getState();
    const thread = await store.createThread("Model Switcher Thread", "craft");

    await useCommandDeckStore.getState().sendPrompt("Hello via default solver");
    expect(adapter.recordedRunStarts[0]).toMatchObject({
      threadId: thread.id,
      providerIdOverride: "prov-openai",
      modelOverride: "gpt-4.1-mini",
    });

    useCommandDeckStore.getState().setThreadModelOverride(thread.id, {
      providerId: "prov-magpie",
      modelId: "ai-studio/gemini-4-hydrogen",
    });
    await useCommandDeckStore.getState().sendPrompt("Run via Magpie Hydrogen");
    expect(adapter.recordedRunStarts[1]).toMatchObject({
      threadId: thread.id,
      providerIdOverride: "prov-magpie",
      modelOverride: "ai-studio/gemini-4-hydrogen",
    });

    useCommandDeckStore.getState().setThreadModelOverride(thread.id, undefined);
    await useCommandDeckStore.getState().sendPrompt("Back to Solver");
    expect(adapter.recordedRunStarts[2]).toMatchObject({
      threadId: thread.id,
      providerIdOverride: "prov-openai",
      modelOverride: "gpt-4.1-mini",
    });
  });

  it("TauriIpcAdapter falls back to buildAggregatedModelCatalog when provider.catalog is absent and forwards keyAdditions/keyRemovals", async () => {
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const tauri = new TauriIpcAdapter({
      invoke: async <T>(_cmd: string, args?: Record<string, unknown>) => {
        const method = String(args?.method ?? "");
        const params = args?.params;
        rpcCalls.push({ method, params });
        if (method === "provider.catalog") {
          throw new Error("Method not found");
        }
        if (method === "provider.list") {
          return [
            {
              id: "prov-magpie",
              name: "Magpie",
              kind: "openai_compatible",
              baseUrl: "http://127.0.0.1:3425/v1",
              models: ["group/smart-split"],
              keyringRef: "r1",
              hasApiKey: true,
              isAggregator: true,
              source: "magpie",
              enabled: true,
            },
          ] as T;
        }
        return {} as T;
      },
    });

    const catalog = await tauri.getAggregatedCatalog();
    expect(catalog.length).toBe(1);
    expect(catalog[0]?.modelId).toBe("group/smart-split");

    await tauri.saveProvider({
      provider: {
        id: "prov-openai",
        name: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1-mini"],
        keyStrategy: "round_robin",
        source: "manual",
        enabled: true,
      },
      keyAdditions: [{ label: "Backup", apiKey: "sk-1234" }],
      keyRemovals: ["key-old"],
    });

    const saveCall = rpcCalls.find((c) => c.method === "provider.save");
    expect(saveCall?.params).toMatchObject({
      keyAdditions: [{ label: "Backup", apiKey: "sk-1234" }],
      keyRemovals: ["key-old"],
    });
  });
});
