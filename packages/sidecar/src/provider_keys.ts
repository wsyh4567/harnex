import { ProviderConfigSchema, ProviderKeyEntrySchema, RpcErrorCode, type ProviderConfig, type ProviderKeyEntry } from "@harnex/protocol";
import { providerUrl, type ProviderRegistry } from "@harnex/runtime";
import { z } from "zod";
import { RpcFailure, type StdioRustBridge } from "./stdio_bridge.ts";

const secret = z.string().trim().min(1).max(16_384);
const keyMetadata = ProviderKeyEntrySchema.pick({ id: true, label: true, enabled: true, priority: true });
export const SaveProviderSchema = z.object({
  provider: ProviderConfigSchema.omit({ keyringRef: true, hasApiKey: true, keys: true }).partial({ id: true })
    .extend({ keys: z.array(keyMetadata).max(32).optional() }),
  apiKey: secret.optional(),
  keyAdditions: z.array(keyMetadata.partial({ id: true, enabled: true, priority: true }).extend({ apiKey: secret })).max(32).default([]),
  keyRemovals: z.array(z.string().min(1)).max(32).default([]),
});

const invalid = (message: string) => new RpcFailure(RpcErrorCode.InvalidParams, message);

function maskedHint(value: string): string {
  if (value.length <= 4) return "••••";
  return `${value.length > 7 && value.startsWith("sk-") ? "sk-" : ""}••••${value.slice(-4)}`;
}

export async function saveProviderWithKeys(input: z.infer<typeof SaveProviderSchema>, registry: ProviderRegistry,
  bridge: StdioRustBridge): Promise<ProviderConfig> {
  const { provider, apiKey } = input;
  const id = provider.id ?? crypto.randomUUID();
  const baseUrl = providerUrl(provider.baseUrl);
  const existing = registry.list().find((record) => record.id === id);
  const keyringRef = existing?.keyringRef ?? `harnex:provider:${encodeURIComponent(id)}`;
  const isAggregator = provider.isAggregator ?? existing?.isAggregator ?? provider.source === "magpie";
  const keys = new Map(existing?.keys?.map((key) => [key.id, key]));
  const updates = new Set<string>();
  for (const key of provider.keys ?? []) {
    const stored = keys.get(key.id);
    if (!stored || updates.has(key.id)) throw invalid("Unknown or duplicate provider key ID");
    updates.add(key.id);
    keys.set(key.id, { ...stored, ...key });
  }

  const removals = new Set<string>();
  for (const keyId of input.keyRemovals) {
    const stored = keys.get(keyId);
    if (stored) removals.add(stored.keyringRef);
    keys.delete(keyId);
  }

  const writes = new Map<string, string>();
  const saveKey = (entry: ProviderKeyEntry, value: string) => {
    if (writes.has(entry.keyringRef)) throw invalid("A provider key was updated more than once");
    keys.set(entry.id, { ...entry, maskedHint: maskedHint(value), cooldownUntil: undefined, lastError: undefined });
    writes.set(entry.keyringRef, value);
    removals.delete(entry.keyringRef);
  };
  if (apiKey) {
    if (isAggregator) { writes.set(keyringRef, apiKey); removals.delete(keyringRef); }
    else {
      const primary = [...keys.values()].sort((a, b) => a.priority - b.priority)[0];
      saveKey(primary ?? { id: crypto.randomUUID(), label: "Primary Key", enabled: true, priority: 0, keyringRef }, apiKey);
    }
  }
  for (const addition of input.keyAdditions) {
    const keyId = addition.id ?? crypto.randomUUID();
    const previous = keys.get(keyId);
    saveKey({ id: keyId, label: addition.label, keyringRef: previous?.keyringRef ?? `harnex:provider-key:${crypto.randomUUID()}`,
      enabled: addition.enabled ?? previous?.enabled ?? true, priority: addition.priority ?? previous?.priority ?? keys.size }, addition.apiKey);
  }
  if (keys.size > 32) throw invalid("A provider can have at most 32 named keys");
  for (const key of keys.values()) removals.delete(key.keyringRef);
  const hasApiKey = !!(keys.size ? [...keys.values()].some(({ enabled }) => enabled) : writes.has(keyringRef) ||
    (!removals.has(keyringRef) && (existing?.keys?.length ? await bridge.keyringGet(keyringRef) : existing?.hasApiKey)));
  const record = ProviderConfigSchema.parse({ ...provider, id, baseUrl, keyringRef, isAggregator, hasApiKey,
    keys: keys.size ? [...keys.values()] : undefined, pinnedModels: provider.pinnedModels ?? existing?.pinnedModels,
    keyStrategy: provider.keyStrategy ?? existing?.keyStrategy ?? "priority_failover" });
  for (const [ref, value] of writes) await bridge.keyringSet(ref, value);
  for (const ref of removals) await bridge.keyringDelete(ref);
  if (writes.has(keyringRef) || removals.has(keyringRef)) registry.clearLegacyKeyFailure(id);
  return registry.upsert(record);
}
