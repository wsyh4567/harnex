import type { RiskReasonCode } from "@harnex/protocol";
import type { TranslationKey } from "../../i18n/types.ts";

export interface RiskReasonBadgeMeta {
  labelKey: TranslationKey;
  descKey: TranslationKey;
  badgeClass: string;
}

const ROSE =
  "border-rose-500/40 bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200";
const ORANGE =
  "border-orange-500/35 bg-orange-50 text-orange-800 dark:bg-orange-500/15 dark:text-orange-200";
const AMBER =
  "border-amber-500/35 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200";
const VIOLET =
  "border-violet-500/35 bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200";

export const RISK_REASON_META: Record<RiskReasonCode, RiskReasonBadgeMeta> = {
  sandbox_escape: {
    labelKey: "sec.reason.sandbox_escape.label",
    descKey: "sec.reason.sandbox_escape.desc",
    badgeClass: ORANGE,
  },
  forbidden_policy: {
    labelKey: "sec.reason.forbidden_policy.label",
    descKey: "sec.reason.forbidden_policy.desc",
    badgeClass: ROSE,
  },
  shell_syntax: {
    labelKey: "sec.reason.shell_syntax.label",
    descKey: "sec.reason.shell_syntax.desc",
    badgeClass: ORANGE,
  },
  interpreter_execution: {
    labelKey: "sec.reason.interpreter_execution.label",
    descKey: "sec.reason.interpreter_execution.desc",
    badgeClass: ORANGE,
  },
  file_deletion: {
    labelKey: "sec.reason.file_deletion.label",
    descKey: "sec.reason.file_deletion.desc",
    badgeClass: ROSE,
  },
  network_access: {
    labelKey: "sec.reason.network_access.label",
    descKey: "sec.reason.network_access.desc",
    badgeClass: ORANGE,
  },
  protected_path: {
    labelKey: "sec.reason.protected_path.label",
    descKey: "sec.reason.protected_path.desc",
    badgeClass: ROSE,
  },
  untrusted_source: {
    labelKey: "sec.reason.untrusted_source.label",
    descKey: "sec.reason.untrusted_source.desc",
    badgeClass: AMBER,
  },
  hook_untrusted: {
    labelKey: "sec.reason.hook_untrusted.label",
    descKey: "sec.reason.hook_untrusted.desc",
    badgeClass: VIOLET,
  },
  high_privilege_proposal: {
    labelKey: "sec.reason.high_privilege_proposal.label",
    descKey: "sec.reason.high_privilege_proposal.desc",
    badgeClass: VIOLET,
  },
  guardian_escalated: {
    labelKey: "sec.reason.guardian_escalated.label",
    descKey: "sec.reason.guardian_escalated.desc",
    badgeClass: AMBER,
  },
  policy_prompt: {
    labelKey: "sec.reason.policy_prompt.label",
    descKey: "sec.reason.policy_prompt.desc",
    badgeClass: AMBER,
  },
};

export function getRiskReasonMeta(code?: RiskReasonCode): RiskReasonBadgeMeta | null {
  if (!code) return null;
  return RISK_REASON_META[code] ?? null;
}
