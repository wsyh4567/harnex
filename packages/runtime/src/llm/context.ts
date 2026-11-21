import type { LlmMessage, LlmRequest } from "@harnex/interfaces";

export function truncateToolOutput(output: string, limit = 16_000) {
  const marker = "\n[tool output truncated]";
  const cap = Math.max(marker.length, Number.isFinite(limit) ? Math.floor(limit) : 16_000);
  return output.length <= cap ? { output, truncated: false } : {
    output: output.slice(0, cap - marker.length).replace(/[\uD800-\uDBFF]$/, "") + marker,
    truncated: true,
  };
}

export function estimateContextTokens(request: Pick<LlmRequest, "messages" | "systemPrompt" | "tools">): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(request.tools ?? []) + (request.systemPrompt ?? "") +
    JSON.stringify(request.messages)).length / 3);
}

export function splitForCompaction(messages: LlmMessage[]) {
  // Cut at a user turn so tool results stay with their corresponding calls.
  let cut = -1, fallback = -1;
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "user") cut = i;
    if (i > 1 && message.role === "assistant" && !message.toolCalls?.length) fallback = i;
  }
  const boundary = cut > 0 ? cut : fallback > 1 ? fallback + 1 : messages.length;
  return { older: messages.slice(0, boundary), recent: messages.slice(boundary) };
}
