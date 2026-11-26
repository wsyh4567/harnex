import { lookup } from "node:dns/promises";
import type { LlmToolDef } from "@harnex/interfaces";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

export const WEB_FETCH_TOOL_DEF: LlmToolDef = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    "Fetch a public HTTP(S) webpage or text/JSON resource and return cleaned readable text/Markdown. Read-only; private, loopback, link-local, metadata, and local-network addresses are blocked.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http:// or https:// URL to fetch" },
      maxChars: { type: "number", description: "Optional max output characters (default 16000, max 32000)" },
    },
    required: ["url"],
  },
};

export interface WebFetchOptions {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  lookupHost?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  content: string;
  truncated: boolean;
  bytesRead: number;
}

const DEFAULT_MAX_CHARS = 16_000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 32_000;

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_BYTES = 512 * 1024;

const DEFAULT_MAX_REDIRECTS = 3;
const MAX_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const ALLOWED_EXACT_CONTENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/ld+json",
]);

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  laquo: "\u00ab",
  raquo: "\u00bb",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
};

function parseIpv4Octets(input: string): [number, number, number, number] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  const d = octets[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function isBlockedIpv4Octets([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true; // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved/broadcast)
  return false;
}

function parseIpv6Hextets(input: string): number[] | null {
  if (!input.includes(":")) return null;

  let normalized = input;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) return null;
    const prefix = normalized.slice(0, lastColon + 1);
    const ipv4Part = normalized.slice(lastColon + 1);
    const octets = parseIpv4Octets(ipv4Part);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${prefix}${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const values: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      values.push(parseInt(group, 16));
    }
    return values;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(doubleColonParts[0] ?? "");
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const left = parseGroups(doubleColonParts[0] ?? "");
  const right = parseGroups(doubleColonParts[1] ?? "");
  if (!left || !right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function hextetsToIpv4Octets(hi: number, lo: number): [number, number, number, number] {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isBlockedIpv6Hextets(groups: number[]): boolean {
  const g0 = groups[0] ?? 0;
  const g1 = groups[1] ?? 0;
  const g2 = groups[2] ?? 0;
  const g3 = groups[3] ?? 0;
  const g4 = groups[4] ?? 0;
  const g5 = groups[5] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;

  // :: (unspecified) and ::1 (loopback)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    // IPv4-compatible IPv6 (::/96, deprecated)
    return isBlockedIpv4Octets(hextetsToIpv4Octets(g6, g7));
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4Octets(hextetsToIpv4Octets(g6, g7));
  }

  // IPv4-translated IPv6 (::ffff:0:0:0/96)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isBlockedIpv4Octets(hextetsToIpv4Octets(g6, g7));
  }

  // NAT64 well-known prefix (64:ff9b::/96)
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4Octets(hextetsToIpv4Octets(g6, g7));
  }

  // fc00::/7 (Unique Local Address)
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // fe80::/10 (Link-Local)
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // fec0::/10 (Deprecated Site-Local)
  if ((g0 & 0xffc0) === 0xfec0) return true;

  // ff00::/8 (Multicast)
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

export function isBlockedIp(ip: string): boolean {
  let candidate = ip.trim();
  if (!candidate) return true;

  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }

  // Scoped IPv6 zone identifiers (e.g. fe80::1%eth0) are always local-scoped.
  if (candidate.includes("%")) return true;

  const ipv4 = parseIpv4Octets(candidate);
  if (ipv4) return isBlockedIpv4Octets(ipv4);

  const ipv6 = parseIpv6Hextets(candidate);
  if (ipv6) return isBlockedIpv6Hextets(ipv6);

  // Fail closed on malformed/unrecognized IP strings.
  return true;
}

function isIpLiteral(hostname: string): string | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const inner = hostname.slice(1, -1);
    if (inner.includes("%")) return inner;
    return parseIpv6Hextets(inner) ? inner : null;
  }
  if (parseIpv4Octets(hostname)) return hostname;
  if (parseIpv6Hextets(hostname)) return hostname;
  return null;
}

function validateUrlAndExtractHost(rawUrl: string, baseUrl?: URL): { parsed: URL; host: string; literalIp: string | null } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("web_fetch requires a non-empty URL");
  }

  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL scheme "${parsed.protocol}"; only http: and https: are allowed`);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Blocked URL with embedded credentials");
  }

  const rawHostname = parsed.hostname;
  if (!rawHostname) {
    throw new Error("URL is missing a hostname");
  }

  if (rawHostname.startsWith("[") || rawHostname.endsWith("]")) {
    const literal = isIpLiteral(rawHostname);
    if (!literal) {
      throw new Error(`Invalid IPv6 literal hostname: ${rawHostname}`);
    }
    return { parsed, host: literal, literalIp: literal };
  }

  const literal = isIpLiteral(rawHostname);
  if (literal) {
    return { parsed, host: literal, literalIp: literal };
  }

  const normalizedHost = rawHostname.toLowerCase().replace(/\.+$/, "");
  if (
    !normalizedHost ||
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".internal") ||
    normalizedHost === "metadata.google.internal"
  ) {
    throw new Error(`Blocked local or internal hostname: ${rawHostname}`);
  }

  if (!normalizedHost.includes(".")) {
    throw new Error(`Blocked single-label hostname: ${rawHostname}`);
  }

  if (normalizedHost.startsWith(".") || normalizedHost.includes("..")) {
    throw new Error(`Invalid hostname: ${rawHostname}`);
  }

  return { parsed, host: normalizedHost, literalIp: null };
}

async function defaultLookupHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function assertSafeHop(
  rawUrl: string,
  lookupHost: (hostname: string) => Promise<string[]>,
  baseUrl?: URL,
): Promise<URL> {
  const { parsed, host, literalIp } = validateUrlAndExtractHost(rawUrl, baseUrl);

  if (literalIp !== null) {
    if (isBlockedIp(literalIp)) {
      throw new Error(`Blocked IP address: ${literalIp}`);
    }
    return parsed;
  }

  const addresses = await lookupHost(host);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for host: ${host}`);
  }

  for (const address of addresses) {
    if (typeof address !== "string" || isBlockedIp(address)) {
      throw new Error(`Blocked resolved IP address "${String(address)}" for host "${host}"`);
    }
  }

  return parsed;
}

function isAllowedContentType(rawContentType: string): { allowed: boolean; mediaType: string } {
  const mediaType = (rawContentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "") return { allowed: true, mediaType };
  if (mediaType.startsWith("text/")) return { allowed: true, mediaType };
  if (ALLOWED_EXACT_CONTENT_TYPES.has(mediaType)) return { allowed: true, mediaType };
  return { allowed: false, mediaType };
}

function extractCharset(rawContentType: string): string {
  const match = /;\s*charset\s*=\s*["']?([^"';\s]+)["']?/i.exec(rawContentType);
  return match?.[1]?.trim().toLowerCase() ?? "utf-8";
}

type TextDecoderEncoding = ConstructorParameters<typeof TextDecoder>[0];

function createTextDecoder(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset as TextDecoderEncoding, { fatal: false });
  } catch {
    return new TextDecoder("utf-8", { fatal: false });
  }
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = parseInt(body.slice(2), 16);
      if (codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) {
        return String.fromCodePoint(codePoint);
      }
      return full;
    }
    if (body.startsWith("#")) {
      const codePoint = parseInt(body.slice(1), 10);
      if (codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) {
        return String.fromCodePoint(codePoint);
      }
      return full;
    }
    const named = NAMED_HTML_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : full;
  });
}

export function htmlToReadableText(html: string): { title?: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleMatch?.[1];
  const decodedTitle = rawTitle
    ? decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
    : "";

  let cleaned = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?(?:<\/noscript>|$)/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?(?:<\/svg>|$)/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?(?:<\/template>|$)/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "");

  // Structural Markdown-ish cues before stripping tags.
  cleaned = cleaned
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ")
    .replace(/<\/blockquote>/gi, "\n\n")
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<\/?tr\b[^>]*>/gi, "\n")
    .replace(/<\/?(?:p|section|article|main|header|footer|aside|nav|ul|ol|table|pre|figure|figcaption|dl)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?(?:div|dt|dd|thead|tbody|tfoot|t[dh])\b[^>]*>/gi, "\n");

  // Strip remaining HTML tags (including any trailing incomplete tag from byte truncation) and decode entities in one pass.
  const withoutTags = cleaned.replace(/<[^>]+>/g, "").replace(/<[^>]*$/, "");
  const decoded = decodeHtmlEntities(withoutTags).replace(/\r\n?/g, "\n");

  // Normalize per-line horizontal whitespace while keeping paragraph breaks.
  const lines = decoded.split("\n").map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());
  const normalized = lines
    .join("\n")
    .replace(/^(#{1,6}|-|>) *\n+([^\n])/gm, "$1 $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (decodedTitle) {
    return { title: decodedTitle, text: normalized };
  }
  return { text: normalized };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function readStreamWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  charset: string,
  signal: AbortSignal,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  if (!body) {
    return { text: "", bytesRead: 0, truncated: false };
  }

  const reader = body.getReader();
  const decoder = createTextDecoder(charset);
  let bytesRead = 0;
  let truncated = false;
  let text = "";

  const abortError = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error("web_fetch aborted");

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    onAbort = () => {
      reject(abortError());
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Prevent unhandled rejection if the stream finishes before abort fires.
  abortPromise.catch(() => {});

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw abortError();
      }

      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw abortError();
      }
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: true });
          bytesRead += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }

      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }

    text += decoder.decode();
    return { text, bytesRead, truncated };
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    reader.releaseLock();
  }
}

export async function executeWebFetch(options: WebFetchOptions): Promise<WebFetchResult> {
  const maxChars = clampInteger(options.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxBytes =
    options.maxBytes !== undefined && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_MAX_BYTES;
  const maxRedirects = clampInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, MAX_MAX_REDIRECTS);
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort(options.signal?.reason ?? new Error("web_fetch aborted by caller"));
  };

  if (options.signal) {
    if (options.signal.aborted) {
      onExternalAbort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`web_fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    let currentUrl = await assertSafeHop(options.url, lookupHost);
    const initialUrl = currentUrl.href;
    let redirects = 0;

    while (true) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("web_fetch aborted");
      }

      const response = await fetchImpl(currentUrl.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html, application/xhtml+xml, application/xml;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1",
          "User-Agent": "Harnex-WebFetch/1.0",
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect response (${response.status}) is missing Location header`);
        }
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new Error(`Too many redirects (exceeded maxRedirects=${maxRedirects})`);
        }
        currentUrl = await assertSafeHop(location, lookupHost, currentUrl);
        continue;
      }

      const rawContentType = response.headers.get("content-type") ?? "";
      const { allowed, mediaType } = isAllowedContentType(rawContentType);
      if (!allowed) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Blocked non-text content-type: ${mediaType}`);
      }

      const charset = extractCharset(rawContentType);
      const streamResult = await readStreamWithLimit(response.body, maxBytes, charset, controller.signal);

      let title: string | undefined;
      let content: string;
      if (HTML_CONTENT_TYPES.has(mediaType)) {
        const parsedHtml = htmlToReadableText(streamResult.text);
        title = parsedHtml.title;
        content = parsedHtml.text;
      } else {
        content = streamResult.text;
      }

      let truncated = streamResult.truncated;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
      }

      const result: WebFetchResult = {
        url: initialUrl,
        finalUrl: currentUrl.href,
        status: response.status,
        contentType: rawContentType,
        content,
        truncated,
        bytesRead: streamResult.bytesRead,
      };
      if (title !== undefined) {
        result.title = title;
      }
      return result;
    }
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
