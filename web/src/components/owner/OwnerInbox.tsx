import { useState } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { Countdown } from "@/components/Countdown";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/Panel";
import type {
  AgentSessionMirror,
  PendingPermission,
  PendingQuestion,
  PermissionDecision,
} from "@/hooks/useDashboardState";
import type { StuckWarning } from "@/hooks/useStuckDetection";
import { agentLabel, isWaiting } from "@/lib/agent-session";
import { permissionIntent } from "@/lib/event-intent";
import { countNoun, ownerRiskWord, toneClasses } from "@/lib/owner-language";

// The owner view's center of gravity: everything that needs a human decision,
// as persistent inline cards. The full-screen overlays still appear on top
// when the in-tab channel is on. These cards are deliberately NOT gated by the
// notification channel, so the inbox works even with the overlay off.
export function OwnerInbox({
  question,
  permission,
  stuckWarnings,
  agentSessions,
  currentSessionId,
  onAnswer,
  onCancelQuestion,
  onDecide,
}: {
  question: PendingQuestion | null;
  permission: PendingPermission | null;
  stuckWarnings: StuckWarning[];
  agentSessions: AgentSessionMirror[];
  currentSessionId?: string;
  onAnswer: (questionId: string, answer: string) => Promise<boolean>;
  onCancelQuestion: (questionId: string) => Promise<boolean>;
  onDecide: (permissionId: string, decision: PermissionDecision) => Promise<boolean>;
}): React.JSX.Element {
  const waiting = agentSessions.filter(isWaiting);
  const itemCount = (question ? 1 : 0) + (permission ? 1 : 0) + stuckWarnings.length + waiting.length;

  return (
    <Panel
      title="Needs you"
      subtitle={itemCount === 0 ? "all clear" : countNoun(itemCount, "item")}
    >
      {itemCount === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <CheckCircle2 className="h-6 w-6 text-emerald-400" aria-hidden />
          <div className="text-sm font-medium text-zinc-200">Nothing needs you right now</div>
          <div className="text-xs text-zinc-500">
            Anything that needs a decision will show up here
          </div>
        </div>
      ) : (
        <div className="space-y-3 px-5 py-4">
          {question && (
            <QuestionCard question={question} onAnswer={onAnswer} onCancel={onCancelQuestion} />
          )}
          {permission && <PermissionCard permission={permission} onDecide={onDecide} />}
          {stuckWarnings.map((w, i) => (
            <StuckCard key={`stuck-${i}`} warning={w} />
          ))}
          {waiting.map((a) => (
            <div
              key={a.sessionId ?? agentLabel(a)}
              className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-4 py-3 text-sm ring-1 ring-inset ring-white/10"
            >
              <Clock className="h-4 w-4 shrink-0 text-amber-300" aria-hidden />
              <span className="min-w-0 truncate text-zinc-200">
                Another session is waiting for input: {agentLabel(a)}
                {currentSessionId && a.sessionId === currentSessionId && (
                  <span className="text-zinc-500"> (this session)</span>
                )}
              </span>
              {a.waitingFor && (
                <span className="ml-auto min-w-0 truncate text-xs text-zinc-500">{a.waitingFor}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// Same interaction shape as the PendingQuestionPanel overlay, minus the modal
// chrome: option pills, a free-text answer, and a cancel link. Exported for
// the fleet view's global needs-you inbox.
export function QuestionCard({
  question,
  onAnswer,
  onCancel,
}: {
  question: PendingQuestion;
  onAnswer: (questionId: string, answer: string) => Promise<boolean>;
  onCancel: (questionId: string) => Promise<boolean>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (answer: string): Promise<void> => {
    if (!answer.trim()) return;
    setBusy(true);
    await onAnswer(question.questionId, answer.trim());
    setBusy(false);
    setText("");
  };

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
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
      <div className="text-sm font-semibold text-zinc-50">{question.question}</div>
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((opt) => (
            <button
              key={opt.label}
              type="button"
              disabled={busy}
              onClick={() => void submit(opt.label)}
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
            if (e.key === "Enter") void submit(text);
          }}
          disabled={busy}
          className="bg-white/[0.04] border-white/10 text-zinc-100 placeholder:text-zinc-500"
        />
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void submit(text)}
          className="inline-flex items-center rounded-md bg-white/[0.06] px-3 py-1.5 text-sm font-medium text-zinc-100 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.10] disabled:opacity-40"
        >
          Send
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onCancel(question.questionId).finally(() => setBusy(false));
          }}
          className="inline-flex items-center rounded-md px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-200 disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Plain-language headline first, the raw command behind a disclosure. The
// owner reads "Install package dependencies" with a risk word, and can still
// see the exact command on demand.
export function PermissionCard({
  permission,
  onDecide,
}: {
  permission: PendingPermission;
  onDecide: (permissionId: string, decision: PermissionDecision) => Promise<boolean>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const headline = permissionIntent(permission.tool, permission.command).headline;
  const risk = permission.classification ? ownerRiskWord(permission.classification.risk) : null;

  const decide = async (decision: PermissionDecision): Promise<void> => {
    setBusy(true);
    await onDecide(permission.permissionId, decision);
    setBusy(false);
  };

  return (
    <div className="space-y-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.05] px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-rose-300">
              Asking permission
            </span>
            <Countdown expiresAt={permission.expiresAt} />
          </div>
          <div className="mt-0.5 text-sm font-semibold text-zinc-50">{headline}</div>
        </div>
        {risk && (
          <span
            className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${toneClasses(risk.tone).pill}`}
          >
            {risk.label}
          </span>
        )}
      </div>
      {permission.command && (
        <details className="group">
          <summary className="cursor-pointer select-none text-xs text-zinc-500 transition hover:text-zinc-300">
            Show details
          </summary>
          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white/[0.05] p-3.5 font-mono text-sm leading-relaxed text-zinc-200 ring-1 ring-inset ring-white/10">
            {permission.command}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("allow")}
          className="inline-flex items-center rounded-full bg-emerald-400/10 px-4 py-1.5 text-[13px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/65 transition hover:bg-emerald-400/20 disabled:opacity-50"
        >
          Allow once
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("always")}
          className="inline-flex items-center rounded-full bg-white/[0.03] px-4 py-1.5 text-[13px] font-semibold text-zinc-200 ring-1 ring-inset ring-white/15 transition hover:bg-white/[0.08] disabled:opacity-50"
        >
          Always allow
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("deny")}
          className="inline-flex items-center rounded-full bg-rose-400/10 px-4 py-1.5 text-[13px] font-semibold text-rose-300 ring-1 ring-inset ring-rose-400/65 transition hover:bg-rose-400/20 disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function StuckCard({ warning }: { warning: StuckWarning }): React.JSX.Element {
  const text =
    warning.kind === "row-stalled"
      ? `"${warning.label}" has been running for ${countNoun(
          Math.max(1, Math.round(warning.sinceMs / 60_000)),
          "minute"
        )}`
      : "The same command keeps repeating";
  return (
    <div className="rounded-lg bg-white/[0.03] px-4 py-3 ring-1 ring-inset ring-amber-500/20">
      <div className="text-sm text-zinc-200">This might be stuck: {text}</div>
      <div className="mt-0.5 text-xs text-zinc-500">
        Check the Claude terminal or wait a moment
      </div>
    </div>
  );
}
