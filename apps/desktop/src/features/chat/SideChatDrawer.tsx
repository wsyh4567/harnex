import { useEffect, useState } from "react";
import { Loader2, MessageSquareOff, Send, ShieldCheck, X } from "lucide-react";
import { MarkdownProse } from "../../components/ui/MarkdownProse.tsx";
import { useAnimatedPresence } from "../../hooks/useAnimatedPresence.ts";
import { localizeThreadTitle } from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { formatUsd } from "../../lib/utils.ts";
import { useCommandDeckStore } from "../../stores/useCommandDeckStore.ts";

export function SideChatDrawer() {
  const {
    sideChatOpen,
    toggleSideChat,
    activeThreadId,
    threads,
    sideChatByThread,
    sideChatLoading,
    askSideChat,
  } = useCommandDeckStore();
  const { locale, t } = useI18n();
  const [question, setQuestion] = useState("");
  const presence = useAnimatedPresence(sideChatOpen, 155);

  useEffect(() => {
    if (!sideChatOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleSideChat(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sideChatOpen, toggleSideChat]);

  if (!presence.rendered) return null;

  const activeThread = threads.find((th) => th.id === activeThreadId) ?? null;
  const turns = activeThreadId ? (sideChatByThread[activeThreadId] ?? []) : [];
  const localizedTitle = activeThread
    ? localizeThreadTitle(activeThread, locale)
    : t("sidechat.noActiveThread");

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || sideChatLoading) return;
    const q = question;
    setQuestion("");
    await askSideChat(q);
  };

  return (
    <div
      role="dialog"
      aria-label={t("sidechat.title")}
      data-state={presence.closing ? "closing" : "open"}
      style={{ boxShadow: "var(--hx-shadow-popover)" }}
      className="hx-drawer fixed bottom-16 right-6 z-40 flex h-[440px] w-96 flex-col rounded-2xl border border-[var(--hx-border-strong)] bg-[var(--hx-surface)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--hx-border)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--hx-text)]">
              {t("sidechat.title")}
            </span>
            <span className="rounded-md border border-emerald-500/30 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              {t("sidechat.badge")}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--hx-text-3)]">
            {t("sidechat.context", { title: localizedTitle })}
          </p>
        </div>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => toggleSideChat(false)}
          className="hx-pressable rounded-lg p-1 text-[var(--hx-text-3)] hover:bg-[var(--hx-subtle)] hover:text-[var(--hx-text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)] px-4 py-2 text-[11px] text-[var(--hx-text-2)]">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span>{t("sidechat.notice")}</span>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3.5 text-xs">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-[var(--hx-text-3)]">
            <MessageSquareOff className="mb-2 h-6 w-6 opacity-50" />
            <p className="max-w-xs leading-relaxed">{t("sidechat.empty")}</p>
            <p className="mt-1.5 font-mono text-[10px]">{t("sidechat.shortcut")}</p>
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className="space-y-1.5">
              <div className="ml-6 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3 py-2 text-[var(--hx-text)]">
                {turn.question}
              </div>
              <div className="mr-4 rounded-xl border border-violet-500/25 bg-violet-50/70 px-3 py-2 text-[var(--hx-text)] dark:bg-violet-950/25">
                <MarkdownProse
                  className="text-xs"
                  content={
                    locale.startsWith("zh") && turn.answer.startsWith("[Isolated Side Chat")
                      ? `【旁路隔离回答】关于「${turn.question}」：当前回答完全隔离于主任务轨迹与 Harness² 自进化语料之外，不会污染任何上下文。`
                      : turn.answer
                  }
                />
                <div className="hx-num mt-1 font-mono text-[10px] text-[var(--hx-text-3)]">
                  {t("sidechat.isolated")} · {formatUsd(turn.costUsd)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => void handleAsk(e)}
        className="flex gap-2 border-t border-[var(--hx-border)] p-3"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("sidechat.placeholder")}
          className="flex-1 rounded-xl border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-3 py-1.5 text-xs text-[var(--hx-text)] placeholder:text-[var(--hx-text-3)] focus:border-[var(--hx-accent-border)]"
        />
        <button
          type="submit"
          disabled={!question.trim() || sideChatLoading}
          className="hx-pressable flex items-center gap-1 rounded-xl bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {sideChatLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}
