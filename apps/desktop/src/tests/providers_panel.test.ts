import { beforeEach, describe, expect, it } from "bun:test";
import {
  computeSlotReadiness,
  getLatencyTone,
  PROVIDER_PRESETS,
  resolveDefaultBaseUrlOnKindChange,
  syncBudgetDraftFromStatus,
} from "../features/providers/providerPresets.ts";
import { MockIpcAdapter, TauriIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("ProvidersPanel Logic, Presets, Magpie importLink & Budget Sync", () => {
  let adapter: MockIpcAdapter;

  beforeEach(async () => {
    adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("supports provider inline edit, enable/disable toggle, and API key rotation", async () => {
    const store = useCommandDeckStore.getState();
    const openai = store.providers.find((p) => p.id === "prov-openai")!;
    expect(openai.hasApiKey).toBe(true);

    // Edit name/models/enabled without providing a new apiKey -> preserves existing keyring key
    await store.saveProvider({
      provider: {
        id: openai.id,
        name: "OpenAI Enterprise",
        kind: openai.kind,
        baseUrl: openai.baseUrl,
        models: [...openai.models, "gpt-4.1-nano"],
        keyringRef: openai.keyringRef,
        hasApiKey: openai.hasApiKey,
        source: openai.source,
        enabled: false,
      },
    });

    const updated = useCommandDeckStore
      .getState()
      .providers.find((p) => p.id === "prov-openai")!;
    expect(updated.name).toBe("OpenAI Enterprise");
    expect(updated.models).toContain("gpt-4.1-nano");
    expect(updated.hasApiKey).toBe(true);
    expect(updated.enabled).toBe(false);

    // Ping disabled provider returns clear failure feedback
    const pingDisabled = await useCommandDeckStore.getState().pingProvider(updated.id);
    expect(pingDisabled.ok).toBe(false);
    expect(pingDisabled.error).toContain("disabled");

    // Re-enable and rotate API key
    await useCommandDeckStore.getState().saveProvider({
      provider: {
        id: updated.id,
        name: updated.name,
        kind: updated.kind,
        baseUrl: updated.baseUrl,
        models: updated.models,
        keyringRef: updated.keyringRef,
        hasApiKey: updated.hasApiKey,
        source: updated.source,
        enabled: true,
      },
      apiKey: "sk-rotated-999",
    });

    const pingOk = await useCommandDeckStore.getState().pingProvider(updated.id);
    expect(pingOk.ok).toBe(true);
    expect(pingOk.latencyMs).toBeGreaterThan(0);
    expect(getLatencyTone(pingOk.ok, pingOk.latencyMs)).toBe("emerald");
  });

  it("provides quick-start presets and smartly updates default baseUrl on kind change", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "deepseek",
      "openrouter",
      "ollama",
    ]);

    // Switching from a default URL updates to the new kind's default URL
    expect(resolveDefaultBaseUrlOnKindChange("https://api.openai.com/v1", "anthropic")).toBe(
      "https://api.anthropic.com",
    );
    expect(resolveDefaultBaseUrlOnKindChange("https://api.anthropic.com", "ollama")).toBe(
      "http://127.0.0.1:11434/v1",
    );

    // Custom enterprise gateway URL is preserved on kind switch
    expect(resolveDefaultBaseUrlOnKindChange("https://llm.internal.corp/v1", "gemini")).toBe(
      "https://llm.internal.corp/v1",
    );
  });

  it("passes { gatewayUrl, importLink } through importFromMagpie in Mock & Tauri adapters", async () => {
    const store = useCommandDeckStore.getState();

    const validResult = await store.importFromMagpie({
      gatewayUrl: "http://127.0.0.1:3425",
      importLink:
        "magpie://import?name=MagpieDeepSeek&baseUrl=https://api.deepseek.com/v1&model=deepseek-chat,deepseek-reasoner&apiKey=sk-magpie",
    });
    expect(validResult.detected).toBe(true);
    expect(validResult.importedProviders[0]?.name).toBe("MagpieDeepSeek");
    expect(validResult.importedProviders[0]?.models).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    expect(validResult.importedProviders[0]?.hasApiKey).toBe(true);

    const badLink = await store.importFromMagpie({
      importLink: "https://not-magpie.invalid/import",
    });
    expect(badLink.detected).toBe(false);
    expect(badLink.fallbackToManual).toBe(true);

    // Verify TauriIpcAdapter sends { gatewayUrl, importLink } via sidecar_rpc
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const tauri = new TauriIpcAdapter({
      invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return {
          source: "magpie",
          detected: true,
          importedProviders: [],
          warnings: [],
          fallbackToManual: false,
        } as T;
      },
    });

    await tauri.importFromMagpie({
      gatewayUrl: "http://127.0.0.1:3425",
      importLink: "magpie://import?name=Demo&baseUrl=http://127.0.0.1:3425/v1",
    });
    expect(calls[0]).toEqual({
      cmd: "sidecar_rpc",
      args: {
        method: "provider.import_magpie",
        params: {
          gatewayUrl: "http://127.0.0.1:3425",
          importLink: "magpie://import?name=Demo&baseUrl=http://127.0.0.1:3425/v1",
        },
      },
    });
  });

  it("computes 3-slot readiness and syncs budgetStatus with custom pricing rows", async () => {
    const state = useCommandDeckStore.getState();
    const readiness = computeSlotReadiness(state.appConfig?.slots, state.providers);
    expect(readiness).toEqual({ readyCount: 3, total: 3, allReady: true });

    const synced = syncBudgetDraftFromStatus(state.budgetStatus);
    expect(synced.dailyLimit).toBe("5");
    expect(synced.pricingTable.length).toBeGreaterThanOrEqual(4);

    const nextTable = [
      ...synced.pricingTable,
      { modelId: "deepseek-chat", inputPer1MUsd: 0.27, outputPer1MUsd: 1.1 },
    ];
    await state.updateBudgetSettings({
      dailyLimitUsd: 15,
      pricingTable: nextTable,
    });

    const updatedStatus = useCommandDeckStore.getState().budgetStatus;
    const resynced = syncBudgetDraftFromStatus(updatedStatus);
    expect(resynced.dailyLimit).toBe("15");
    expect(resynced.pricingTable.some((r) => r.modelId === "deepseek-chat")).toBe(true);
  });
});
