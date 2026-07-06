import { useMemo } from "react";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { aggregateSkills, type SkillAgg } from "@/lib/aggregate";
import { relativeTime } from "@/lib/format";
import { filterByPeriod, type Period } from "@/lib/period";

export function SkillsLoadedPanel({
  activities,
  period,
  now,
}: {
  activities: Activity[];
  period: Period;
  now: number;
}): React.JSX.Element {
  const inPeriod = useMemo(
    () => filterByPeriod(activities, period, now),
    [activities, period, now]
  );
  const skills = useMemo(() => aggregateSkills(inPeriod), [inPeriod]);
  const sourceLabel = (s: SkillAgg["source"]): string =>
    s === "tool" ? "Skill tool" : s === "slash" ? "Slash" : "Both";
  const sourceTone = (s: SkillAgg["source"]): string =>
    s === "tool"
      ? "bg-violet-500/15 text-violet-300 ring-violet-500/30"
      : s === "slash"
        ? "bg-pink-500/15 text-pink-300 ring-pink-500/30"
        : "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30";
  return (
    <Panel
      title="Skills loaded"
      subtitle={skills.length === 0 ? "No skills invoked this session" : `${skills.length} distinct`}
      empty="Skills invoked via slash command or the Skill tool appear here."
    >
      {skills.length === 0 ? undefined : (
        <>
          <div className="tbl-head">
            <span className="flex-1 min-w-0">Skill</span>
            <span className="w-24 shrink-0">Source</span>
            <span className="w-12 shrink-0 text-right">Count</span>
            <span className="w-24 shrink-0 text-right">Last</span>
          </div>
          {skills.map((s) => (
            <div key={s.name} className="tbl-row">
              <span className="flex-1 min-w-0 text-sm font-medium text-zinc-100 break-words">
                {s.name}
              </span>
              <span className="w-24 shrink-0 pt-0.5">
                <span
                  className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${sourceTone(s.source)}`}
                >
                  {sourceLabel(s.source)}
                </span>
              </span>
              <span className="w-12 shrink-0 pt-0.5 text-right text-sm tabular-nums text-zinc-200">
                {s.count}
              </span>
              <span className="w-24 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                {relativeTime(s.lastAt, now)}
              </span>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
