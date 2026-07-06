import { useMemo } from "react";
import { KpiTile } from "@/components/KpiTile";
import { Panel } from "@/components/Panel";
import type { Activity, Row, TokenStats, WorkflowMirror } from "@/hooks/useDashboardState";
import { aggregateFiles } from "@/lib/aggregate";
import { estimateCost, estimateWorkflowCost, formatCost } from "@/lib/cost";
import { elapsedString, formatLongDuration } from "@/lib/format";
import { isSyntheticUserPrompt } from "@/lib/summary-html";
import {
  countNoun,
  ownerRowStatusWord,
  ownerRunStatusWord,
  statusTone,
  toneClasses,
} from "@/lib/owner-language";
import { groupRows, type RunGroup } from "@/lib/run-groups";

// "Did it work": session totals in owner units (money, time, changes) plus a
// card per finished run and workflow.
export function OwnerOutcomes({
  rows,
  workflows,
  activities,
  tokenStats,
  startedAt,
  now,
}: {
  rows: Row[];
  workflows?: WorkflowMirror[];
  activities: Activity[];
  tokenStats: TokenStats | null;
  startedAt?: string;
  now: number;
}): React.JSX.Element {
  const filesChanged = useMemo(
    () => aggregateFiles(activities).filter((f) => f.writes > 0).length,
    [activities]
  );
  const actionCount = useMemo(
    () => activities.filter((a) => a.kind === "tool").length,
    [activities]
  );
  const messageCount = useMemo(
    () =>
      activities.filter(
        (a) => a.kind === "prompt" && a.source === "user" && !isSyntheticUserPrompt(a.question)
      ).length,
    [activities]
  );

  const workflowCost = estimateWorkflowCost(workflows);
  const totalCost = (tokenStats ? estimateCost(tokenStats) : 0) + workflowCost;
  const hasCost = tokenStats !== null || workflowCost > 0;

  const finishedRuns = groupRows(rows).filter((g) =>
    g.rows.every((r) => r.status === "completed" || r.status === "failed")
  );
  const finishedWorkflows = (workflows ?? []).filter((w) => w.status !== "running");
  const hasCards = finishedRuns.length > 0 || finishedWorkflows.length > 0;

  return (
    <Panel title="What happened" subtitle="this session">
      <div className="space-y-4 px-5 py-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Cost so far"
            value={hasCost ? formatCost(totalCost) : "—"}
            caption="estimated"
          />
          <KpiTile
            label="Time"
            value={startedAt ? elapsedString(startedAt, now) : "—"}
            caption="this session"
          />
          <KpiTile
            label="Changes"
            value={countNoun(filesChanged, "file")}
            caption={`${countNoun(actionCount, "action")} · ${countNoun(messageCount, "message")} from you`}
          />
        </div>

        {hasCards ? (
          <div className="space-y-2.5">
            {finishedRuns.map((g) => (
              <RunCard key={g.key} group={g} />
            ))}
            {finishedWorkflows.map((w) => (
              <WorkflowCard key={w.runId} workflow={w} />
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500">Nothing finished yet</div>
        )}
      </div>
    </Panel>
  );
}

function OutcomePill({ word, tone }: { word: string; tone: string }): React.JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tone}`}
    >
      {word}
    </span>
  );
}

function RunCard({ group }: { group: RunGroup }): React.JSX.Element {
  const done = group.rows.filter((r) => r.status === "completed").length;
  const failed = group.rows.length - done;
  const status = failed > 0 ? "failed" : "completed";

  const startMs = group.rows
    .map((r) => (r.startedAt ? Date.parse(r.startedAt) : Number.NaN))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.min(a, b), Infinity);
  const endMs = group.rows
    .map((r) => (r.endedAt ? Date.parse(r.endedAt) : Number.NaN))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), -Infinity);
  const duration =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? formatLongDuration(endMs - startMs)
      : null;

  return (
    <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-4 py-3 ring-1 ring-inset ring-white/10">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">{group.title}</span>
          <OutcomePill
            word={ownerRowStatusWord(status)}
            tone={toneClasses(statusTone(status)).pill}
          />
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {done} of {countNoun(group.rows.length, "step")} done
          {duration && ` · took ${duration}`}
        </div>
      </div>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowMirror }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-white/[0.03] px-4 py-3 ring-1 ring-inset ring-white/10">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-zinc-100">{workflow.workflowName}</span>
        <OutcomePill
          word={ownerRunStatusWord(workflow.status)}
          tone={toneClasses(statusTone(workflow.status)).pill}
        />
      </div>
      <div className="mt-0.5 text-xs text-zinc-500">
        {workflow.doneCount} of {countNoun(workflow.agentCount, "helper")} finished
        {typeof workflow.durationMs === "number" &&
          ` · took ${formatLongDuration(workflow.durationMs)}`}
      </div>
      {workflow.summary && <div className="mt-1.5 text-xs text-zinc-400">{workflow.summary}</div>}
    </div>
  );
}
