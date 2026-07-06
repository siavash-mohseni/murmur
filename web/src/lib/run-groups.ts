// Run grouping for progress rows, extracted verbatim from ProgressPanel so the
// operator and owner views cannot drift on what counts as a run.

import type { Row } from "@/hooks/useDashboardState";

export interface RunGroup {
  key: string;
  runId: string | undefined;
  title: string;
  rows: Row[];
}

// Group consecutive rows by runId, preserving order. A run with no explicit
// title falls back to "Run N" by its position.
export function groupRows(rows: Row[]): RunGroup[] {
  const out: RunGroup[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.runId === row.runId) {
      last.rows.push(row);
    } else {
      out.push({
        key: row.runId ?? `__nogroup__${out.length}`,
        runId: row.runId,
        title: row.runTitle ?? "",
        rows: [row],
      });
    }
  }
  // Name each run by its goal: explicit runTitle (from the skill /
  // orchestrator), else the first row's label. "Run N" is only a last resort
  // when a run somehow has no rows — far less useful than the goal.
  out.forEach((g, i) => {
    if (!g.title) g.title = g.rows[0]?.label ?? `Run ${i + 1}`;
  });
  return out;
}
