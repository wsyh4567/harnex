import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { setTimeout as sleep } from "node:timers/promises";
import type { LlmClient, LlmRequest, LlmStreamChunk, RustBridge } from "@harnex/interfaces";
import { ProviderConfigSchema, SlotBindingSchema, type AggregatedModelEntry, type ModelPricing, type ModelSlot,
  type ProviderConfig, type ProviderKeyEntry, type SlotBinding, type SlotBindings } from "@harnex/protocol";
import { AnthropicLlmClient } from "../llm/anthropic.ts";
import { GeminiLlmClient } from "../llm/gemini.ts";
import { OpenAiLlmClient } from "../llm/openai.ts";

export const providerUrl = (value: string): string => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider base URL must be HTTP(S) without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
};

export function isLoopback(value: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
}

export interface RoutedLlmRequest extends LlmRequest {
  providerIdOverride?: string;
}

export interface ProviderCredential { keyId: string | null; secret: string | null }
type KeyFailure = Pick<ProviderKeyEntry, "lastError" | "cooldownUntil">;
const cooling = (key: KeyFailure | undefined, now: number) => Date.parse(key?.cooldownUntil ?? "") > now;

function httpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return;
  const direct = "status" in error && error.status != null ? Number(error.status) : undefined;
  // The installed Gemini SDK puts the HTTP status at the start of its error message.
  return direct ?? Number(/^got status: (\d{3})\b/.exec(error.message)?.[1]);
}

function pingFailure(error: unknown): string {
  const status = httpStatus(error);
  if (status === 401 || status === 403) return `Authentication failed (HTTP ${status}). Check the API key and provider permissions.`;
  if (status === 404) return "Provider endpoint not found (HTTP 404). Check the base URL and API path.";
  if (status === 429) return "Provider rate limit reached (HTTP 429). Check quota or retry after the limit resets.";
  if (status === 502 || status === 503 || status === 504) return `Provider gateway unavailable (HTTP ${status}). Check the upstream service and retry.`;
  if (status) return `Provider request failed (HTTP ${status}). Check the provider configuration.`;
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown; name?: unknown }; message?: unknown } | null;
  const name = typeof value?.name === "string" ? value.name : "";
  const code = typeof value?.code === "string" ? value.code : typeof value?.cause?.code === "string" ? value.cause.code : "";
  const message = typeof value?.message === "string" ? value.message : "";
  if (/timeout|timed out/i.test(name) || /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(`${code} ${message}`)) {
    return "Provider request timed out. Check the endpoint and network, then retry.";
  }
  if (/^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ERR_NETWORK)$/i.test(code) ||
    /fetch failed|network|connection refused|could not resolve/i.test(message) || error instanceof TypeError) {
    return "Provider is unreachable. Check the base URL, network connection, and whether the service is running.";
  }
  return "Provider connection failed. Check the base URL, credentials, and provider availability.";
}

class ProviderHttpError extends Error {
  constructor(readonly status: number) { super(`Provider returned HTTP ${status}`); }
}

const catalogRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function catalogAmount(value: unknown, scale = 1): number | undefined {
  const raw = typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : value;
  if (typeof raw !== "number" || raw < 0) return;
  const amount = raw * scale;
  if (Number.isFinite(amount)) return amount;
}

export function parseModelCatalog(payload: unknown, gemini = false): { models: string[]; pricing: ModelPricing[] } {
  const { data, models } = catalogRecord(payload);
  if (!Array.isArray(data) && !Array.isArray(models)) throw new Error("Unrecognized provider model list");
  const modelIds = new Set<string>();
  const prices = new Map<string, ModelPricing>();
  for (const item of [...(Array.isArray(data) ? data : []), ...(Array.isArray(models) ? models : [])]) {
    const entry = catalogRecord(item);
    const methods = entry.supportedGenerationMethods;
    if (gemini && Array.isArray(methods) && !methods.includes("generateContent")) continue;
    const id = typeof item === "string" ? item : typeof entry.id === "string" ? entry.id : entry.name;
    if (typeof id !== "string") continue;
    const modelId = (gemini ? id.replace(/^models\//, "") : id).trim();
    if (!modelId) continue;
    modelIds.add(modelId);
    if (prices.has(modelId)) continue;
    const price = catalogRecord(entry.pricing);
    const directInput = catalogAmount(price.inputPer1MUsd) ?? catalogAmount(price.input_per_1m_usd);
    const directOutput = catalogAmount(price.outputPer1MUsd) ?? catalogAmount(price.output_per_1m_usd);
    const direct = directInput !== undefined && directOutput !== undefined;
    const inputPer1MUsd = direct ? directInput : catalogAmount(price.prompt, 1_000_000);
    const outputPer1MUsd = direct ? directOutput : catalogAmount(price.completion, 1_000_000);
    if (inputPer1MUsd === undefined || outputPer1MUsd === undefined) continue;
    const cachedInputPer1MUsd = catalogAmount(price.cachedInputPer1MUsd) ?? catalogAmount(price.cached_input_per_1m_usd) ??
      catalogAmount(price.input_cache_read, 1_000_000);
    prices.set(modelId, { modelId, inputPer1MUsd, outputPer1MUsd,
      ...(cachedInputPer1MUsd === undefined ? {} : { cachedInputPer1MUsd }) });
  }
  return { models: [...modelIds], pricing: [...prices.values()] };
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly bindings: SlotBindings = {};
  private readonly cursor = new Map<string, number>();
  private readonly legacyFailures = new Map<string, KeyFailure>();

  constructor(private readonly bridge: Pick<RustBridge, "keyringGet">, private readonly options: {
    fetch?: typeof fetch;
    pricing?: readonly ModelPricing[];
    resolvePricing?: (modelId: string) => Promise<ModelPricing | null | undefined>;
    timeoutMs?: number;
    now?: () => number;
    keyCooldownMs?: number;
    gatewayRetryDelayMs?: number;
  } = {}) {}

  upsert(provider: ProviderConfig): ProviderConfig {
    const record = ProviderConfigSchema.parse(provider);
    record.baseUrl = providerUrl(record.baseUrl);
    if (record.keys && new Set(record.keys.map(({ id }) => id)).size !== record.keys.length) throw new Error("Provider key IDs must be unique");
    if (this.providers.get(record.id)?.keyringRef !== record.keyringRef) this.legacyFailures.delete(record.id);
    this.providers.set(record.id, record);
    return structuredClone(record);
  }

  get(id: string): ProviderConfig {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return structuredClone(provider);
  }

  list(): ProviderConfig[] { return [...this.providers.keys()].map((id) => this.get(id)); }

  remove(id: string): boolean {
    this.cursor.delete(id);
    this.legacyFailures.delete(id);
    for (const slot of ["solver", "improver", "judge"] as const) {
      if (this.bindings[slot]?.providerId === id) delete this.bindings[slot];
    }
    return this.providers.delete(id);
  }

  bind(slot: ModelSlot, binding: SlotBinding): void {
    const parsed = SlotBindingSchema.parse(binding);
    this.get(parsed.providerId);
    this.bindings[slot] = parsed;
  }

  getBindings(): SlotBindings { return structuredClone(this.bindings); }

  resolve(slot: ModelSlot, modelId?: string) { return this.resolveSlot(slot, modelId); }

  resolveSlot(slot: ModelSlot, modelId?: string): { provider: ProviderConfig; modelId: string } {
    const binding = this.bindings[slot];
    if (!binding) throw new Error(`No model configured for slot: ${slot}`);
    return this.resolveDirect(binding.providerId, modelId ?? binding.modelId);
  }

  resolveDirect(providerId: string, modelId?: string): { provider: ProviderConfig; modelId: string } {
    const provider = this.get(providerId);
    if (!provider.enabled) throw new Error(`Provider is disabled: ${provider.id}`);
    const selected = modelId ?? provider.models[0];
    if (!selected) throw new Error(`No model configured for provider: ${provider.id}`);
    return { provider, modelId: selected };
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  async acquireKey(providerId: string, excluded: ReadonlySet<string | null> = new Set()): Promise<ProviderCredential | undefined> {
    const provider = this.get(providerId);
    if (!provider.enabled) throw new Error(`Provider is disabled: ${provider.id}`);
    if (!provider.keys?.length) {
      if (excluded.has(null) || cooling(this.legacyFailures.get(providerId), this.now())) return;
      const secret = await this.bridge.keyringGet(provider.keyringRef);
      return secret || !provider.hasApiKey && isLoopback(provider.baseUrl) ? { keyId: null, secret } : undefined;
    }

    const keys = [...provider.keys].sort((a, b) => a.priority - b.priority);
    const roundRobin = provider.keyStrategy === "round_robin";
    const start = roundRobin ? (this.cursor.get(providerId) ?? 0) % keys.length : 0;
    for (let step = 0; step < keys.length; step++) {
      const index = (start + step) % keys.length;
      const key = keys[index]!;
      if (!key.enabled || excluded.has(key.id) || cooling(key, this.now())) continue;
      if (roundRobin) this.cursor.set(providerId, (index + 1) % keys.length);
      const secret = await this.bridge.keyringGet(key.keyringRef);
      if (secret) return { keyId: key.id, secret };
    }
    return undefined;
  }

  reportKeyFailure(providerId: string, keyId: string | null, reason: string, cooldownMs: number): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;
    const delay = Number.isFinite(cooldownMs) ? Math.min(Math.max(0, cooldownMs), 86_400_000) : 0;
    const failure = { lastError: reason, cooldownUntil: new Date(this.now() + delay).toISOString() };
    if (keyId === null) this.legacyFailures.set(providerId, failure);
    else {
      const key = provider.keys?.find(({ id }) => id === keyId);
      if (key) Object.assign(key, failure);
    }
  }

  clearLegacyKeyFailure(providerId: string): void { this.legacyFailures.delete(providerId); }

  async withKeyFailover<T>(providerId: string, work: (credential: ProviderCredential) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const tried = new Set<string | null>();
    let failure: ProviderHttpError | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const credential = await this.acquireKey(providerId, tried);
      if (!credential) throw failure ?? new Error(`No available keyring credential for provider: ${providerId}`);
      tried.add(credential.keyId);
      signal?.throwIfAborted();
      try { return await work(credential); }
      catch (error) {
        const status = httpStatus(error);
        if (status !== 401 && status !== 403 && status !== 429) throw error;
        failure = new ProviderHttpError(status);
        this.reportKeyFailure(providerId, credential.keyId, `HTTP ${status}`, this.options.keyCooldownMs ?? 60_000);
      }
    }
  }

  buildAggregatedCatalog(): AggregatedModelEntry[] {
    const entries: AggregatedModelEntry[] = [];
    const time = this.now();
    for (const provider of this.providers.values()) {
      if (!provider.enabled) continue;
      const isAggregator = provider.isAggregator ?? provider.source === "magpie";
      const activeKeyCount = provider.keys?.length ? provider.keys.filter((key) => key.enabled && !cooling(key, time)).length :
        Number((provider.hasApiKey || isLoopback(provider.baseUrl)) && !cooling(this.legacyFailures.get(provider.id), time));
      const pinned = new Set(provider.pinnedModels);
      for (const modelId of new Set(provider.models.filter(Boolean))) {
        const separator = modelId.indexOf("/");
        const grouped = isAggregator && separator > 0 && separator < modelId.length - 1;
        const upstreamGroup = grouped ? modelId.slice(0, separator) : undefined;
        entries.push({
          catalogId: `${provider.id}::${modelId}`, providerId: provider.id, providerName: provider.name, providerKind: provider.kind,
          providerSource: provider.source, modelId, displayName: grouped ? modelId.slice(separator + 1) : modelId, upstreamGroup,
          isAggregator, isRoutingGroup: upstreamGroup === "group", pinned: pinned.has(modelId), activeKeyCount,
        });
      }
    }
    const rank = (entry: AggregatedModelEntry) => entry.pinned ? 0 : entry.isRoutingGroup ? 1 : entry.isAggregator ? 2 : 3;
    return entries.sort((a, b) => rank(a) - rank(b) || (a.upstreamGroup ?? "").localeCompare(b.upstreamGroup ?? "") ||
      a.providerName.localeCompare(b.providerName) || a.displayName.localeCompare(b.displayName));
  }

  private async sdkClient(provider: ProviderConfig, modelId: string, key: string | null): Promise<LlmClient> {
    const separator = modelId.lastIndexOf("/");
    const resolved = await this.options.resolvePricing?.(modelId);
    const pricing = resolved === undefined ? this.options.pricing?.find((entry) => entry.modelId === modelId) ??
      (separator < 0 ? undefined : this.options.pricing?.find((entry) => entry.modelId === modelId.slice(separator + 1))) : resolved ?? undefined;
    const baseURL = provider.baseUrl;
    const sdkOptions = { baseURL, maxRetries: 0, timeout: this.options.timeoutMs ?? 120_000, fetch: this.options.fetch };
    if (provider.kind === "anthropic") {
      return new AnthropicLlmClient(new Anthropic({ ...sdkOptions, baseURL: baseURL.replace(/\/v1$/, ""), apiKey: key ?? "local" }), modelId, pricing);
    }
    if (provider.kind === "gemini") {
      const match = baseURL.match(/^(.*)\/(v1(?:beta|alpha)?)$/);
      return new GeminiLlmClient(new GoogleGenAI({ apiKey: key ?? "local", httpOptions: {
        baseUrl: match?.[1] ?? baseURL, apiVersion: match?.[2], timeout: sdkOptions.timeout,
      } }), modelId, pricing);
    }
    return new OpenAiLlmClient(new OpenAI({ ...sdkOptions, apiKey: key ?? "local",
      baseURL: provider.kind === "ollama" && !baseURL.endsWith("/v1") ? `${baseURL}/v1` : baseURL,
    }), modelId, pricing, provider.kind);
  }

  async client(slot: ModelSlot, override?: string, providerIdOverride?: string): Promise<LlmClient> {
    const binding = this.bindings[slot];
    const { provider, modelId } = providerIdOverride ? this.resolveDirect(providerIdOverride,
      override ?? (binding?.providerId === providerIdOverride ? binding.modelId : undefined)) : this.resolveSlot(slot, override);
    const registry = this;
    return {
      complete: (request) => {
        const { signal } = request;
        let gatewayRetries = 0;
        return this.withKeyFailover(provider.id, async ({ secret }) => {
          const client = await this.sdkClient(provider, modelId, secret);
          for (;;) {
            signal?.throwIfAborted();
            try { return { ...await client.complete({ ...request, modelId }), modelId }; }
            catch (error) {
              signal?.throwIfAborted();
              const status = httpStatus(error);
              if (gatewayRetries >= 2 || (status !== 502 && status !== 503 && status !== 504)) throw error;
              const delay = (this.options.gatewayRetryDelayMs ?? 400) * (gatewayRetries++ === 0 ? 1 : 3);
              await sleep(delay, undefined, { signal });
            }
          }
        }, signal);
      },
      async *stream(request): AsyncIterable<LlmStreamChunk> {
        const { signal } = request;
        let gatewayRetries = 0;
        const { iterator, first } = await registry.withKeyFailover(provider.id, async ({ secret }) => {
          const client = await registry.sdkClient(provider, modelId, secret);
          for (;;) {
            signal?.throwIfAborted();
            try {
              const iterator = client.stream({ ...request, modelId })[Symbol.asyncIterator]();
              return { iterator, first: await iterator.next() };
            } catch (error) {
              signal?.throwIfAborted();
              const status = httpStatus(error);
              if (gatewayRetries >= 2 || (status !== 502 && status !== 503 && status !== 504)) throw error;
              const delay = (registry.options.gatewayRetryDelayMs ?? 400) * (gatewayRetries++ === 0 ? 1 : 3);
              await sleep(delay, undefined, { signal });
            }
          }
        }, signal);
        try {
          for (let item = first; !item.done; item = await iterator.next()) {
            yield item.value.type === "done" ? { ...item.value, modelId } : item.value;
          }
        } finally { await iterator.return?.(); }
      },
    };
  }

  async listModels(providerId: string): Promise<string[]> {
    return (await this.listModelCatalog(providerId)).models;
  }

  async listModelCatalog(providerId: string) {
    const provider = this.get(providerId);
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 5_000);
    return this.withKeyFailover(providerId, ({ secret }) => this.fetchModels(provider, secret, signal), signal);
  }

  private async fetchModels(provider: ProviderConfig, key: string | null, signal: AbortSignal) {
    let base = provider.baseUrl;
    const headers: Record<string, string> = {};
    if (provider.kind === "gemini") {
      if (!/\/v1(?:beta|alpha)?$/.test(base)) base += "/v1beta";
      if (key) headers["x-goog-api-key"] = key;
    } else if (provider.kind === "anthropic") {
      if (!base.endsWith("/v1")) base += "/v1";
      headers["anthropic-version"] = "2023-06-01";
      if (key) headers["x-api-key"] = key;
    } else {
      if (provider.kind === "ollama" && !base.endsWith("/v1")) base += "/v1";
      if (key) headers.authorization = `Bearer ${key}`;
    }
    const modelIds = new Set<string>();
    const prices = new Map<string, ModelPricing>();
    const url = new URL(`${base}/models`);
    while (true) {
      const response = await (this.options.fetch ?? fetch)(url, { headers, signal, redirect: "error" });
      if (!response.ok) throw new ProviderHttpError(response.status);
      const result = catalogRecord(await response.json());
      const catalog = parseModelCatalog(result, provider.kind === "gemini");
      for (const id of catalog.models) modelIds.add(id);
      for (const price of catalog.pricing) if (!prices.has(price.modelId)) prices.set(price.modelId, price);
      const cursor = provider.kind === "gemini" ? "pageToken" : "after_id";
      const next = provider.kind === "gemini" ? result.nextPageToken : provider.kind === "anthropic" && result.has_more === true ? result.last_id : undefined;
      if (typeof next !== "string" || !next || next === url.searchParams.get(cursor)) break;
      url.searchParams.set(cursor, next);
    }
    return { models: [...modelIds], pricing: [...prices.values()] };
  }

  async ping(providerId: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const models = await this.listModels(providerId);
      const latencyMs = elapsed();
      const provider = this.providers.get(providerId);
      if (provider) this.upsert({ ...provider, models, lastPingMs: latencyMs });
      return { ok: true, latencyMs };
    } catch (error) {
      return { ok: false, latencyMs: elapsed(), error: pingFailure(error) };
    }
  }
}

export class RoutedLlmClient implements LlmClient {
  constructor(private readonly registry: ProviderRegistry) {}

  async complete(request: RoutedLlmRequest) {
    return (await this.registry.client(request.slot, request.modelId, request.providerIdOverride)).complete(request);
  }

  async *stream(request: RoutedLlmRequest) {
    yield* (await this.registry.client(request.slot, request.modelId, request.providerIdOverride)).stream(request);
  }
}
