import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { UntrustedSourceTag } from "@harnex/protocol";
import { providerUrl } from "../providers/registry.ts";
import type { McpServerConfig } from "./slots.ts";

/** Command transports must come from the integration that manages the server via L0. */
export class McpHost {
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(private readonly servers: Readonly<Record<string, McpServerConfig>>,
    private readonly connectCommand?: (name: string, config: McpServerConfig) => Promise<Transport>) {}

  private client(name: string): Promise<Client> {
    const previous = this.clients.get(name);
    if (previous) return previous;
    const connection = this.connect(name).catch((error) => { this.clients.delete(name); throw error; });
    this.clients.set(name, connection);
    return connection;
  }

  private async connect(name: string): Promise<Client> {
    const server = Object.hasOwn(this.servers, name) ? this.servers[name] : undefined;
    if (!server || !server.enabled || server.disabled) throw new Error(`MCP server unavailable: ${name}`);
    const transport = server.url ? new StreamableHTTPClientTransport(new URL(providerUrl(server.url))) :
      await this.connectCommand?.(name, server);
    if (!transport) throw new Error(`MCP server requires an L0-managed transport: ${name}`);
    const client = new Client({ name: "harnex", version: "1.0.0" });
    try { await client.connect(transport); }
    catch (error) { await client.close(); throw error; }
    return client;
  }

  async listTools(name: string) { return (await this.client(name)).listTools(); }

  async callTool(name: string, tool: string, args: Record<string, unknown>) {
    const result = await (await this.client(name)).callTool({ name: tool, arguments: args });
    const sourceTags: UntrustedSourceTag[] = ["untrusted_mcp"];
    return { result, sourceTags };
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(async (pending) => (await pending).close()));
  }
}
