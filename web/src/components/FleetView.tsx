import { useCallback, useState } from "react";
import { Archive, CheckCircle2, GitBranch, Monitor } from "lucide-react";
import { Panel } from "@/components/Panel";
import { FleetAlerts } from "@/components/FleetAlerts";
import { PastSessionsModal } from "@/components/PastSessions";
import { QuestionCard, PermissionCard } from "@/components/owner/OwnerInbox";
import { useFleet, type FleetSessionSummary } from "@/hooks/useFleet";
import { useNow } from "@/hooks/useNow";
import { formatCost } from "@/lib/cost";
import { formatTokens, relativeTime } from "@/lib/format";
import type { PermissionDecision } from "@/hooks/useDashboardState";

// How recent the last activity must be for a session to read as "working".
const WORKING_WINDOW_MS = 90_000;

type FleetStatus = "needs-you" | "working" | "idle" | "offline";

function statusOf(s: FleetSessionSummary, now: number): FleetStatus {
  if (s.pendingQuestion || s.pendingPermission) return "needs-you";
  if (!s.alive) return "offline";
  const lastMs = s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0;
  return now - lastMs <= WORKING_WINDOW_MS ? "working" : "idle";
}

const STATUS_META: Record<FleetStatus, { dot: string; label: string; ink: string }> = {
  "needs-you": { dot: "bg-amber-400", label: "needs you", ink: "text-amber-300" },
  working: { dot: "bg-emerald-400", label: "working", ink: "text-emerald-300" },
  idle: { dot: "bg-zinc-500", label: "idle", ink: "text-zinc-400" },
  offline: { dot: "bg-zinc-700", label: "offline", ink: "text-zinc-500" },
};

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 backdrop-blur-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50 tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function SessionCard({
  s,
  now,
  onOpen,
}: {
  s: FleetSessionSummary;
  now: number;
  onOpen: () => void;
}): React.JSX.Element {
  const status = statusOf(s, now);
  const meta = STATUS_META[status];
  const contextPct =
    s.contextTokens && s.contextLimit ? Math.min(100, Math.round((s.contextTokens / s.contextLimit) * 100)) : null;
  const chips = Object.entries(s.resourceAttributes ?? {});
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3.5 text-left transition hover:border-white/10 hover:bg-white/[0.05]"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot} ${status === "working" ? "animate-pulse" : ""}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
          {s.title ?? s.cwdBasename ?? s.key.slice(0, 12)}
        </span>
        <span className={`shrink-0 text-[11px] font-medium ${meta.ink}`}>{meta.label}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
        {s.cwdBasename && (
          <span className="inline-flex items-center gap-1">
            <Monitor className="h-3 w-3" /> {s.cwdBasename}
          </span>
        )}
        {s.branch && (
          <span className="inline-flex items-center gap-1 font-mono">
            <GitBranch className="h-3 w-3" /> {s.branch}
          </span>
        )}
        {s.model && <span>· {s.model}</span>}
        {chips.map(([k, v]) => (
          <span key={k} className="rounded bg-white/[0.06] px-1 py-px text-[10px] text-zinc-400">
            {k}={v}
          </span>
        ))}
      </div>
      {s.lastActivitySummary && (
        <div className="truncate text-xs text-zinc-400" title={s.lastActivitySummary}>
          {s.lastActivitySummary}
        </div>
      )}
      <div className="flex items-center gap-3 text-[11px] text-zinc-500 tabular-nums">
        {s.rowsTotal > 0 && (
          <span className={s.rowsFailed > 0 ? "text-rose-300" : undefined}>
            tasks {s.rowsCompleted}/{s.rowsTotal}
            {s.rowsFailed > 0 ? ` (${s.rowsFailed} failed)` : ""}
          </span>
        )}
        {typeof s.costUsd === "number" && s.costUsd > 0 && <span>{formatCost(s.costUsd)}</span>}
        {typeof s.totalTokens === "number" && s.totalTokens > 0 && <span>{formatTokens(s.totalTokens)} tok</span>}
        {s.lastActivityAt && <span className="ml-auto">{relativeTime(s.lastActivityAt, now)}</span>}
      </div>
      {contextPct !== null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={`h-full rounded-full ${contextPct >= 85 ? "bg-rose-400" : contextPct >= 65 ? "bg-amber-400" : "bg-blue-400"}`}
            style={{ width: `${contextPct}%` }}
          />
        </div>
      )}
    </button>
  );
}

// The hub home: every live session at a glance, blocked ones first, with a
// global needs-you inbox that answers questions and permissions inline via
// the /s/<key>/* proxy. Clicking a card drills into that session's full
// Operator/Owner dashboard without leaving the hub origin.
export function FleetView({ onOpenSession }: { onOpenSession: (key: string) => void }): React.JSX.Element {
  const { fleet, isStale } = useFleet();
  const now = useNow(1_000);
  const [pastOpen, setPastOpen] = useState(false);

  const answerFor = useCallback(
    (key: string) =>
      async (questionId: string, answer: string): Promise<boolean> => {
        const res = await fetch(`/s/${key}/api/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId, answer }),
        });
        return res.ok;
      },
    []
  );
  const cancelFor = useCallback(
    (key: string) =>
      async (questionId: string): Promise<boolean> => {
        const res = await fetch(`/s/${key}/api/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId }),
        });
        return res.ok;
      },
    []
  );
  const decideFor = useCallback(
    (key: string) =>
      async (permissionId: string, decision: PermissionDecision): Promise<boolean> => {
        const res = await fetch(`/s/${key}/api/permission/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissionId, decision }),
        });
        return res.ok;
      },
    []
  );

  const sessions = fleet?.sessions ?? [];
  const needsYou = sessions.filter((s) => s.pendingQuestion || s.pendingPermission);
  const working = sessions.filter((s) => statusOf(s, now) === "working").length;
  const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span
            aria-hidden
            className="inline-block h-7 w-7 rounded-md bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 shadow-sm shrink-0"
          />
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 truncate sm:text-3xl">
            Murmur
            <span className="ml-3 align-middle text-base font-normal text-zinc-400">Fleet</span>
          </h1>
          {isStale && <span className="text-xs text-amber-300">reconnecting…</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <FleetAlerts />
          <button
            type="button"
            onClick={() => setPastOpen(true)}
            className="period-pill inline-flex items-center gap-2"
          >
            <Archive className="h-4 w-4 text-zinc-400" />
            <span className="hidden sm:inline">Past sessions</span>
            <span className="sm:hidden">Past</span>
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Sessions" value={String(sessions.filter((s) => s.alive).length)} sub="live now" />
        <StatTile
          label="Needs you"
          value={String(needsYou.length)}
          sub={needsYou.length === 0 ? "all clear" : "answer below"}
        />
        <StatTile label="Working" value={String(working)} sub="active in the last 90s" />
        <StatTile label="Session spend" value={formatCost(totalCost)} sub="live sessions, est." />
      </div>

      {needsYou.length > 0 && (
        <Panel title="Needs you" subtitle={`${needsYou.length} session${needsYou.length === 1 ? "" : "s"} blocked`}>
          <div className="space-y-4 px-5 py-4">
            {needsYou.map((s) => (
              <div key={s.key} className="space-y-2">
                <button
                  type="button"
                  onClick={() => onOpenSession(s.key)}
                  className="text-xs font-medium text-zinc-400 transition hover:text-zinc-200"
                >
                  {s.title ?? s.cwdBasename ?? s.key.slice(0, 12)} ↗
                </button>
                {s.pendingQuestion && (
                  <QuestionCard
                    question={s.pendingQuestion}
                    onAnswer={answerFor(s.key)}
                    onCancel={cancelFor(s.key)}
                  />
                )}
                {s.pendingPermission && (
                  <PermissionCard permission={s.pendingPermission} onDecide={decideFor(s.key)} />
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {sessions.length === 0 ? (
        <Panel title="Sessions" subtitle="none live">
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <CheckCircle2 className="h-6 w-6 text-zinc-500" aria-hidden />
            <div className="text-sm font-medium text-zinc-300">No live sessions</div>
            <div className="text-xs text-zinc-500">
              Start a Claude Code session with Murmur active and it appears here.
            </div>
          </div>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <SessionCard key={s.key} s={s} now={now} onOpen={() => onOpenSession(s.key)} />
          ))}
        </div>
      )}

      <PastSessionsModal open={pastOpen} onClose={() => setPastOpen(false)} />
    </div>
  );
}
