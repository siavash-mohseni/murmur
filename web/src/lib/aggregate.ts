import type { Activity } from "@/hooks/useDashboardState";

// Pure data-aggregation helpers shared by the panel views. These were moved out
// of the individual panel modules so the reduce logic lives apart from the JSX
// and can be reasoned about (and tested) on its own. Behavior is identical to
// the previous in-component definitions.

export interface FileAgg {
  path: string;
  writes: number;
  reads: number;
  lastTouched: string;
}
export function aggregateFiles(activities: Activity[]): FileAgg[] {
  const map = new Map<string, FileAgg>();
  for (const a of activities) {
    if (a.kind !== "tool") continue;
    const isWrite =
      a.tool === "Edit" || a.tool === "Write" || a.tool === "MultiEdit" || a.tool === "NotebookEdit";
    const isRead = a.tool === "Read";
    if (!isWrite && !isRead) continue;
    const path = a.target ?? "";
    if (!path) continue;
    const cur =
      map.get(path) ??
      { path, writes: 0, reads: 0, lastTouched: a.timestamp };
    if (isWrite) cur.writes += 1;
    else cur.reads += 1;
    if (a.timestamp > cur.lastTouched) cur.lastTouched = a.timestamp;
    map.set(path, cur);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.writes !== a.writes) return b.writes - a.writes;
    return a.lastTouched < b.lastTouched ? 1 : -1;
  });
}

export interface SkillAgg {
  name: string;
  source: "tool" | "slash" | "both";
  count: number;
  lastAt: string;
}
export function aggregateSkills(activities: Activity[]): SkillAgg[] {
  const map = new Map<string, SkillAgg>();
  const observe = (name: string, source: "tool" | "slash", ts: string): void => {
    const cur = map.get(name);
    if (cur) {
      cur.count += 1;
      if (cur.source !== source) cur.source = "both";
      if (ts > cur.lastAt) cur.lastAt = ts;
    } else {
      map.set(name, { name, source, count: 1, lastAt: ts });
    }
  };
  for (const a of activities) {
    if (a.kind === "tool" && a.tool === "Skill") {
      const name = a.target?.split(/\s+/)[0] ?? "(unknown)";
      observe(name, "tool", a.timestamp);
    } else if (a.kind === "prompt" && a.source === "user") {
      const m = a.question.match(/^\/([\w-]+)/);
      if (m) observe(m[1] ?? "", "slash", a.timestamp);
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.lastAt < b.lastAt ? 1 : -1;
  });
}

export interface SlashAgg {
  name: string;
  args?: string;
  count: number;
  lastAt: string;
}
export function aggregateSlashes(activities: Activity[]): SlashAgg[] {
  const map = new Map<string, SlashAgg>();
  for (const a of activities) {
    if (a.kind !== "prompt") continue;
    if (a.source !== "user") continue;
    const m = a.question.match(/^\/([\w-]+)(?:\s+(.*))?$/);
    if (!m) continue;
    const name = m[1] ?? "";
    const args = m[2]?.trim();
    const cur = map.get(name) ?? { name, args, count: 0, lastAt: a.timestamp };
    cur.count += 1;
    if (a.timestamp > cur.lastAt) cur.lastAt = a.timestamp;
    if (args) cur.args = args;
    map.set(name, cur);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.lastAt < b.lastAt ? 1 : -1;
  });
}

export interface AgentStat {
  subagentType: string;
  count: number;
  totalMs: number;
  successes: number;
  failures: number;
  lastAt: string;
}
export function aggregateAgents(activities: Activity[]): AgentStat[] {
  const map = new Map<string, AgentStat>();
  for (const a of activities) {
    if (a.kind !== "agent") continue;
    const key = a.subagentType ?? "(unknown)";
    const cur =
      map.get(key) ?? {
        subagentType: key,
        count: 0,
        totalMs: 0,
        successes: 0,
        failures: 0,
        lastAt: a.timestamp,
      };
    cur.count += 1;
    cur.totalMs += a.durationMs ?? 0;
    if (a.ok === true) cur.successes += 1;
    else if (a.ok === false) cur.failures += 1;
    if (a.timestamp > cur.lastAt) cur.lastAt = a.timestamp;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

export interface ToolStat {
  tool: string;
  count: number;
  totalMs: number;
  failures: number;
  // 95th-percentile call duration, ms. 0 when no call carried a duration.
  p95Ms: number;
}
export function aggregateTools(activities: Activity[]): ToolStat[] {
  const map = new Map<string, ToolStat>();
  const durations = new Map<string, number[]>();
  for (const a of activities) {
    if (a.kind !== "tool") continue;
    const cur = map.get(a.tool) ?? { tool: a.tool, count: 0, totalMs: 0, failures: 0, p95Ms: 0 };
    cur.count += 1;
    cur.totalMs += a.durationMs ?? 0;
    if (a.ok === false) cur.failures += 1;
    if (a.durationMs !== undefined) {
      const list = durations.get(a.tool) ?? [];
      list.push(a.durationMs);
      durations.set(a.tool, list);
    }
    map.set(a.tool, cur);
  }
  for (const [tool, list] of durations) {
    list.sort((x, y) => x - y);
    const stat = map.get(tool)!;
    stat.p95Ms = list[Math.min(list.length - 1, Math.floor(list.length * 0.95))] ?? 0;
  }
  return Array.from(map.values()).sort((a, b) => b.totalMs - a.totalMs || b.count - a.count);
}
