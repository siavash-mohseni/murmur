import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Panel } from "@/components/Panel";
import type { Activity, Row, WorkflowMirror } from "@/hooks/useDashboardState";
import { activityAvatarTone, activityIcon, activityLabel, rawTooltip, StatusIcon, StatusPill } from "@/components/atoms";
import { rowDuration } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { WorkflowsPanel } from "@/components/panels/WorkflowsPanel";
import { periodCutoffMs, type Period } from "@/lib/period";
import { groupRows, type RunGroup } from "@/lib/run-groups";

interface Props {
  rows: Row[];
  activities: Activity[];
  workflows?: WorkflowMirror[];
  period: Period;
  now: number;
}

function formatClock(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const SETUP_ID = "__setup__";

function ActivityList({ acts }: { acts: Activity[] }): React.JSX.Element {
  return (
    <div className="ml-9 border-l border-white/5 pl-4 py-2 space-y-2">
      {acts.map((a) => {
        const { primary, secondary } = activityLabel(a);
        const tooltip = rawTooltip(a);
        return (
          <div key={a.id} className="flex items-start gap-2.5 text-xs">
            <span className={`avatar-blob !h-6 !w-6 ${activityAvatarTone(a)}`} aria-hidden>
              {activityIcon(a)}
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5" title={tooltip}>
              <span className="text-zinc-300">{primary}</span>
              {secondary && (
                <code className="self-start max-w-full rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-zinc-400 break-all whitespace-pre-wrap">
                  {secondary}
                </code>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-[10px] text-zinc-600">
              {formatClock(a.timestamp)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ProgressPanel({
  rows,
  activities,
  workflows,
  period,
  now,
}: Props): React.JSX.Element {
  // Workflow runs honor the same period window as the activity panels: keep a
  // run whose last update falls inside the window. A live (running) run always
  // shows — its updatedAt refreshes every tailer tick anyway — while stale and
  // terminal runs age out of narrow windows.
  const workflowsInPeriod = useMemo(() => {
    const all = workflows ?? [];
    const cutoffMs = periodCutoffMs(period);
    if (cutoffMs === null) return all;
    const minTs = now - cutoffMs;
    return all.filter(
      (r) => r.status === "running" || Date.parse(r.updatedAt) >= minTs
    );
  }, [workflows, period, now]);
  const hasWorkflows = workflowsInPeriod.length > 0;
  const completed = rows.filter((r) => r.status === "completed").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const inProgress = rows.filter((r) => r.status === "in_progress").length;
  const pct = rows.length === 0 ? 0 : Math.round(((completed + failed) / rows.length) * 100);

  // One shared 1s wall clock. Only the open in-progress row's elapsed actually
  // reads this (via rowDuration), so a re-render with no in-progress row leaves
  // every rendered duration unchanged. The activity bucketing below does NOT
  // depend on this tick.
  const tick = useNow(1000);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState<Set<string>>(new Set());
  const [groupClosed, setGroupClosed] = useState<Set<string>>(new Set());

  const isOpen = (row: Row): boolean => {
    if (expanded.has(row.id)) return true;
    if (collapsed.has(row.id)) return false;
    return row.status === "in_progress";
  };

  const toggle = (row: Row, currentlyOpen: boolean): void => {
    if (currentlyOpen) {
      setExpanded((s) => {
        const n = new Set(s);
        n.delete(row.id);
        return n;
      });
      setCollapsed((s) => new Set(s).add(row.id));
    } else {
      setCollapsed((s) => {
        const n = new Set(s);
        n.delete(row.id);
        return n;
      });
      setExpanded((s) => new Set(s).add(row.id));
    }
  };

  const setupOpen = expanded.has(SETUP_ID);
  const toggleSetup = (): void => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(SETUP_ID)) n.delete(SETUP_ID);
      else n.add(SETUP_ID);
      return n;
    });
  };

  // Grouping lives in lib/run-groups.ts so the owner view shares it.
  const groups = useMemo<RunGroup[]>(() => groupRows(rows), [rows]);

  const multiRun = groups.length > 1;

  const isGroupOpen = (g: RunGroup, idx: number): boolean => {
    if (groupOpen.has(g.key)) return true;
    if (groupClosed.has(g.key)) return false;
    return idx === groups.length - 1; // newest run open by default
  };

  const toggleGroup = (g: RunGroup, currentlyOpen: boolean): void => {
    if (currentlyOpen) {
      setGroupOpen((s) => {
        const n = new Set(s);
        n.delete(g.key);
        return n;
      });
      setGroupClosed((s) => new Set(s).add(g.key));
    } else {
      setGroupClosed((s) => {
        const n = new Set(s);
        n.delete(g.key);
        return n;
      });
      setGroupOpen((s) => new Set(s).add(g.key));
    }
  };

  const { setupActivities, rowActivities } = useMemo(() => {
    const nonHook = (a: Activity): boolean => a.kind !== "hook";

    // Parse each activity's timestamp exactly once, keeping non-hook entries in
    // their original array order. The old per-row .filter re-parsed every
    // timestamp once per row (O(rows x activities) Date parses); this single
    // pass parses each timestamp once.
    const parsed: { a: Activity; t: number }[] = [];
    for (const a of activities) {
      if (nonHook(a)) parsed.push({ a, t: new Date(a.timestamp).getTime() });
    }

    // The first row that has actually started marks the boundary. Everything
    // before it is pre-step "Setup", so the first real step never absorbs
    // session-start exploration.
    const firstStarted = rows.find((r) => r.startedAt);
    const firstStart = firstStarted?.startedAt
      ? new Date(firstStarted.startedAt).getTime()
      : Infinity;

    const setup: Activity[] = [];
    for (const { a, t } of parsed) {
      if (t < firstStart) setup.push(a);
    }

    // Build each started row's [start, end] window paired with its bucket.
    // Chain each started row from the previous row's end, seeded at the first
    // row's own start. Inter-row gap activity attaches to the next step as
    // lead-in. A row that has started but not ended is bounded by the live clock
    // (tick), exactly as the old per-row filter was, so its window end and the
    // next row's chained start stay finite (this is why the memo depends on
    // tick). Rows that never started get an empty bucket.
    const map = new Map<string, Activity[]>();
    const windows: { bucket: Activity[]; start: number; end: number }[] = [];
    let prevEnd = firstStart;
    for (const row of rows) {
      if (!row.startedAt) {
        map.set(row.id, []);
        continue;
      }
      const end = row.endedAt ? new Date(row.endedAt).getTime() : tick;
      const start = prevEnd;
      const bucket: Activity[] = [];
      map.set(row.id, bucket);
      windows.push({ bucket, start, end });
      prevEnd = end;
    }

    // Sweep the already-parsed activities once, dropping each into every window
    // whose inclusive [start, end] contains its timestamp. The windows are
    // contiguous (each start equals the previous end), so a timestamp on a
    // shared boundary lands in both adjacent windows. That inclusive
    // double-count reproduces the previous per-row filter EXACTLY, and iterating
    // activities in their original order keeps each bucket's order identical.
    for (const { a, t } of parsed) {
      for (const w of windows) {
        if (t >= w.start && t <= w.end) w.bucket.push(a);
      }
    }

    return { setupActivities: setup, rowActivities: map };
  }, [rows, activities, tick]);

  const renderRow = (row: Row): React.JSX.Element => {
    const dur = rowDuration(row, tick);
    const acts = rowActivities.get(row.id) ?? [];
    const hasActs = acts.length > 0;
    const open = hasActs && isOpen(row);
    return (
      <div key={row.id} className="border-b border-white/5 last:border-b-0">
        <button
          type="button"
          onClick={() => hasActs && toggle(row, open)}
          disabled={!hasActs}
          className={`flex w-full items-start gap-4 px-5 py-3 text-left text-sm ${
            hasActs ? "hover:bg-white/[0.02] cursor-pointer" : "cursor-default"
          }`}
        >
          <span className="w-5 shrink-0 flex justify-center pt-0.5">
            {hasActs ? (
              <ChevronRight
                className={`h-4 w-4 text-zinc-500 transition-transform ${
                  open ? "rotate-90" : ""
                }`}
              />
            ) : (
              <StatusIcon status={row.status} />
            )}
          </span>
          <span className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {hasActs && (
                <span className="shrink-0">
                  <StatusIcon status={row.status} />
                </span>
              )}
              <span className="text-sm font-medium text-zinc-100">{row.label}</span>
              {hasActs && (
                <span className="text-[11px] text-zinc-500">
                  · {acts.length} action{acts.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {row.detail && (
              <div className="mt-0.5 text-xs text-zinc-500 break-words">{row.detail}</div>
            )}
          </span>
          <span
            className={`w-20 shrink-0 pt-0.5 text-right text-xs tabular-nums ${
              row.status === "in_progress" ? "text-blue-300" : "text-zinc-500"
            }`}
          >
            {dur ?? "—"}
          </span>
          <span className="w-24 shrink-0 flex justify-end pt-0.5">
            <StatusPill status={row.status} />
          </span>
        </button>
        {open && (
          <div className="bg-white/[0.015] px-5 pb-3">
            <ActivityList acts={acts} />
          </div>
        )}
      </div>
    );
  };

  const renderRunHeader = (g: RunGroup, idx: number, groupIsOpen: boolean): React.JSX.Element => {
    const gDone = g.rows.filter((r) => r.status === "completed").length;
    const gFailed = g.rows.filter((r) => r.status === "failed").length;
    const gActive = g.rows.filter((r) => r.status === "in_progress").length;
    return (
      <button
        type="button"
        onClick={() => toggleGroup(g, groupIsOpen)}
        className="flex w-full items-center gap-3 bg-white/[0.03] px-5 py-2.5 text-left hover:bg-white/[0.05] cursor-pointer border-b border-white/10"
      >
        <ChevronRight
          className={`h-4 w-4 text-zinc-500 transition-transform ${groupIsOpen ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
          {g.title || `Run ${idx + 1}`}
        </span>
        <span className="text-[11px] text-zinc-500">
          {gDone}/{g.rows.length} done
          {gActive ? ` · ${gActive} active` : ""}
          {gFailed ? ` · ${gFailed} failed` : ""}
        </span>
      </button>
    );
  };

  return (
    <Panel
      title="Progress"
      subtitle={
        rows.length === 0
          ? hasWorkflows
            ? `${workflowsInPeriod.length} workflow run${workflowsInPeriod.length === 1 ? "" : "s"}`
            : "Waiting for the agent to initialise"
          : multiRun
            ? `${groups.length} runs · ${completed}/${rows.length} steps done${inProgress ? ` · ${inProgress} active` : ""}${failed ? ` · ${failed} failed` : ""}`
            : `${completed}/${rows.length} done${inProgress ? ` · ${inProgress} active` : ""}${failed ? ` · ${failed} failed` : ""}`
      }
      headerRight={
        rows.length > 0 ? (
          <span className="text-xs tabular-nums text-zinc-400">{pct}%</span>
        ) : undefined
      }
    >
      {rows.length > 0 && (
        <div className="px-5 pt-4">
          <Progress value={pct} className="h-1.5 bg-white/[0.06]" />
        </div>
      )}
      {rows.length === 0 ? (
        hasWorkflows ? null : (
          <div className="px-5 py-6 text-sm text-zinc-500">No rows yet.</div>
        )
      ) : (
        <div>
          <div className="tbl-head">
            <span className="w-5 shrink-0" />
            <span className="flex-1">Phase / Gate</span>
            <span className="w-20 shrink-0 text-right">Duration</span>
            <span className="w-24 shrink-0 text-right">Status</span>
          </div>
          {setupActivities.length > 0 && (
            <div className="border-b border-white/5">
              <button
                type="button"
                onClick={toggleSetup}
                className="flex w-full items-start gap-4 px-5 py-3 text-left text-sm hover:bg-white/[0.02] cursor-pointer"
              >
                <span className="w-5 shrink-0 flex justify-center pt-0.5">
                  <ChevronRight
                    className={`h-4 w-4 text-zinc-500 transition-transform ${
                      setupOpen ? "rotate-90" : ""
                    }`}
                  />
                </span>
                <span className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-400">Setup</span>
                    <span className="text-[11px] text-zinc-500">
                      · {setupActivities.length} action{setupActivities.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-600">Before the first step started</div>
                </span>
                <span className="w-20 shrink-0 pt-0.5 text-right text-xs tabular-nums text-zinc-600">
                  —
                </span>
                <span className="w-24 shrink-0 flex justify-end pt-0.5" />
              </button>
              {setupOpen && (
                <div className="bg-white/[0.015] px-5 pb-3">
                  <ActivityList acts={setupActivities} />
                </div>
              )}
            </div>
          )}
          {multiRun
            ? groups.map((g, idx) => {
                const groupIsOpen = isGroupOpen(g, idx);
                return (
                  <div key={g.key}>
                    {renderRunHeader(g, idx, groupIsOpen)}
                    {groupIsOpen && g.rows.map(renderRow)}
                  </div>
                );
              })
            : groups[0]?.rows.map(renderRow)}
        </div>
      )}
      {hasWorkflows && <WorkflowsPanel embedded workflows={workflowsInPeriod} />}
    </Panel>
  );
}
