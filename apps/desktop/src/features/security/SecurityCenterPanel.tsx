import { useState } from "react";
import type {
  ExecPolicyAction,
  GlobalHookItem,
  GuardianDecision,
  TrustStatus,
} from "@harnex/protocol";
import {
  Bot,
  Code2,
  Fingerprint,
  Lock,
  Pencil,
  Plus,
  Power,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { ChoiceMenu } from "../../components/ui/ChoiceMenu.tsx";
import { localizeGuardianDecision } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import type { GlobalHookEvent } from "../../ipc/types.ts";
import { cn, formatRelativeTime, shortSha } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { getRiskReasonMeta } from "./riskReasonMeta.ts";

const HOOK_EVENTS: GlobalHookEvent[] = ["PreToolUse", "PostToolUse", "SessionStart"];

const DEFAULT_NEW_HOOK_TEMPLATE = [
  "// @event PostToolUse",
  "export default function customHook(payload: { toolName: string; stdout?: string }) {",
  "  return { ok: true };",
  "}",
].join("\n");

export function GuardianDecisionCard({ decision: gd }: { decision: GuardianDecision }) {
  const { locale, t } = useI18n();
  const decLabel =
    gd.decision === "allow"
      ? t("sec.decisionAllow")
      : gd.decision === "deny"
        ? t("sec.decisionDeny")
        : t("sec.decisionEscalate");
  const riskLabel =
    gd.riskLevel === "low"
      ? t("sec.riskLow")
      : gd.riskLevel === "medium"
        ? t("sec.riskMedium")
        : gd.riskLevel === "high"
          ? t("sec.riskHigh")
          : t("sec.riskCritical");
  const reasonMeta = getRiskReasonMeta(gd.riskReasonCode);

  return (
    <div className="space-y-1.5 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-[10px] font-medium",
              gd.decision === "allow"
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : gd.decision === "deny"
                  ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
            )}
          >
            {decLabel}
          </span>
          {reasonMeta && (
            <span
              data-testid={`guardian-reason-badge-${gd.requestId}`}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-tight",
                reasonMeta.badgeClass,
              )}
            >
              {t(reasonMeta.labelKey)}
            </span>
          )}
          <code className="truncate font-mono text-[11px] text-[var(--hx-text)]">
            {gd.commandOrPath}
          </code>
        </div>
        <span className="shrink-0 text-[10px] text-[var(--hx-text-3)]">
          {formatRelativeTime(gd.timestamp, locale)}
        </span>
      </div>
      {reasonMeta && (
        <p
          data-testid={`guardian-reason-explanation-${gd.requestId}`}
          className="text-[11px] leading-snug text-[var(--hx-text-2)]"
        >
          {t(reasonMeta.descKey)}
        </p>
      )}
      <p className="text-[11px] text-[var(--hx-text-2)]">
        {localizeGuardianDecision(gd, locale)}
      </p>
      <div className="text-[10px] text-[var(--hx-text-3)]">
        {t("sec.reviewer", { model: gd.modelId, risk: riskLabel })}
      </div>
    </div>
  );
}

export function SecurityCenterPanel() {
  const {
    pendingApprovals,
    resolveApproval,
    execPolicyRules,
    upsertExecPolicyRule,
    deleteExecPolicyRule,
    trustRecords,
    updateTrustStatus,
    globalHooks,
    saveHook,
    deleteHook,
    trustGlobalHook,
    toggleGlobalHookStatus,
    guardianDecisions,
    systemHealth,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();

  const [editingMode, setEditingMode] = useState<"new" | string | null>(null);
  const [hookPath, setHookPath] = useState("hooks/my_guard.ts");
  const [hookEvent, setHookEvent] = useState<GlobalHookEvent>("PostToolUse");
  const [hookContent, setHookContent] = useState(DEFAULT_NEW_HOOK_TEMPLATE);
  const [hookFormError, setHookFormError] = useState<string | null>(null);
  const [savingHook, setSavingHook] = useState(false);

  const [prefix, setPrefix] = useState("");
  const [action, setAction] = useState<ExecPolicyAction>("prompt");
  const [description, setDescription] = useState("");

  const runtimeApprovals = pendingApprovals.filter((a) => a.kind !== "hook_trust");

  const openNewHookForm = () => {
    setEditingMode("new");
    setHookPath("hooks/my_guard.ts");
    setHookEvent("PostToolUse");
    setHookContent(DEFAULT_NEW_HOOK_TEMPLATE);
    setHookFormError(null);
  };

  const openEditHookForm = (hook: GlobalHookItem) => {
    setEditingMode(hook.path);
    setHookPath(hook.path);
    setHookEvent(hook.event);
    setHookContent(hook.content);
    setHookFormError(null);
  };

  const handleSaveHook = async (trustImmediately: boolean) => {
    const trimmedPath = hookPath.trim();
    if (!trimmedPath.startsWith("hooks/") || !trimmedPath.endsWith(".ts")) {
      setHookFormError(t("hooks.pathError"));
      return;
    }
    setSavingHook(true);
    setHookFormError(null);
    try {
      await saveHook({
        path: trimmedPath,
        event: hookEvent,
        content: hookContent,
        trustImmediately,
      });
      setEditingMode(null);
    } catch (err) {
      setHookFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHook(false);
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prefix.trim()) return;
    await upsertExecPolicyRule({
      id: `pol-${Date.now()}`,
      prefix: prefix.trim(),
      action,
      description: description.trim() || (locale.startsWith("zh") ? "自定义前缀规则" : "Custom prefix policy"),
    });
    setPrefix("");
    setDescription("");
  };

  const formatOriginLabel = (origin: GlobalHookItem["origin"]) => {
    if (origin === "rsi_evolved") return t("hooks.originRsi");
    if (origin === "imported_genome") return t("hooks.originImported");
    return t("hooks.originUser");
  };

  const trustStatusOptions = [
    { value: "trusted", label: t("sec.statusTrusted") },
    { value: "untrusted", label: t("sec.statusUntrusted") },
    { value: "disabled", label: t("sec.statusDisabled") },
  ];

  return (
    <div className="h-full overflow-y-auto p-5 space-y-6">
      {/* Global Hooks Manager */}
      <section data-testid="global-hooks-manager" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-[var(--hx-accent)]" />
              <h3 className="text-sm font-semibold text-[var(--hx-text)]">
                {t("hooks.managerTitle")} ({globalHooks.length})
              </h3>
            </div>
            <p className="mt-0.5 text-xs text-[var(--hx-text-3)]">{t("hooks.managerSub")}</p>
          </div>
          <button
            type="button"
            data-testid="hooks-add-btn"
            onClick={openNewHookForm}
            className="hx-pressable inline-flex items-center gap-1 rounded-xl border border-[var(--hx-accent-border)] bg-[var(--hx-accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--hx-accent)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t("hooks.addBtn")}</span>
          </button>
        </div>

        {editingMode !== null && (
          <div className="space-y-3 rounded-2xl border border-[var(--hx-accent-border)] bg-[var(--hx-surface)] p-4 text-xs shadow-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[var(--hx-text)]">
                {editingMode === "new"
                  ? t("hooks.newTitle")
                  : t("hooks.editTitle", { path: editingMode })}
              </span>
              <button
                type="button"
                onClick={() => setEditingMode(null)}
                className="text-xs text-[var(--hx-text-3)] hover:text-[var(--hx-text)]"
              >
                {t("common.cancel")}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] text-[var(--hx-text-2)]">
                  {t("hooks.pathLabel")}
                </label>
                <input
                  type="text"
                  data-testid="hook-editor-path"
                  value={hookPath}
                  disabled={editingMode !== "new"}
                  onChange={(e) => setHookPath(e.target.value)}
                  placeholder={t("hooks.pathPlaceholder")}
                  className="w-full rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 font-mono text-xs text-[var(--hx-text)] disabled:opacity-60"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-[var(--hx-text-2)]">
                  {t("hooks.eventLabel")}
                </label>
                <ChoiceMenu
                  testId="hook-editor-event"
                  ariaLabel={t("hooks.eventLabel")}
                  value={hookEvent}
                  options={HOOK_EVENTS.map((ev) => ({ value: ev, label: ev }))}
                  onChange={(ev) => setHookEvent(ev as GlobalHookEvent)}
                  buttonClassName="w-full font-mono"
                  menuClassName="w-44"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[var(--hx-text-2)]">
                {t("hooks.codeLabel")}
              </label>
              <textarea
                rows={6}
                data-testid="hook-editor-content"
                value={hookContent}
                onChange={(e) => setHookContent(e.target.value)}
                className="w-full rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] p-3 font-mono text-[11px] text-[var(--hx-text)]"
              />
            </div>

            {hookFormError && (
              <div className="rounded-xl border border-rose-500/35 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                {hookFormError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={savingHook}
                onClick={() => void handleSaveHook(false)}
                className="hx-pressable rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--hx-text)] disabled:opacity-50"
              >
                {t("hooks.saveUntrusted")}
              </button>
              <button
                type="button"
                data-testid="hook-save-trust-btn"
                disabled={savingHook}
                onClick={() => void handleSaveHook(true)}
                className="hx-pressable rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {t("hooks.saveAndTrust")}
              </button>
            </div>
          </div>
        )}

        {globalHooks.length === 0 ? (
          <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4 text-xs text-[var(--hx-text-3)]">
            {t("hooks.empty")}
          </div>
        ) : (
          <div className="divide-y divide-[var(--hx-border)] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
            {globalHooks.map((hook) => (
              <div
                key={hook.path}
                data-testid={`global-hook-row-${hook.name}`}
                className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="truncate font-mono font-medium text-[var(--hx-text)]">
                      {hook.path}
                    </code>
                    <span className="rounded-md border border-cyan-500/30 bg-cyan-50 px-1.5 py-0.5 font-mono text-[10px] text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-200">
                      {hook.event}
                    </span>
                    <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-2)]">
                      {formatOriginLabel(hook.origin)}
                    </span>
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                        hook.status === "trusted"
                          ? "border-emerald-500/35 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                          : hook.status === "untrusted"
                            ? "border-amber-500/35 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                            : "border-[var(--hx-border)] bg-[var(--hx-subtle)] text-[var(--hx-text-3)]",
                      )}
                    >
                      {hook.status === "trusted"
                        ? t("sec.statusTrusted")
                        : hook.status === "untrusted"
                          ? t("sec.statusUntrusted")
                          : t("sec.statusDisabled")}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-[var(--hx-text-3)]">
                    SHA-256: {shortSha(hook.sha256, 16)}… · {formatRelativeTime(hook.updatedAt, locale)}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {hook.status === "untrusted" && (
                    <button
                      type="button"
                      data-testid={`hook-retrust-${hook.name}`}
                      onClick={() => void trustGlobalHook(hook.path)}
                      className="hx-pressable rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                    >
                      {t("hooks.reTrust")}
                    </button>
                  )}

                  {hook.status !== "untrusted" && (
                    <button
                      type="button"
                      data-testid={`hook-toggle-${hook.name}`}
                      onClick={() => void toggleGlobalHookStatus(hook)}
                      className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-2.5 py-1 text-[11px] text-[var(--hx-text)] hover:border-[var(--hx-border-strong)]"
                    >
                      <Power className="h-3 w-3" />
                      <span>{hook.status === "trusted" ? t("hooks.disable") : t("hooks.enable")}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid={`hook-edit-${hook.name}`}
                    onClick={() => openEditHookForm(hook)}
                    className="hx-pressable inline-flex items-center gap-1 rounded-lg border border-[var(--hx-border)] bg-[var(--hx-surface)] px-2.5 py-1 text-[11px] text-[var(--hx-text-2)] hover:text-[var(--hx-text)]"
                  >
                    <Pencil className="h-3 w-3" />
                    <span>{t("hooks.edit")}</span>
                  </button>

                  <button
                    type="button"
                    data-testid={`hook-delete-${hook.name}`}
                    aria-label={`${t("common.delete")} ${hook.path}`}
                    onClick={() => void deleteHook(hook.path)}
                    className="hx-pressable rounded-lg p-1.5 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-rose-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* L0 OS Sandbox Banner */}
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5">
        <div className="flex items-center gap-2.5">
          <Lock className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <div>
            <div className="text-xs font-semibold text-[var(--hx-text)]">{t("sec.bannerTitle")}</div>
            <div className="text-[11px] text-[var(--hx-text-2)]">
              {t("sec.bannerBackend")}{" "}
              <span className="font-mono text-[var(--hx-text)]">
                {systemHealth?.sandboxBackend ?? "win-job-restricted-token"}
              </span>{" "}
              ({systemHealth?.osSandboxLevel === "beta" ? t("sec.bannerWinBeta") : t("sec.bannerPosix")})
            </div>
          </div>
        </div>
        <span className="rounded-md border border-emerald-500/30 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t("sec.l0Protected")}
        </span>
      </div>

      {/* Pending Runtime L0 Approvals */}
      <section className="space-y-2.5">
        <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
          {t("sec.pendingTitle", { count: runtimeApprovals.length })}
        </h3>
        {runtimeApprovals.length === 0 ? (
          <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5 text-xs text-[var(--hx-text-3)]">
            {t("sec.noPending")}
          </div>
        ) : (
          <div className="space-y-2.5">
            {runtimeApprovals.map((req) => (
              <ApprovalCard
                key={req.requestId}
                request={req}
                onResolve={(id, dec) => void resolveApproval(id, dec)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Trust Store */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
            {t("sec.trustStoreTitle")}
          </h3>
        </div>
        <div className="divide-y divide-[var(--hx-border)] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
          {trustRecords.map((rec) => (
            <div key={rec.id} className="flex items-center justify-between gap-2 p-3 text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[var(--hx-text-2)]">
                    {rec.kind}
                  </span>
                  <span className="truncate font-mono text-[var(--hx-text)]">{rec.identifier}</span>
                </div>
                {rec.sha256 && (
                  <div className="mt-0.5 font-mono text-[10px] text-[var(--hx-text-3)]">
                    SHA-256: {shortSha(rec.sha256, 20)}…
                  </div>
                )}
              </div>
              <ChoiceMenu
                ariaLabel={`Trust status for ${rec.identifier}`}
                value={rec.status}
                options={trustStatusOptions}
                onChange={(next) => void updateTrustStatus(rec.id, next as TrustStatus)}
                side="bottom-right"
                buttonClassName="min-w-24 text-[11px]"
                menuClassName="w-36"
              />
            </div>
          ))}
        </div>
      </section>

      {/* ExecPolicy Prefix Rules */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[var(--hx-accent)]" />
          <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
            {t("sec.execPolicyTitle")}
          </h3>
        </div>

        <form onSubmit={(e) => void handleAddRule(e)} className="flex flex-wrap gap-2">
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder={t("sec.prefixPlaceholder")}
            className="min-w-36 flex-1 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3 py-1.5 font-mono text-xs text-[var(--hx-text)]"
          />
          <ChoiceMenu
            ariaLabel="ExecPolicy action"
            value={action}
            options={
              locale.startsWith("zh")
                ? [
                    { value: "allow", label: "放行" },
                    { value: "prompt", label: "需确认" },
                    { value: "forbidden", label: "禁止" },
                  ]
                : [
                    { value: "allow", label: "allow" },
                    { value: "prompt", label: "prompt" },
                    { value: "forbidden", label: "forbidden" },
                  ]
            }
            onChange={(next) => setAction(next as ExecPolicyAction)}
            buttonClassName="min-w-28"
            menuClassName="w-36"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("sec.reasonPlaceholder")}
            className="w-40 rounded-xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)] px-3 py-1.5 text-xs text-[var(--hx-text)]"
          />
          <button
            type="submit"
            className="hx-pressable inline-flex items-center gap-1 rounded-xl bg-[var(--hx-text)] px-3 py-1.5 text-xs font-semibold text-[var(--hx-canvas)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t("common.add")}</span>
          </button>
        </form>

        <div className="divide-y divide-[var(--hx-border)] rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]">
          {execPolicyRules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                      rule.action === "allow"
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                        : rule.action === "forbidden"
                          ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
                    )}
                  >
                    {locale.startsWith("zh")
                      ? rule.action === "allow"
                        ? "放行"
                        : rule.action === "forbidden"
                          ? "禁止"
                          : "需确认"
                      : rule.action}
                  </span>
                  <code className="font-mono text-[var(--hx-text)]">{rule.prefix}</code>
                </div>
                {rule.description && (
                  <p className="mt-0.5 text-[11px] text-[var(--hx-text-3)]">{rule.description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label={`${t("common.delete")} ${rule.prefix}`}
                onClick={() => void deleteExecPolicyRule(rule.id)}
                className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-rose-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Guardian AI Audit Log */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--hx-accent)]" />
            <h3 className="text-xs font-semibold text-[var(--hx-text-2)]">
              {t("sec.guardianTitle")}
            </h3>
          </div>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            sanitizedInputOnly = true
          </span>
        </div>

        <div className="space-y-2">
          {guardianDecisions.map((gd) => (
            <GuardianDecisionCard key={`${gd.requestId}-${gd.timestamp}`} decision={gd} />
          ))}
        </div>
      </section>
    </div>
  );
}
