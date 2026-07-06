import { useMemo } from "react";
import type { Activity, Row } from "./useDashboardState";

export type StuckWarning =
  | { kind: "row-stalled"; label: string; sinceMs: number }
  | { kind: "loop"; command: string; count: number; windowMs: number };

const ROW_STALL_MS = 5 * 60_000;
// A stalled row only warns once the session has ALSO gone quiet. Long single
// commands (a 4-minute build inside a gate phase) keep a row in_progress past
// the stall threshold while activity is still landing, and warning then is a
// false positive the owner view surfaces prominently under "Needs you". The
// quiet window is sized to outlast typical build/test commands.
const ROW_QUIET_MS = 3 * 60_000;
const LOOP_WINDOW_MS = 60_000;
const LOOP_THRESHOLD = 4;

type ToolActivity = Extract<Activity, { kind: "tool" }>;

interface StallCandidate {
  label: string;
  startedAtMs: number;
}

export function useStuckDetection(
  rows: Row[],
  activities: Activity[],
  now: number
): StuckWarning[] {
  // Candidate extraction depends only on rows/activities, not on the clock.
  // Memoizing it here keeps the O(n) scan of the full activities array off the
  // per-tick path: only the cheap time-window comparison re-runs as `now`
  // advances. Output is identical to the former single-pass detector.
  const stallCandidates = useMemo<StallCandidate[]>(() => {
    // Row stalled: in_progress with a startedAt timestamp. updateRow re-stamps
    // startedAt on each transition, so it doubles as "last status change".
    const out: StallCandidate[] = [];
    for (const r of rows) {
      if (r.status !== "in_progress") continue;
      if (!r.startedAt) continue;
      out.push({ label: r.label, startedAtMs: Date.parse(r.startedAt) });
    }
    return out;
  }, [rows]);

  const bashTargets = useMemo<ToolActivity[]>(() => {
    // Identical-Bash-target loop candidates, pre-filtered independent of time.
    return activities.filter(
      (a) => a.kind === "tool" && a.tool === "Bash" && a.target
    ) as ToolActivity[];
  }, [activities]);

  // The feed is appended chronologically, so the last entry is the newest.
  const lastActivityMs = useMemo(() => {
    const last = activities[activities.length - 1];
    return last ? Date.parse(last.timestamp) : Number.NaN;
  }, [activities]);

  return useMemo(() => {
    const warnings: StuckWarning[] = [];

    // No activity at all counts as quiet, a row stuck before anything landed
    // should still warn.
    const quiet =
      !Number.isFinite(lastActivityMs) || now - lastActivityMs > ROW_QUIET_MS;
    if (quiet) {
      for (const c of stallCandidates) {
        const elapsed = now - c.startedAtMs;
        if (Number.isFinite(elapsed) && elapsed > ROW_STALL_MS) {
          warnings.push({ kind: "row-stalled", label: c.label, sinceMs: elapsed });
        }
      }
    }

    // Loop: identical Bash target N times within window.
    const counts = new Map<string, number>();
    for (const a of bashTargets) {
      // Mirror the original `< LOOP_WINDOW_MS` predicate exactly: an unparseable
      // timestamp yields NaN, and NaN < X is false, so it is excluded (a `>=`
      // guard would wrongly include NaN).
      if (!(now - Date.parse(a.timestamp) < LOOP_WINDOW_MS)) continue;
      counts.set(a.target ?? "", (counts.get(a.target ?? "") ?? 0) + 1);
    }
    for (const [cmd, count] of counts) {
      if (count >= LOOP_THRESHOLD && cmd) {
        warnings.push({ kind: "loop", command: cmd, count, windowMs: LOOP_WINDOW_MS });
      }
    }

    return warnings;
  }, [stallCandidates, bashTargets, lastActivityMs, now]);
}
