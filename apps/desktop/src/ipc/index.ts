import { MockIpcAdapter } from "./mockAdapter.ts";
import { isTauriRuntime, TauriIpcAdapter } from "./tauriAdapter.ts";
import type { HarnexIpcClient } from "./types.ts";

export * from "./types.ts";
export { MockIpcAdapter } from "./mockAdapter.ts";
export { TauriIpcAdapter, HarnexIpcEventSchema, isTauriRuntime } from "./tauriAdapter.ts";

export function createIpcClient(): HarnexIpcClient {
  if (isTauriRuntime()) {
    return new TauriIpcAdapter();
  }
  return new MockIpcAdapter();
}
