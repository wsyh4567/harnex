import type { AggregatedModelEntry, ProviderConfig } from "@harnex/protocol";

export interface ProviderModelGroup {
  providerId: string;
  providerName: string;
  entries: AggregatedModelEntry[];
}

export function isProviderAggregator(provider: ProviderConfig): boolean {
  return Boolean(provider.isAggregator ?? provider.source === "magpie");
}

export function maskApiKey(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "••••";
  if (trimmed.length <= 6) {
    return `••${trimmed.slice(-2)}`;
  }
  const prefix = trimmed.startsWith("sk-") ? "sk-" : "";
  return `${prefix}••••${trimmed.slice(-4)}`;
}

export function countActiveProviderKeys(provider: ProviderConfig): number {
  if (isProviderAggregator(provider)) {
    return provider.hasApiKey || provider.baseUrl.includes("127.0.0.1") ? 1 : 0;
  }
  if (provider.keys && provider.keys.length > 0) {
    const now = Date.now();
    return provider.keys.filter((k) => {
      if (!k.enabled) return false;
      if (k.cooldownUntil) {
        const until = Date.parse(k.cooldownUntil);
        if (!Number.isNaN(until) && until > now) return false;
      }
      return true;
    }).length;
  }
  if (provider.hasApiKey || provider.kind === "ollama" || provider.baseUrl.includes("127.0.0.1")) {
    return 1;
  }
  return 0;
}

export function parseAggregatedModelName(
  modelId: string,
  aggregator: boolean,
): {
  displayName: string;
  upstreamGroup?: string;
  isRoutingGroup: boolean;
} {
  if (!aggregator) {
    return { displayName: modelId, isRoutingGroup: false };
  }
  const slashIdx = modelId.indexOf("/");
  if (slashIdx <= 0 || slashIdx === modelId.length - 1) {
    return { displayName: modelId, isRoutingGroup: false };
  }
  const prefix = modelId.slice(0, slashIdx);
  return {
    displayName: modelId,
    upstreamGroup: prefix,
    isRoutingGroup: prefix === "group",
  };
}

/**
 * Aggregates all enabled providers & models into a unified catalog grouped cleanly
 * by provider order and model ID.
 */
export function buildAggregatedModelCatalog(providers: ProviderConfig[]): AggregatedModelEntry[] {
  const entries: AggregatedModelEntry[] = [];

  for (const provider of providers) {
    if (!provider.enabled) continue;
    const aggregator = isProviderAggregator(provider);
    const activeKeyCount = countActiveProviderKeys(provider);
    const pinnedSet = new Set(provider.pinnedModels ?? []);

    for (const modelId of provider.models) {
      const parsed = parseAggregatedModelName(modelId, aggregator);
      entries.push({
        catalogId: `${provider.id}::${modelId}`,
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind,
        providerSource: provider.source,
        modelId,
        displayName: parsed.displayName,
        upstreamGroup: parsed.upstreamGroup,
        isAggregator: aggregator,
        isRoutingGroup: parsed.isRoutingGroup,
        pinned: pinnedSet.has(modelId),
        activeKeyCount,
      });
    }
  }

  return entries;
}

/**
 * Groups catalog entries simply by Provider Name -> Model Name.
 */
export function groupCatalogByProvider(entries: AggregatedModelEntry[]): ProviderModelGroup[] {
  const map = new Map<string, ProviderModelGroup>();
  for (const entry of entries) {
    let group = map.get(entry.providerId);
    if (!group) {
      group = {
        providerId: entry.providerId,
        providerName: entry.providerName,
        entries: [],
      };
      map.set(entry.providerId, group);
    }
    group.entries.push(entry);
  }
  return Array.from(map.values());
}

export function filterCatalogEntries(
  entries: AggregatedModelEntry[],
  query: string,
): AggregatedModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.modelId.toLowerCase().includes(q) ||
      e.providerName.toLowerCase().includes(q),
  );
}
