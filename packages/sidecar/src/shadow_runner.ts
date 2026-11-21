import type { TaskRunner, TaskRunRequest } from "@harnex/interfaces";
import type { StdioRustBridge } from "./stdio_bridge.ts";

export class ShadowBoundRunner implements TaskRunner {
  private readonly binding = new Map<string, AbortController>();

  constructor(private readonly runner: TaskRunner, private readonly bridge: StdioRustBridge) {}

  async runTask(request: TaskRunRequest) {
    if (!request.dryRunShadow) return this.runner.runTask(request);
    const { threadId, workspacePath, pinnedCommitSha } = request;
    const controller = new AbortController();
    this.binding.set(threadId, controller);
    let bound = false;
    try {
      await this.bridge.bindShadow(threadId, workspacePath, pinnedCommitSha, request.overrideHarnessTree);
      bound = true;
      controller.signal.throwIfAborted();
      this.binding.delete(threadId);
      return await this.runner.runTask(request);
    } finally {
      this.binding.delete(threadId);
      if (bound) await this.bridge.clearShadow(threadId, workspacePath);
    }
  }

  pause(threadId: string) { return this.runner.pause(threadId); }
  steer(threadId: string, instruction: string) { return this.runner.steer(threadId, instruction); }
  resume(threadId: string) { return this.runner.resume(threadId); }
  async abort(threadId: string) {
    const pending = this.binding.get(threadId);
    if (pending) pending.abort();
    else await this.runner.abort(threadId);
  }
  askSideChat(threadId: string, question: string) { return this.runner.askSideChat(threadId, question); }
}
