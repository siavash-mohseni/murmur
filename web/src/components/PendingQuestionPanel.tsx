import { useEffect, useRef, useState } from "react";
import { Countdown } from "@/components/Countdown";
import { Input } from "@/components/ui/input";
import type { useDashboardState } from "@/hooks/useDashboardState";

export function PendingQuestionPanel({
  question,
  onSubmit,
  onCancel,
}: {
  question: NonNullable<ReturnType<typeof useDashboardState>["state"]>["pendingQuestion"];
  onSubmit: (questionId: string, answer: string) => Promise<boolean>;
  onCancel: (questionId: string) => Promise<boolean>;
}): React.JSX.Element | null {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  // Auto-focus the first option (or the input if there are none) so the user
  // can answer with the keyboard immediately. Lock body scroll so the modal
  // is the only thing you can interact with.
  useEffect(() => {
    if (!question) return;
    firstOptionRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [question]);

  if (!question) return null;

  const handleOption = async (label: string): Promise<void> => {
    setBusy(true);
    await onSubmit(question.questionId, label);
    setBusy(false);
    setText("");
  };
  const handleSubmitText = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    await onSubmit(question.questionId, text.trim());
    setBusy(false);
    setText("");
  };
  const handleCancel = async (): Promise<void> => {
    setBusy(true);
    await onCancel(question.questionId);
    setBusy(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-amber-500/30 bg-zinc-950 shadow-2xl ring-1 ring-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-amber-500/10 px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            {question.header ? (
              <span className="inline-flex items-center rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-amber-300 ring-1 ring-inset ring-amber-500/30">
                {question.header}
              </span>
            ) : (
              <span />
            )}
            <Countdown expiresAt={question.expiresAt} />
          </div>
          <div className="mt-2 text-lg font-semibold text-zinc-50">{question.question}</div>
        </div>
        <div className="space-y-4 px-5 py-4">
          {question.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {question.options.map((opt, i) => (
                <button
                  key={opt.label}
                  ref={i === 0 ? firstOptionRef : null}
                  disabled={busy}
                  onClick={() => handleOption(opt.label)}
                  title={opt.description}
                  className="inline-flex items-center rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 ring-1 ring-inset ring-amber-400 transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:opacity-50"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="Or type a custom answer"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmitText();
              }}
              disabled={busy}
              autoFocus={question.options.length === 0}
              className="bg-white/[0.04] border-white/10 text-zinc-100 placeholder:text-zinc-500"
            />
            <button
              disabled={busy || !text.trim()}
              onClick={() => void handleSubmitText()}
              className="inline-flex items-center rounded-md bg-white/[0.06] px-3 py-1.5 text-sm font-medium text-zinc-100 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.10] disabled:opacity-40"
            >
              Send
            </button>
            <button
              disabled={busy}
              onClick={() => void handleCancel()}
              className="inline-flex items-center rounded-md px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-200 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
