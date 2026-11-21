import { AsyncLocalStorage } from "node:async_hooks";
import type { HarnexBridgeEvent, HarnessTree, RustBridge } from "@harnex/interfaces";
import {
  JsonRpcErrorSchema, JsonRpcIdSchema, JsonRpcNotificationSchema, JsonRpcRequestSchema, RpcErrorCode,
  PricingSyncResultSchema, type BudgetStatus, type GitCommitPatchResult, type JsonRpcError, type JsonRpcId, type ModelPricing,
  type PricingSyncParams, type UntrustedSourceTag,
} from "@harnex/protocol";

export const FRAME_LIMIT = 8 * 1024 * 1024;
type Dispatch = (method: string, params: unknown) => unknown | Promise<unknown>;

export class RpcFailure extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export class StdioPeer {
  private readonly pending = new Map<JsonRpcId, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private counter = 0;
  private stopped = false;
  private dispatch?: Dispatch;

  constructor(private readonly write: (line: string) => void, private readonly timeoutMs = 150_000) {}

  handle(dispatch: Dispatch): void { this.dispatch = dispatch; }

  private send(message: unknown): void {
    if (this.stopped) throw new RpcFailure(RpcErrorCode.SidecarUnavailable, "RPC channel is closed");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > FRAME_LIMIT) throw new RpcFailure(RpcErrorCode.InvalidRequest, "JSON-RPC frame exceeds limit");
    this.write(line);
  }

  call<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.pending.size >= 64) return Promise.reject(new RpcFailure(RpcErrorCode.SidecarUnavailable, "Too many pending L0 requests"));
    const id = `ts:${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcFailure(RpcErrorCode.SidecarUnavailable, `L0 request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value as T); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timeout); reject(error); }
    });
  }

  private reply(id: JsonRpcId | null, value: { result: unknown } | { error: JsonRpcError }): void {
    if (this.stopped) return;
    this.send({ jsonrpc: "2.0", id, ...value });
  }

  receive(line: string): void {
    if (this.stopped || !line.trim()) return;
    let frame: unknown;
    try { frame = JSON.parse(line); }
    catch { this.reply(null, { error: { code: RpcErrorCode.ParseError, message: "Invalid JSON" } }); return; }
    const record = frame && typeof frame === "object" && !Array.isArray(frame) ? frame as Record<string, unknown> : {};
    if (Object.hasOwn(record, "method")) {
      const request = JsonRpcRequestSchema.safeParse(frame);
      if (request.success) {
        const { id, method, params } = request.data;
        if (method === "system.heartbeat") this.reply(id, { result: { ok: true } });
        else void this.respond(id, method, params);
        return;
      }
      const notification = !Object.hasOwn(record, "id") && JsonRpcNotificationSchema.safeParse(frame);
      if (notification && notification.success) { void this.respond(undefined, notification.data.method, notification.data.params); return; }
    } else if (Object.hasOwn(record, "result") || Object.hasOwn(record, "error")) {
      const { id } = record;
      const parsedId = JsonRpcIdSchema.safeParse(id);
      const pending = parsedId.success ? this.pending.get(parsedId.data) : undefined;
      if (pending && parsedId.success) {
        this.pending.delete(parsedId.data);
        const failure = JsonRpcErrorSchema.safeParse(record.error);
        const hasResult = Object.hasOwn(record, "result"), hasError = Object.hasOwn(record, "error");
        if (record.jsonrpc === "2.0" && hasResult && !hasError) pending.resolve(record.result);
        else if (record.jsonrpc === "2.0" && !hasResult && failure.success) {
          const { code, message, data } = failure.data;
          pending.reject(new RpcFailure(code, message, data));
        } else pending.reject(new RpcFailure(RpcErrorCode.InvalidRequest, "Invalid L0 response"));
      }
      return;
    }
    const id = JsonRpcIdSchema.safeParse(record.id);
    this.reply(id.success ? id.data : null, { error: { code: RpcErrorCode.InvalidRequest, message: "Invalid JSON-RPC request" } });
  }

  private async respond(id: JsonRpcId | undefined, method: string, params: unknown): Promise<void> {
    try {
      if (!this.dispatch) throw new RpcFailure(RpcErrorCode.MethodNotFound, "RPC method unavailable");
      const result = await this.dispatch(method, params ?? {});
      if (id !== undefined) this.reply(id, { result: result ?? null });
    } catch (error) {
      if (id === undefined) return;
      const rpc = error instanceof RpcFailure ? error : new RpcFailure(RpcErrorCode.InternalError, error instanceof Error ? error.message : "Internal error");
      try { this.reply(id, { error: { code: rpc.code, message: rpc.message, data: rpc.data } }); }
      catch (cause) { this.close(cause instanceof Error ? cause : undefined); }
    }
  }

  close(error: Error = new RpcFailure(RpcErrorCode.SidecarUnavailable, "RPC channel is closed")): void {
    this.stopped = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

type PatchContext = { threadId: string; sourceTags: readonly UntrustedSourceTag[] };
type Result<K extends keyof RustBridge> = Awaited<ReturnType<RustBridge[K]>>;

export class StdioRustBridge implements RustBridge {
  readonly pricing: ModelPricing[] = [];
  private readonly patchContext = new AsyncLocalStorage<PatchContext>();
  onEvent?: (event: HarnexBridgeEvent) => HarnexBridgeEvent;

  constructor(private readonly peer: StdioPeer, private readonly reportError: (error: unknown) => void = () => {}) {}

  execWriteFile(params: Parameters<RustBridge["execWriteFile"]>[0]) { return this.peer.call<Result<"execWriteFile">>("exec.write_file", params); }
  execDeleteFile(params: Parameters<RustBridge["execDeleteFile"]>[0]) { return this.peer.call<Result<"execDeleteFile">>("exec.delete_file", params); }
  execShell(params: Parameters<RustBridge["execShell"]>[0]) { return this.peer.call<Result<"execShell">>("exec.shell", params); }
  execScript(params: Parameters<RustBridge["execScript"]>[0]) { return this.peer.call<Result<"execScript">>("exec.script", params); }
  execHook(params: Parameters<RustBridge["execHook"]>[0]) { return this.peer.call<Result<"execHook">>("exec.hook", params); }

  gitHeadSha() { return this.peer.call<Result<"gitHeadSha">>("git.head_sha"); }
  gitLog(limit?: number) { return this.peer.call<Result<"gitLog">>("git.log", { limit }); }
  gitReadTree(commitSha: string) { return this.peer.call<Result<"gitReadTree">>("git.read_tree", { commitSha }); }
  gitCommitPatch(patch: Parameters<RustBridge["gitCommitPatch"]>[0]) {
    const { threadId, sourceTags } = this.patchContext.getStore() ?? { threadId: "evolution", sourceTags: ["external_file"] };
    return this.peer.call<Result<"gitCommitPatch">>("git.commit_patch", { patch, sourceTags, threadId });
  }
  withPatchContext<T>(context: PatchContext, work: () => T): T { return this.patchContext.run(context, work); }
  gitRevert(targetSha: string, reason: string) { return this.peer.call<Result<"gitRevert">>("git.revert", { targetSha, reason }); }
  recordHealth(domain: string, commitSha: string, success: boolean) {
    return this.peer.call<GitCommitPatchResult | null>("git.record_health", { domain, commitSha, success });
  }

  private price(status: BudgetStatus) { this.pricing.splice(0, this.pricing.length, ...status.pricingTable); }
  async checkBudget(estimatedCostUsd = 0) {
    const result = await this.peer.call<Result<"checkBudget">>("budget.check", { estimatedCostUsd });
    this.price(result.status);
    return result;
  }
  async recordUsage(modelId: string, usage: Parameters<RustBridge["recordUsage"]>[1]) {
    const result = await this.peer.call<Result<"recordUsage">>("budget.record_usage", { modelId, usage });
    this.price(result);
    return result;
  }
  async mergePricing(pricing: ModelPricing[]): Promise<void> {
    if (pricing.length === 0) return;
    try {
      this.price(await this.peer.call<BudgetStatus>("budget.merge_pricing", { pricing }));
    } catch (error) {
      if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.MethodNotFound) throw error;
    }
  }

  async modelPricing(modelId: string): Promise<ModelPricing | null | undefined> {
    try {
      return await this.peer.call<ModelPricing | null>("budget.model_pricing", { modelId });
    } catch (error) {
      if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.MethodNotFound) throw error;
    }
  }

  async syncPricing(params: PricingSyncParams) {
    return PricingSyncResultSchema.parse(await this.peer.call("budget.sync_pricing", params));
  }

  keyringGet(keyringRef: string) { return this.peer.call<Result<"keyringGet">>("keyring.get", { keyringRef }); }
  async keyringSet(keyringRef: string, secret: string): Promise<void> { await this.peer.call("keyring.set", { keyringRef, secret }); }
  async keyringDelete(keyringRef: string): Promise<void> { await this.peer.call("keyring.delete", { keyringRef }); }
  async bindShadow(threadId: string, workspacePath: string, pinnedCommitSha: string, overrideTree?: HarnessTree): Promise<void> {
    await this.peer.call("sandbox.bind_shadow", { threadId, workspaceRoot: workspacePath, commitSha: pinnedCommitSha, overrideTree });
  }
  async clearShadow(threadId: string, workspacePath: string): Promise<void> {
    await this.peer.call("sandbox.clear_shadow", { threadId, workspaceRoot: workspacePath });
  }
  requestApproval(params: Parameters<RustBridge["requestApproval"]>[0]) { return this.peer.call<Result<"requestApproval">>("security.request_approval", params); }
  guardianReview(params: Parameters<RustBridge["guardianReview"]>[0]) { return this.peer.call<Result<"guardianReview">>("guardian.review", params); }
  emitEvent(event: HarnexBridgeEvent): void {
    const outgoing = this.onEvent?.(event) ?? event;
    void this.peer.call("event.emit", outgoing).catch(this.reportError);
  }
}
