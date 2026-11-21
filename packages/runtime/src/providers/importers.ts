import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProviderKindSchema, type ModelPricing, type ProviderConfig, type ProviderImportResult, type ProviderKind } from "@harnex/protocol";
import { isLoopback, parseModelCatalog, providerUrl } from "./registry.ts";

type Source = ProviderImportResult["source"];
type Row = Record<string, unknown>;

export interface ProviderImportOptions {
  /** Supply the Rust keyring writer when integrating provider imports. */
  keyringPut?: (keyringRef: string, secret: string) => Promise<void>;
}

const ccProxy = "http://127.0.0.1:15721";
const magpieGateway = "http://127.0.0.1:3425";
const string = (...values: unknown[]) => values.find((val): val is string => typeof val === "string" && !!val.trim())?.trim();
const object = (value: unknown): Row => {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
};
const enabled = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";

const resultFor = (source: Source, detected: boolean, importedProviders: ProviderConfig[], warnings: string[]): ProviderImportResult => ({
  source, detected, importedProviders, warnings, fallbackToManual: importedProviders.length === 0 ||
    importedProviders.every((provider) => !provider.enabled),
});

function kindOf(value: unknown): ProviderKind {
  const name = typeof value === "string" ? value.toLowerCase().replaceAll("-", "_") : "";
  const parsed = ProviderKindSchema.safeParse(name);
  if (parsed.success) return parsed.data;
  if (["claude", "claude_code"].includes(name)) return "anthropic";
  if (name === "codex") return "openai";
  if (["google", "google_genai"].includes(name)) return "gemini";
  return "openai_compatible";
}

const defaultBase: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com", ollama: "http://127.0.0.1:11434",
  openai_compatible: "",
};

async function providerFromRow(
  row: Row, source: Source, options: ProviderImportOptions, warnings: string[], proxy?: string,
): Promise<ProviderConfig | undefined> {
  const settings = object(row.settings_config ?? row.settingsConfig ?? row.settings ?? row.config);
  const env = object(settings.env ?? row.env);
  const auth = object(settings.auth ?? row.auth);
  const app = string(row.app_type, row.appType, row.kind, row.providerType, row.type);
  let kind = kindOf(app);
  const toml = string(settings.config) ?? "";
  const baseFromRow = string(row.baseUrl, row.base_url, row.endpoint, row.url, settings.baseUrl, settings.base_url,
    env.ANTHROPIC_BASE_URL, env.OPENAI_BASE_URL, env.GOOGLE_GEMINI_BASE_URL, env.GEMINI_BASE_URL,
    toml.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1]);
  const base = proxy ?? baseFromRow ?? defaultBase[kind];
  if (!base) return undefined;
  const baseUrl = providerUrl(base);
  if (kind === "openai" && !baseUrl.startsWith("https://api.openai.com/")) kind = "openai_compatible";
  const rawId = string(row.id, row.name) ?? kind;
  const id = `${source}:${app ?? kind}:${rawId}`;
  const keyringRef = `harnex:${id}`;
  const secret = proxy ? undefined : string(row.apiKey, row.api_key, row.token, settings.apiKey, settings.api_key,
    auth.OPENAI_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GEMINI_API_KEY, env.GOOGLE_API_KEY);
  let hasApiKey = !proxy && string(row.keyringRef, row.keyring_ref) === keyringRef;
  if (secret && options.keyringPut) {
    try { await options.keyringPut(keyringRef, secret); hasApiKey = true; }
    catch { warnings.push("The imported API key could not be saved to the OS keyring."); }
  } else if (secret && !hasApiKey) warnings.push("Set the imported provider’s API key in the OS keyring to use it directly.");
  const models = Array.isArray(row.models ?? settings.models) ? (row.models ?? settings.models) as unknown[] : [];
  return {
    id, name: string(row.name, row.label) ?? (proxy ? `${source} local gateway` : rawId), kind, baseUrl,
    models: [...new Set([...models.map((model) => string(model, object(model).id, object(model).name)),
      string(row.model, settings.model, env.ANTHROPIC_MODEL, env.GEMINI_MODEL, toml.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]),
    ].filter((model): model is string => !!model))],
    keyringRef, hasApiKey, source, enabled: hasApiKey || isLoopback(baseUrl),
  };
}

export async function importCcSwitch(options: ProviderImportOptions & { dbPath?: string } = {}): Promise<ProviderImportResult> {
  const source = "cc-switch";
  const uri = pathToFileURL(options.dbPath ?? join(homedir(), ".cc-switch", "cc-switch.db"));
  uri.search = "mode=ro&immutable=1";
  let db: Database;
  try {
    db = new Database(uri.href, 0x00000001 | 0x00000040); // SQLITE_OPEN_READONLY | SQLITE_OPEN_URI
  } catch {
    return resultFor(source, false, [], ["The CC Switch database could not be opened read-only."]);
  }
  try {
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    const table = ["providers", "provider_configs", "provider"].find((name) => tables.has(name));
    if (!table) return resultFor(source, true, [], ["The CC Switch database schema is unrecognized."]);
    const proxyRows = tables.has("proxy_config") ? db.query<Row, []>("SELECT * FROM proxy_config").all() : [];
    const providers: ProviderConfig[] = [], warnings: string[] = [];
    for (const row of db.query<Row, []>(`SELECT * FROM ${table}`).all()) {
      const app = string(row.app_type, row.appType);
      const proxy = proxyRows.find((item) => (!item.app_type || item.app_type === app) &&
        (item.proxy_enabled === undefined || enabled(item.proxy_enabled)) && enabled(item.enabled ?? item.proxy_enabled));
      const isActive = row.is_current === undefined || enabled(row.is_current);
      try {
        const proxyUrl = proxy && isActive ? `${ccProxy.replace(/:\d+$/, "")}:${Number(proxy.listen_port) || 15721}` : undefined;
        const compatProxy = proxyUrl && !["anthropic", "gemini"].includes(kindOf(app)) ? `${proxyUrl}/v1` : proxyUrl;
        const provider = await providerFromRow(row, source, options, warnings, compatProxy);
        if (provider) providers.push(provider);
      } catch { warnings.push("A CC Switch entry has an invalid endpoint and was skipped."); }
    }
    if (!providers.length) warnings.push("No supported providers were found in the CC Switch database.");
    return resultFor(source, true, providers, [...new Set(warnings)]);
  } catch {
    return resultFor(source, true, [], ["The CC Switch database schema could not be read."]);
  } finally { db.close(); }
}

export async function importMagpie(options: ProviderImportOptions & {
  baseUrl?: string; configPath?: string; importLink?: string; fetch?: typeof fetch; timeoutMs?: number;
} = {}): Promise<ProviderImportResult & { modelPricing?: ModelPricing[] }> {
  const source = "magpie";
  const warnings: string[] = [];
  try {
    const base = providerUrl(options.baseUrl ?? magpieGateway);
    const endpoint = base.endsWith("/v1") ? base : `${base}/v1`;
    const response = await (options.fetch ?? fetch)(`${endpoint}/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500), redirect: "error",
    });
    if (response.ok) {
      const { models, pricing } = parseModelCatalog(await response.json());
      const provider = await providerFromRow({ id: "gateway", name: "Magpie local gateway", baseUrl: endpoint,
        models }, source, options, warnings);
      if (provider) return { ...resultFor(source, true, [{ ...provider, isAggregator: true }], warnings), modelPricing: pricing };
    }
  } catch { /* A missing gateway can still have an importable config. */ }
  warnings.push("The Magpie local gateway did not return a model list.");
  let detected = false;
  const rows: unknown[] = [];
  if (options.importLink) {
    try {
      const link = new URL(options.importLink);
      if (link.protocol !== "magpie:" || link.hostname !== "import") throw new Error("Invalid link");
      detected = true;
      const fields = Object.fromEntries(link.searchParams);
      rows.push({ ...object(fields.config ?? fields.provider), ...fields });
    } catch { warnings.push("The Magpie import link is invalid."); }
  }
  try {
    const file = Bun.file(options.configPath ?? join(homedir(), ".magpie", "config.json"));
    if (await file.exists()) {
      detected = true;
      const config = object(await file.json());
      const providers = config.providers;
      rows.push(...(Array.isArray(providers) ? providers : providers ?
        Object.entries(object(providers)).map(([id, value]) => ({ id, ...object(value) })) : [config]));
    }
  } catch { warnings.push("The Magpie config could not be read."); }
  const imported = new Map<string, ProviderConfig>();
  for (const entry of rows) {
    try {
      const provider = await providerFromRow(object(entry), source, options, warnings);
      if (provider && !imported.has(provider.id)) imported.set(provider.id, provider);
    } catch { warnings.push("A Magpie entry has an invalid endpoint and was skipped."); }
  }
  return resultFor(source, detected, [...imported.values()], [...new Set(warnings)]);
}
