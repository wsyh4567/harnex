import type { ApprovalRequest, GlobalHookItem } from "@harnex/protocol";

export interface GlobalHookAlert {
  path: string;
  name: string;
  event: GlobalHookItem["event"];
  sha256: string;
  previousSha256?: string;
  origin: GlobalHookItem["origin"];
  approvalRequestId?: string;
  threadId?: string;
  detail?: string;
}

/** Keeps only runtime (non-hook) approvals inside the per-thread conversation feed. */
export function filterThreadChatApprovals(
  pendingApprovals: ApprovalRequest[],
  threadId: string | null | undefined,
): ApprovalRequest[] {
  if (!threadId) return [];
  return pendingApprovals.filter((a) => a.threadId === threadId && a.kind !== "hook_trust");
}

/** Collects deduplicated global hook alerts from pending hook_trust requests and untrusted hooks. */
export function selectGlobalHookAlerts(
  globalHooks: GlobalHookItem[],
  pendingApprovals: ApprovalRequest[],
  dismissedShaByPath: Record<string, string>,
): GlobalHookAlert[] {
  const byPath = new Map<string, GlobalHookAlert>();

  for (const hook of globalHooks) {
    if (hook.status !== "untrusted") continue;
    byPath.set(hook.path, {
      path: hook.path,
      name: hook.name,
      event: hook.event,
      sha256: hook.sha256,
      origin: hook.origin,
    });
  }

  for (const req of pendingApprovals) {
    if (req.kind !== "hook_trust") continue;
    const path = req.commandOrPath;
    const matchingHook = globalHooks.find((h) => h.path === path);
    const existing = byPath.get(path);
    const derivedName =
      matchingHook?.name ??
      path.replace(/^hooks\//, "").replace(/\.ts$/, "");
    byPath.set(path, {
      path,
      name: existing?.name ?? derivedName,
      event: matchingHook?.event ?? existing?.event ?? "PostToolUse",
      sha256: req.sha256 ?? matchingHook?.sha256 ?? existing?.sha256 ?? "unverified",
      previousSha256: req.previousSha256 ?? existing?.previousSha256,
      origin: matchingHook?.origin ?? existing?.origin ?? "rsi_evolved",
      approvalRequestId: req.requestId,
      threadId: req.threadId,
      detail: req.detail,
    });
  }

  return Array.from(byPath.values()).filter(
    (alert) => dismissedShaByPath[alert.path] !== alert.sha256,
  );
}
