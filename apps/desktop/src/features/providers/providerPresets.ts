import type { BudgetStatus, ModelPricing, ProviderConfig, ProviderKind, SlotBindings } from "@harnex/protocol";
import { translate, type Locale, type TranslationKey } from "../../i18n/index.ts";
import { formatTokens } from "../../lib/utils.ts";
import { countActiveProviderKeys } from "./modelCatalog.ts";

export interface ProviderPreset {
  id: string;
  label: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  requiresKey: boolean;
}

export const DEFAULT_BASE_URL_BY_KIND: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434/v1",
  openai_compatible: "https://api.openai.com/v1",
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5-mini", "gpt-5", "o4-mini"],
    requiresKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    requiresKey: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    name: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    requiresKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    name: "DeepSeek",
    kind: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    requiresKey: true,
  },
  {
    id: "glm",
    label: "GLM (Zhipu)",
    name: "GLM (Zhipu)",
    kind: "openai_compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air"],
    requiresKey: true,
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    name: "Kimi (Moonshot)",
    kind: "openai_compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0711-preview", "kimi-k2-thinking"],
    requiresKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    name: "OpenRouter",
    kind: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "openai/gpt-5-mini"],
    requiresKey: true,
  },
  {
    id: "ollama",
    label: "Ollama Local",
    name: "Ollama Local",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5-coder:14b", "llama3.3:70b"],
    requiresKey: false,
  },
];

export function resolveDefaultBaseUrlOnKindChange(
  currentBaseUrl: string,
  nextKind: ProviderKind,
): string {
  const trimmed = currentBaseUrl.trim();
  const knownDefaults = new Set<string>([
    ...Object.values(DEFAULT_BASE_URL_BY_KIND),
    ...PROVIDER_PRESETS.map((p) => p.baseUrl),
    "",
  ]);
  if (knownDefaults.has(trimmed)) {
    return DEFAULT_BASE_URL_BY_KIND[nextKind];
  }
  return currentBaseUrl;
}

export function computeSlotReadiness(
  slots: SlotBindings | undefined,
  providers: ProviderConfig[],
): { readyCount: number; total: 3; allReady: boolean } {
  const readyProviderIds = new Set(
    providers
      .filter((p) => p.enabled && p.models.length > 0 && countActiveProviderKeys(p) > 0)
      .map((p) => p.id),
  );
  const slotList = [slots?.solver, slots?.improver, slots?.judge];
  const readyCount = slotList.filter(
    (b) => Boolean(b && b.modelId && readyProviderIds.has(b.providerId)),
  ).length;
  return { readyCount, total: 3, allReady: readyCount === 3 };
}

export function getLatencyTone(ok: boolean, latencyMs: number): "emerald" | "amber" | "rose" {
  if (!ok || latencyMs >= 1000) return "rose";
  if (latencyMs < 300) return "emerald";
  return "amber";
}

export function syncBudgetDraftFromStatus(status: BudgetStatus | null): {
  dailyLimit: string;
  pricingTable: ModelPricing[];
} {
  return {
    dailyLimit: String(status?.dailyLimitUsd ?? 5),
    pricingTable: status ? status.pricingTable.map((row) => ({ ...row })) : [],
  };
}

export type BudgetCostSource = NonNullable<BudgetStatus["costSource"]>;

const COST_SOURCE_KEYS: Record<BudgetCostSource, TranslationKey> = {
  estimated: "budget.source.estimated",
  upstream_actual: "budget.source.upstream_actual",
  mixed: "budget.source.mixed",
  unpriced: "budget.source.unpriced",
};

const COST_SOURCE_TONE_CLASSES: Record<BudgetCostSource, string> = {
  estimated: "border-sky-500/25 bg-sky-50/80 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
  upstream_actual:
    "border-emerald-500/30 bg-emerald-50/80 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  mixed:
    "border-violet-500/25 bg-violet-50/80 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300",
  unpriced:
    "border-amber-500/30 bg-amber-50/80 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
};

/** Resolve localized label, tooltip, and tone styling for a budget cost source. */
export function resolveCostSourceBadge(
  costSource: BudgetStatus["costSource"],
  locale: Locale,
): {
  source: BudgetCostSource;
  label: string;
  tooltip: string;
  toneClass: string;
} {
  const source: BudgetCostSource = costSource ?? "estimated";
  const label = translate(locale, COST_SOURCE_KEYS[source]);
  return {
    source,
    label,
    tooltip: translate(locale, "budget.tooltipSource", { source: label }),
    toneClass: COST_SOURCE_TONE_CLASSES[source],
  };
}

/** Build a localized summary line when unpriced tokens or models exist today. */
export function formatUnpricedSummary(
  status: Pick<BudgetStatus, "unpricedTokensToday" | "unpricedModelsToday"> | null | undefined,
  locale: Locale,
): string | null {
  const unpricedTokens = status?.unpricedTokensToday ?? 0;
  const unpricedModels = status?.unpricedModelsToday ?? [];
  if (unpricedTokens <= 0 && unpricedModels.length === 0) {
    return null;
  }
  const formattedTokens = formatTokens(unpricedTokens, locale);
  if (unpricedModels.length > 0 && unpricedTokens > 0) {
    return translate(locale, "budget.unpricedBoth", {
      models: unpricedModels.length,
      tokens: formattedTokens,
    });
  }
  if (unpricedModels.length > 0) {
    return translate(locale, "budget.unpricedModelsOnly", {
      models: unpricedModels.length,
    });
  }
  return translate(locale, "budget.unpricedTokensOnly", {
    tokens: formattedTokens,
  });
}

/** Append a zero-initialized pricing row for an unpriced model without duplicating existing rows. */
export function appendUnpricedModelPricingRow(
  pricingTable: ModelPricing[],
  modelId: string,
): ModelPricing[] {
  const trimmed = modelId.trim();
  if (!trimmed || pricingTable.some((row) => row.modelId === trimmed)) {
    return pricingTable;
  }
  return [
    ...pricingTable,
    {
      modelId: trimmed,
      inputPer1MUsd: 0,
      outputPer1MUsd: 0,
    },
  ];
}
