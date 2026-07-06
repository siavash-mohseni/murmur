import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Workflow } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Panel } from "@/components/Panel";
import { StatusIcon, toneForStatus } from "@/components/atoms";
import { formatDuration, formatLongDuration, formatTokens } from "@/lib/format";
import type {
  WorkflowAgentMirror,
  WorkflowMirror,
  WorkflowPhaseMirror,
  WorkflowRunStatus,
} from "@/hooks/useDashboardState";

interface Props {
  workflows?: WorkflowMirror[];
  // When true, render without the standalone panel card/header so the parent
  // (ProgressPanel) can host it as a sub-section under one "Progress" header.
  embedded?: boolean;
}

// The run-status pill reuses the shared toneForStatus ladder (RowStatus plus
// stale/stopped) rather than a local copy of the same emerald/blue/rose/amber
// classes. A workflow run reports "running" where a row reports "in_progress",
// so map that one alias across for the tone lookup. Every other run status
// (completed, failed, stale, stopped) matches a tone key directly, and the pill
// text still shows the raw run status. The class string and markup are
// identical to the former local runStatusPill.
function runStatusTone(status: WorkflowRunStatus): string {
  return toneForStatus(status === "running" ? "in_progress" : status);
}

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  // claude-opus-4-8 -> opus-4-8, claude-haiku-4-5-20251001 -> haiku-4-5
  const m = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  return m || model;
}

function agentName(a: WorkflowAgentMirror): string {
  return a.label || `agent ${a.agentId.slice(0, 8)}`;
}

function AgentRow({ a }: { a: WorkflowAgentMirror }): React.JSX.Element {
  const model = shortModel(a.model);
  const tip = a.resultPreview || a.lastToolSummary || undefined;
  return (
    <div className="flex items-start gap-2.5 text-xs" title={tip}>
      <span className="pt-0.5 shrink-0">
        <StatusIcon status={a.state} />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-zinc-200 truncate">{agentName(a)}</span>
        {(a.lastToolSummary || a.resultPreview) && (
          <span className="text-[11px] text-zinc-500 truncate">
            {a.resultPreview || a.lastToolSummary}
          </span>
        )}
      </span>
      <span className="shrink-0 flex items-center gap-2 tabular-nums text-[10px] text-zinc-500">
        {a.attempts !== undefined && (
          <span
            className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-300"
            title={`retried — ${a.attempts} attempts`}
          >
            ×{a.attempts}
          </span>
        )}
        {model && (
          <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-zinc-400">
            {model}
          </span>
        )}
        {a.tokens !== undefined && a.tokens > 0 && (
          <span title="tokens">{formatTokens(a.tokens)}t</span>
        )}
        {a.toolCalls !== undefined && a.toolCalls > 0 && (
          <span title="tool calls">{a.toolCalls}⚒</span>
        )}
        {formatDuration(a.durationMs) && <span>{formatDuration(a.durationMs)}</span>}
      </span>
    </div>
  );
}

function AgentList({ agents }: { agents: WorkflowAgentMirror[] }): React.JSX.Element {
  // Group by phase when phase info exists (completed runs); otherwise flat.
  const groups = useMemo(() => {
    const hasPhases = agents.some((a) => a.phaseTitle);
    if (!hasPhases) return [{ title: undefined as string | undefined, agents }];
    const order: string[] = [];
    const map = new Map<string, WorkflowAgentMirror[]>();
    for (const a of agents) {
      const key = a.phaseTitle ?? "—";
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      map.get(key)!.push(a);
    }
    return order.map((title) => ({ title, agents: map.get(title)! }));
  }, [agents]);

  return (
    <div className="ml-9 border-l border-white/5 pl-4 py-2 space-y-3">
      {groups.map((g, i) => (
        <div key={g.title ?? `g${i}`} className="space-y-2">
          {g.title && (
            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              {g.title}
            </div>
          )}
          {g.agents.map((a) => (
            <AgentRow key={a.agentId} a={a} />
          ))}
        </div>
      ))}
    </div>
  );
}

// The "peek": the longest-running still-active agent, shown as a one-liner so a
// fanned-out run tells you what it's chewing on without expanding it.
function longestRunning(agents: WorkflowAgentMirror[]): WorkflowAgentMirror | null {
  let best: WorkflowAgentMirror | null = null;
  for (const a of agents) {
    if (a.state !== "in_progress") continue;
    if (!best || (a.durationMs ?? 0) > (best.durationMs ?? 0)) best = a;
  }
  return best;
}

// Declared phase plan, shown for a live run whose agents don't yet carry a
// per-agent phaseTitle (the journal has no phase data mid-run — see
// workflow-mirror.ts). Completed runs group agents by phase instead.
function PhaseStrip({ phases }: { phases: WorkflowPhaseMirror[] }): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {phases.map((p, i) => (
        <span
          key={`${p.index ?? i}-${p.title}`}
          title={p.detail}
          className="inline-flex items-center gap-1 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-400"
        >
          <span className="text-zinc-600 tabular-nums">{p.index ?? i + 1}</span>
          {p.title}
        </span>
      ))}
    </div>
  );
}

function RunRow({
  run,
  now,
}: {
  run: WorkflowMirror;
  now: number;
}): React.JSX.Element {
  const live = run.status === "running" || run.status === "stale";
  const [open, setOpen] = useState<boolean>(live);
  const pct =
    run.agentCount === 0
      ? 0
      : Math.round((run.doneCount / run.agentCount) * 100);

  const elapsed =
    run.durationMs !== undefined
      ? formatLongDuration(run.durationMs)
      : run.startedAt
        ? formatLongDuration(Math.max(0, now - Date.parse(run.startedAt)))
        : null;

  // Show the declared phase strip only while the agents themselves aren't
  // grouped by phase (i.e. live runs). Once complete, AgentList groups them.
  const agentsHavePhase = run.agents.some((a) => a.phaseTitle);
  const showPhaseStrip = !!run.phases?.length && !agentsHavePhase;
  const peek = live ? longestRunning(run.agents) : null;

  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-start gap-4 px-5 py-3 text-left text-sm hover:bg-white/[0.02] cursor-pointer"
      >
        <span className="w-5 shrink-0 flex justify-center pt-0.5">
          <ChevronRight
            className={`h-4 w-4 text-zinc-500 transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-100 truncate">
              {run.workflowName}
            </span>
            {/* done/total leads, before any detail, per the fan-out display ask */}
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-200">
              {run.doneCount}/{run.agentCount}
            </span>
            <span
              className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${runStatusTone(run.status)}`}
            >
              {run.status}
            </span>
          </div>
          {peek && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-blue-300/90">
              <span className="text-zinc-600">↳</span>
              <span className="truncate">{agentName(peek)}</span>
              {formatDuration(peek.durationMs) && (
                <span className="shrink-0 tabular-nums text-zinc-500">{formatDuration(peek.durationMs)}</span>
              )}
            </div>
          )}
          {run.summary && (
            <div className="mt-0.5 text-xs text-zinc-500 break-words">
              {run.summary}
            </div>
          )}
          {showPhaseStrip && <PhaseStrip phases={run.phases!} />}
          <div className="mt-2 max-w-md">
            <Progress value={pct} className="h-1 bg-white/[0.06]" />
          </div>
        </span>
        <span className="w-28 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-zinc-500 flex flex-col gap-0.5">
          {elapsed && (
            <span className={live ? "text-blue-300" : ""}>{elapsed}</span>
          )}
          {run.totalTokens !== undefined && run.totalTokens > 0 && (
            <span>{formatTokens(run.totalTokens)} tok</span>
          )}
          {run.totalToolCalls !== undefined && run.totalToolCalls > 0 && (
            <span>{run.totalToolCalls} tools</span>
          )}
        </span>
      </button>
      {open && run.agents.length > 0 && (
        <div className="bg-white/[0.015] px-5 pb-3">
          <AgentList agents={run.agents} />
        </div>
      )}
    </div>
  );
}

export function WorkflowsPanel({
  workflows,
  embedded,
}: Props): React.JSX.Element | null {
  const runs = workflows ?? [];

  const anyLive = runs.some(
    (r) => r.status === "running" || r.status === "stale"
  );
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  if (runs.length === 0) return null;

  const activeCount = runs.filter((r) => r.status === "running").length;
  const countLabel = `${runs.length} run${runs.length === 1 ? "" : "s"}${
    activeCount > 0 ? ` · ${activeCount} active` : ""
  }`;
  const body = (
    <div>
      {runs.map((run) => (
        <RunRow key={run.runId} run={run} now={now} />
      ))}
    </div>
  );

  if (embedded) {
    return (
      <div className="border-t border-white/5 mt-1">
        <div className="flex items-center gap-2 px-5 pt-3 pb-1">
          <Workflow className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-xs font-medium text-zinc-300">Workflows</span>
          <span className="text-[11px] text-zinc-500">· {countLabel}</span>
        </div>
        {body}
      </div>
    );
  }

  return (
    <Panel
      title="Workflows"
      subtitle={countLabel}
      headerIcon={<Workflow className="h-4 w-4 text-zinc-400" />}
    >
      {body}
    </Panel>
  );
}
