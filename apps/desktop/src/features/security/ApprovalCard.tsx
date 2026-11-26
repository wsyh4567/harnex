import type { ApprovalDecision, ApprovalRequest } from "@harnex/protocol";
import { AlertTriangle, Fingerprint, ShieldAlert } from "lucide-react";
import { localizeApproval } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, shortSha } from "../../lib/utils.ts";
import { getRiskReasonMeta } from "./riskReasonMeta.ts";

interface ApprovalCardProps {
  request: ApprovalRequest;
  onResolve: (requestId: string, decision: ApprovalDecision) => void;
}

const RISK_STYLE: Record<string, string> = {
  low: "border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  medium: "border-amber-500/35 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  high: "border-orange-500/35 bg-orange-50 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
  critical: "border-rose-500/40 bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
};

export function ApprovalCard({ request, onResolve }: ApprovalCardProps) {
  const { locale, t } = useI18n();
  const isHookTrust = request.kind === "hook_trust";
  const loc = localizeApproval(request, locale);
  const reasonMeta = getRiskReasonMeta(request.riskReasonCode);

  return (
    <div
      data-testid={`approval-card-${request.requestId}`}
      className={cn(
        "space-y-3 rounded-2xl border p-4 text-xs shadow-xs",
        isHookTrust
          ? "border-violet-500/35 bg-violet-50/70 dark:bg-violet-950/20"
          : "border-amber-500/35 bg-amber-50/70 dark:bg-amber-950/20",
      )}
    >
      <div className="flex items-start gap-2.5">
        {isHookTrust ? (
          <Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        ) : (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--hx-text)]">
              {isHookTrust ? t("sec.hookTrustTitle") : t("sec.sandboxTitle")}
            </span>
            <span
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                RISK_STYLE[request.riskLevel],
              )}
            >
              {loc.riskLabel}
            </span>
            {reasonMeta && (
              <span
                data-testid="risk-reason-badge"
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-tight",
                  reasonMeta.badgeClass,
                )}
              >
                {t(reasonMeta.labelKey)}
              </span>
            )}
            {request.sourceTags.some((tag) => tag !== "local") && (
              <span className="rounded-md border border-rose-500/35 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
                {t("sec.untrustedSource", { tags: request.sourceTags.join(", ") })}
              </span>
            )}
          </div>
          <p className="font-medium text-[var(--hx-text)]">{loc.summary}</p>
          {reasonMeta && (
            <p
              data-testid="risk-reason-explanation"
              className="text-[11px] leading-snug text-[var(--hx-text-2)]"
            >
              {t(reasonMeta.descKey)}
            </p>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--hx-text-2)]">{loc.detail}</p>

      <div className="space-y-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-surface)] px-3 py-2 font-mono text-[11px] text-[var(--hx-text)]">
        <div>
          <span className="text-[var(--hx-text-3)]">{t("sec.target")} </span>
          <span className="text-[var(--hx-accent)]">{request.commandOrPath}</span>
        </div>
        {request.sha256 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <span className="text-[var(--hx-text-3)]">{t("sec.newSha")} </span>
              <span className="text-violet-700 dark:text-violet-300">
                {shortSha(request.sha256, 16)}…
              </span>
            </span>
            {request.previousSha256 && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                {t("sec.changedFrom", { sha: shortSha(request.previousSha256, 12) })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onResolve(request.requestId, "allow_once")}
          className="hx-pressable rounded-xl border border-emerald-500/40 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
        >
          {isHookTrust ? t("sec.trustOnce") : t("sec.allowOnce")}
        </button>
        <button
          type="button"
          onClick={() => onResolve(request.requestId, "allow_session")}
          className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs font-medium text-[var(--hx-text)] hover:bg-[var(--hx-subtle)]"
        >
          {isHookTrust ? t("sec.trustPerm") : t("sec.allowSession")}
        </button>
        <button
          type="button"
          onClick={() => onResolve(request.requestId, "deny")}
          className="hx-pressable rounded-xl border border-rose-500/35 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-200"
        >
          {t("sec.deny")}
        </button>
      </div>
    </div>
  );
}
