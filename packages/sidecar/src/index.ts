import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SidecarServer } from "./server.ts";
import { FRAME_LIMIT, StdioPeer } from "./stdio_bridge.ts";

export { SidecarServer, type SidecarServerOptions } from "./server.ts";
export { RpcFailure, StdioPeer, StdioRustBridge } from "./stdio_bridge.ts";

export async function runStdio(): Promise<void> {
  const peer = new StdioPeer((line) => { process.stdout.write(line); });
  const reportError = (error: unknown) => console.error(error instanceof Error ? error.message : "Sidecar request failed");
  process.stdout.once("error", (error) => { peer.close(error); process.stdin.destroy(); });
  let server: SidecarServer | undefined;
  let initializing: Promise<SidecarServer> | undefined;
  peer.handle(async (method, params) => {
    initializing ??= (async () => {
      const dbPath = process.env.HARNEX_SIDECAR_DB ?? join(homedir(), ".harnex", "trace.sqlite");
      if (dbPath !== ":memory:") await mkdir(dirname(dbPath), { recursive: true });
      return server = new SidecarServer(peer, { dbPath, reportError });
    })();
    return (await initializing).dispatch(method, params);
  });

  const pieces: Buffer[] = [];
  let total = 0;
  try {
    for await (const data of process.stdin) {
      const chunk: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      for (let offset = 0; offset < chunk.length;) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        total += end - offset;
        if (total >= FRAME_LIMIT) throw new Error("JSON-RPC frame exceeds limit");
        pieces.push(chunk.subarray(offset, end));
        if (newline === -1) break;
        peer.receive(Buffer.concat(pieces, total).toString("utf8"));
        pieces.length = 0;
        total = 0;
        offset = end + 1;
      }
    }
  } finally {
    peer.close();
    await initializing?.catch(() => {});
    await server?.close();
  }
}

if (import.meta.main) await runStdio().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Sidecar failed");
  process.exitCode = 1;
});
