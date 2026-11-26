import { describe, expect, test } from "bun:test";
import {
  WEB_FETCH_TOOL_DEF,
  WEB_FETCH_TOOL_NAME,
  executeWebFetch,
  htmlToReadableText,
  isBlockedIp,
} from "./web_fetch.ts";

function makeMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return await handler(url, init);
  }) as typeof fetch;
}

describe("WEB_FETCH_TOOL_DEF", () => {
  test("exports frozen tool name and schema", () => {
    expect(WEB_FETCH_TOOL_NAME).toBe("web_fetch");
    expect(WEB_FETCH_TOOL_DEF.name).toBe("web_fetch");
    expect(WEB_FETCH_TOOL_DEF.description.toLowerCase()).toContain("public");
    expect(WEB_FETCH_TOOL_DEF.inputSchema).toMatchObject({
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        maxChars: { type: "number" },
      },
    });
  });
});

describe("isBlockedIp", () => {
  test("blocks IPv4 loopback, RFC1918, metadata, CGNAT, link-local, multicast, and reserved ranges", () => {
    const blockedIpv4 = [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.24.10.2",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.0.1",
      "192.168.255.254",
      "198.18.0.1",
      "198.19.255.255",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
    ];

    for (const ip of blockedIpv4) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  test("blocks IPv6 unspecified, loopback, ULA, link-local, multicast, and IPv4-mapped private addresses", () => {
    const blockedIpv6 = [
      "::",
      "0:0:0:0:0:0:0:0",
      "::1",
      "[::1]",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "febf::1234",
      "fe80::1%eth0",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:192.168.1.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:7f00:0001",
      "[::ffff:7f00:1]",
      "::127.0.0.1",
      "64:ff9b::127.0.0.1",
    ];

    for (const ip of blockedIpv6) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  test("allows public IPv4, IPv6, and IPv4-mapped public IPv6 addresses", () => {
    const publicIps = [
      "93.184.216.34",
      "1.1.1.1",
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.0.1.1",
      "198.17.255.255",
      "198.20.0.1",
      "2606:2800:220:1::1",
      "2001:4860:4860::8888",
      "::ffff:93.184.216.34",
      "::ffff:5db8:d822",
    ];

    for (const ip of publicIps) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  test("fails closed on empty or malformed IP strings", () => {
    expect(isBlockedIp("")).toBe(true);
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.1.1.1")).toBe(true);
    expect(isBlockedIp("1::2::3")).toBe(true);
  });
});

describe("htmlToReadableText", () => {
  test("strips script/style/noscript/svg/template/comments, extracts title, decodes entities, and preserves structure", () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>Harnex &amp; Docs &#8212; Guide</title>
          <style>body { color: red; }</style>
          <script>window.secret = "do-not-leak";</script>
        </head>
        <body>
          <!-- hidden comment -->
          <noscript>Enable JS</noscript>
          <svg><text>SVG Noise</text></svg>
          <template><p>Template Noise</p></template>
          <article>
            <h1>Welcome to &lt;Harnex&gt;</h1>
            <p>Safe&nbsp;fetching for &quot;agents&quot; &amp; &#39;tools&#39; &#x2713;.</p>
            <h2>Features</h2>
            <ul>
              <li>First item</li>
              <li>Second item</li>
            </ul>
            <blockquote>Quoted note</blockquote>
          </article>
        </body>
      </html>`;

    const result = htmlToReadableText(html);
    expect(result.title).toBe("Harnex & Docs \u2014 Guide");
    expect(result.text).toContain("# Welcome to <Harnex>");
    expect(result.text).toContain('Safe fetching for "agents" & \'tools\' \u2713.');
    expect(result.text).toContain("## Features");
    expect(result.text).toContain("- First item");
    expect(result.text).toContain("- Second item");
    expect(result.text).toContain("> Quoted note");
    expect(result.text).not.toContain("do-not-leak");
    expect(result.text).not.toContain("color: red");
    expect(result.text).not.toContain("hidden comment");
    expect(result.text).not.toContain("Enable JS");
    expect(result.text).not.toContain("SVG Noise");
    expect(result.text).not.toContain("Template Noise");
  });

  test("omits title when missing, strips truncated unclosed script, and does not double-decode HTML entities", () => {
    const result = htmlToReadableText("<p>&amp;lt;script&amp;gt;</p><script>const leaked = 'nope");
    expect(result.title).toBeUndefined();
    expect(result.text).toBe("&lt;script&gt;");
  });
});

describe("executeWebFetch security guardrails", () => {
  const neverCalledFetch = makeMockFetch(() => {
    throw new Error("fetchImpl should not have been called");
  });
  const neverCalledLookup = async () => {
    throw new Error("lookupHost should not have been called");
  };

  test("rejects disallowed URL schemes", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/file.txt", "javascript:alert(1)", "data:text/plain,hi"]) {
      await expect(
        executeWebFetch({ url, fetchImpl: neverCalledFetch, lookupHost: neverCalledLookup }),
      ).rejects.toThrow(/scheme/i);
    }
  });

  test("rejects URLs with embedded credentials", async () => {
    for (const url of ["https://user:pass@example.com/", "https://token@example.com/page", "https://:secret@example.com/"]) {
      await expect(
        executeWebFetch({ url, fetchImpl: neverCalledFetch, lookupHost: neverCalledLookup }),
      ).rejects.toThrow(/credential/i);
    }
  });

  test("rejects localhost, local/internal domains, metadata hostnames, and single-label hostnames", async () => {
    const blockedUrls = [
      "http://localhost/admin",
      "http://localhost./admin",
      "http://api.localhost:3000/",
      "http://printer.local/",
      "http://service.internal/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://intranet/dashboard",
    ];
    for (const url of blockedUrls) {
      await expect(
        executeWebFetch({ url, fetchImpl: neverCalledFetch, lookupHost: neverCalledLookup }),
      ).rejects.toThrow(/blocked/i);
    }
  });

  test("blocks literal private IPv4 and IPv6 hostnames directly without DNS lookup", async () => {
    const blockedLiterals = [
      "http://127.0.0.1/secret",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://2130706433/",
    ];
    for (const url of blockedLiterals) {
      await expect(
        executeWebFetch({ url, fetchImpl: neverCalledFetch, lookupHost: neverCalledLookup }),
      ).rejects.toThrow(/blocked/i);
    }
  });

  test("blocks DNS resolving to a private IP, including mixed public + private multi-record responses", async () => {
    await expect(
      executeWebFetch({
        url: "https://rebind.example.com/",
        lookupHost: async () => ["10.0.0.42"],
        fetchImpl: neverCalledFetch,
      }),
    ).rejects.toThrow(/blocked resolved ip/i);

    await expect(
      executeWebFetch({
        url: "https://dual-record.example.com/",
        lookupHost: async () => ["93.184.216.34", "169.254.169.254"],
        fetchImpl: neverCalledFetch,
      }),
    ).rejects.toThrow(/blocked resolved ip/i);

    await expect(
      executeWebFetch({
        url: "https://empty-dns.example.com/",
        lookupHost: async () => [],
        fetchImpl: neverCalledFetch,
      }),
    ).rejects.toThrow(/no addresses/i);
  });

  test("blocks redirect to private IP or internal DNS target before following", async () => {
    const fetchedUrls: string[] = [];
    const fetchImpl = makeMockFetch((url, init) => {
      fetchedUrls.push(url);
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    });

    await expect(
      executeWebFetch({
        url: "https://example.com/start",
        lookupHost: async () => ["93.184.216.34"],
        fetchImpl,
      }),
    ).rejects.toThrow(/blocked ip/i);
    expect(fetchedUrls).toEqual(["https://example.com/start"]);

    const fetchedUrls2: string[] = [];
    const fetchImpl2 = makeMockFetch((url) => {
      fetchedUrls2.push(url);
      return new Response(null, {
        status: 307,
        headers: { location: "https://internal-target.example.com/secret" },
      });
    });

    await expect(
      executeWebFetch({
        url: "https://public.example.com/start",
        lookupHost: async (host) => (host === "public.example.com" ? ["93.184.216.34"] : ["192.168.1.10"]),
        fetchImpl: fetchImpl2,
      }),
    ).rejects.toThrow(/blocked resolved ip/i);
    expect(fetchedUrls2).toEqual(["https://public.example.com/start"]);
  });

  test("blocks excessive redirects beyond maxRedirects", async () => {
    let hops = 0;
    const fetchImpl = makeMockFetch((url) => {
      hops += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/step-${hops}` },
      });
    });

    await expect(
      executeWebFetch({
        url: "https://example.com/step-0",
        maxRedirects: 2,
        lookupHost: async () => ["93.184.216.34"],
        fetchImpl,
      }),
    ).rejects.toThrow(/too many redirects/i);
    expect(hops).toBe(3);
  });

  test("rejects binary content types such as image/png", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      },
      cancel() {
        cancelled = true;
      },
    });

    const fetchImpl = makeMockFetch(
      () => new Response(stream, { status: 200, headers: { "content-type": "image/png" } }),
    );

    await expect(
      executeWebFetch({
        url: "https://example.com/logo.png",
        lookupHost: async () => ["93.184.216.34"],
        fetchImpl,
      }),
    ).rejects.toThrow(/content-type/i);
    expect(cancelled).toBe(true);
  });
});

describe("executeWebFetch streaming, truncation, and happy paths", () => {
  test("stops reading streaming response once maxBytes is exceeded without consuming full stream", async () => {
    const chunkSize = 256;
    const totalChunks = 50;
    let producedChunks = 0;
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (producedChunks >= totalChunks) {
          controller.close();
          return;
        }
        producedChunks += 1;
        controller.enqueue(new TextEncoder().encode("a".repeat(chunkSize)));
      },
      cancel() {
        cancelled = true;
      },
    });

    const fetchImpl = makeMockFetch(
      () => new Response(stream, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );

    const result = await executeWebFetch({
      url: "https://example.com/big.txt",
      maxBytes: 600,
      lookupHost: async () => ["93.184.216.34"],
      fetchImpl,
    });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(600);
    expect(result.content.length).toBe(600);
    expect(cancelled).toBe(true);
    expect(producedChunks).toBeLessThan(10);
  });

  test("fetches public HTML with valid relative redirect and returns cleaned readable text", async () => {
    const fetchImpl = makeMockFetch((url, init) => {
      expect(init?.redirect).toBe("manual");
      if (url === "https://example.com/old") {
        return new Response(null, { status: 301, headers: { location: "/new-page" } });
      }
      if (url === "https://example.com/new-page") {
        return new Response(
          "<html><head><title>Example Page</title></head><body><h1>Hello</h1><p>World &amp; Friends</p><script>bad()</script></body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
    });

    const result = await executeWebFetch({
      url: "https://example.com/old",
      lookupHost: async () => ["93.184.216.34"],
      fetchImpl,
    });

    expect(result.url).toBe("https://example.com/old");
    expect(result.finalUrl).toBe("https://example.com/new-page");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.title).toBe("Example Page");
    expect(result.content).toBe("# Hello\n\nWorld & Friends");
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBeGreaterThan(0);
  });

  test("fetches public JSON and applies maxChars clamping and truncation", async () => {
    const payload = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => `item-${i}`) });
    const fetchImpl = makeMockFetch(
      () => new Response(payload, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const fullResult = await executeWebFetch({
      url: "https://api.example.com/data.json",
      lookupHost: async () => ["1.1.1.1"],
      fetchImpl,
    });

    expect(fullResult.status).toBe(200);
    expect(fullResult.title).toBeUndefined();
    expect(fullResult.content).toBe(payload);
    expect(fullResult.truncated).toBe(false);

    // maxChars clamps minimum to 500
    const truncatedResult = await executeWebFetch({
      url: "https://api.example.com/data.json",
      maxChars: 100,
      lookupHost: async () => ["1.1.1.1"],
      fetchImpl,
    });

    expect(truncatedResult.truncated).toBe(true);
    expect(truncatedResult.content.length).toBe(500);
    expect(truncatedResult.content).toBe(payload.slice(0, 500));
  });

  test("respects caller AbortSignal and timeoutMs", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));

    await expect(
      executeWebFetch({
        url: "https://example.com/slow",
        signal: controller.signal,
        lookupHost: async () => ["93.184.216.34"],
        fetchImpl: makeMockFetch(() => new Response("ok")),
      }),
    ).rejects.toThrow(/cancelled by user/i);

    const slowFetch = makeMockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    );

    await expect(
      executeWebFetch({
        url: "https://example.com/hang",
        timeoutMs: 30,
        lookupHost: async () => ["93.184.216.34"],
        fetchImpl: slowFetch,
      }),
    ).rejects.toThrow(/timed out/i);

    let streamCancelled = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        streamCancelled = true;
      },
    });
    await expect(
      executeWebFetch({
        url: "https://example.com/hang-body",
        timeoutMs: 30,
        lookupHost: async () => ["93.184.216.34"],
        fetchImpl: makeMockFetch(() => new Response(hangingBody, { headers: { "content-type": "text/plain" } })),
      }),
    ).rejects.toThrow(/timed out/i);
    expect(streamCancelled).toBe(true);
  });

  test("allows public IP literals directly without DNS lookup and accepts empty/XML/JSON-LD content types", async () => {
    const neverLookup = async () => {
      throw new Error("DNS should not be called for IP literals");
    };

    const resIpv4 = await executeWebFetch({
      url: "https://93.184.216.34/doc.xml",
      lookupHost: neverLookup,
      fetchImpl: makeMockFetch(
        () => new Response("<root>ok</root>", { status: 200, headers: { "content-type": "application/xml" } }),
      ),
    });
    expect(resIpv4.content).toBe("<root>ok</root>");

    const resIpv6 = await executeWebFetch({
      url: "https://[2606:2800:220:1::1]/plain",
      lookupHost: neverLookup,
      fetchImpl: makeMockFetch(() => new Response("plain body", { status: 200 })),
    });
    expect(resIpv6.content).toBe("plain body");
  });
});
