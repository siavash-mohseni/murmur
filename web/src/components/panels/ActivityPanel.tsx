import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { ActivityImages } from "@/components/ActivityImages";
import { activityAvatarTone, activityIcon, activityLabel, rawTooltip } from "@/components/atoms";
import { formatDuration, formatLocalTime } from "@/lib/format";
import { filterByPeriod, periodLabel, type ActivityFilter, type Period } from "@/lib/period";

export function ActivityPanel({
  activities,
  period,
  now,
}: {
  activities: Activity[];
  period: Period;
  now: number;
}): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const inPeriod = useMemo(
    () => filterByPeriod(activities, period, now),
    [activities, period, now]
  );

  const counts = useMemo(() => {
    const c: Record<ActivityFilter, number> = {
      all: inPeriod.length,
      tool: 0,
      agent: 0,
      prompt: 0,
      hook: 0,
      log: 0,
      warn: 0,
    };
    for (const a of inPeriod) c[a.kind] += 1;
    return c;
  }, [inPeriod]);

  const visible = useMemo(() => {
    if (filter === "all") return inPeriod;
    return inPeriod.filter((a) => a.kind === filter);
  }, [inPeriod, filter]);

  // Autoscroll only when the list shown on screen grows from a genuinely new
  // tail event. Keying on the full activities length would yank the viewport to
  // the bottom even when a new event is filtered out of the current view, so we
  // track the visible (filtered) length. But a filter/period switch also changes
  // visible.length without any new event, and the old version (keyed on the full
  // activities array) never scrolled on those, so we gate the scroll on the view
  // being unchanged since the last run to avoid snapping the user to the bottom
  // when they widen a filter or window.
  const lastCountRef = useRef(visible.length);
  const lastViewRef = useRef<{ filter: ActivityFilter; period: Period }>({ filter, period });
  useEffect(() => {
    const sameView =
      lastViewRef.current.filter === filter && lastViewRef.current.period === period;
    if (sameView && visible.length > lastCountRef.current) {
      const el = scrollRef.current;
      if (el) {
        const viewport = el.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      }
    }
    lastCountRef.current = visible.length;
    lastViewRef.current = { filter, period };
  }, [visible, filter, period]);

  const pill = (key: ActivityFilter, label: string): React.JSX.Element => (
    <button
      onClick={() => setFilter(key)}
      className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition ${
        filter === key
          ? "bg-blue-500/20 text-blue-200 ring-blue-500/40"
          : "bg-white/[0.03] text-zinc-300 ring-white/10 hover:bg-white/[0.06]"
      }`}
    >
      {label} <span className="ml-1 text-[10px] text-zinc-500">{counts[key]}</span>
    </button>
  );

  return (
    <Panel
      title="Recent activity"
      subtitle={
        activities.length === 0
          ? "Tool calls and narrative status land here"
          : period === "session"
            ? `${inPeriod.length} entries this session`
            : `${inPeriod.length} entries in the ${periodLabel(period).toLowerCase()}`
      }
      headerRight={
        <div className="flex flex-wrap gap-1.5">
          {pill("all", "All")}
          {pill("tool", "Tools")}
          {pill("agent", "Agents")}
          {pill("prompt", "Prompts")}
          {pill("hook", "Hooks")}
          {pill("log", "Logs")}
          {pill("warn", "Warnings")}
        </div>
      }
      empty="No entries in this view."
    >
      {visible.length === 0 ? undefined : (
        <>
          <div className="tbl-head">
            <span className="w-16 shrink-0">Time</span>
            <span className="w-7 shrink-0" />
            <span className="flex-1 min-w-0">What happened</span>
            <span className="w-16 shrink-0 text-right">Dur</span>
          </div>
          <ScrollArea ref={scrollRef} className="h-[28rem]">
          {visible.map((a) => {
            const time = formatLocalTime(a.timestamp);
            const label = activityLabel(a);
            const dur =
              a.kind === "tool" || a.kind === "agent" ? formatDuration(a.durationMs) : null;
            const isError =
              a.kind === "tool"
                ? !a.ok
                : a.kind === "prompt"
                  ? a.ok === false
                  : false;
            const tooltip = rawTooltip(a);
            return (
              <div key={a.id} className="tbl-row">
                <span className="w-16 shrink-0 pt-0.5 text-xs text-zinc-500 tabular-nums">
                  {time}
                </span>
                <span className={`avatar-blob -mt-1 ${activityAvatarTone(a)}`}>
                  {activityIcon(a)}
                </span>
                <span
                  className="flex-1 min-w-0 flex flex-col gap-0.5"
                  title={tooltip}
                >
                  <span className="text-sm font-medium text-zinc-100 break-words">
                    {label.primary}
                    {isError && (
                      <span className="ml-1.5 text-[10px] font-semibold text-rose-300">error</span>
                    )}
                  </span>
                  {label.secondary && (
                    <code className="self-start max-w-full rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-zinc-400 break-all whitespace-pre-wrap line-clamp-3">
                      {label.secondary}
                    </code>
                  )}
                  {a.kind === "prompt" && a.images && a.images.length > 0 && (
                    <ActivityImages images={a.images} className="mt-1" />
                  )}
                </span>
                <span className="w-16 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                  {dur ?? ""}
                </span>
              </div>
            );
          })}
          </ScrollArea>
        </>
      )}
    </Panel>
  );
}
