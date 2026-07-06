import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATS_CACHE_PATH = join(homedir(), ".claude", "stats-cache.json");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface DailyActivityEntry {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface StatsCacheShape {
  dailyActivity?: Array<{
    date?: string;
    messageCount?: number;
    sessionCount?: number;
    toolCallCount?: number;
  }>;
}

const RECENT_DAYS = 14;

let cachedMtimeMs = -1;
let cachedSize = -1;
let cachedDaily: DailyActivityEntry[] = [];

function readStatsCacheDaily(): DailyActivityEntry[] {
  if (!existsSync(STATS_CACHE_PATH)) return [];
  let mtimeMs: number;
  let size: number;
  try {
    const s = statSync(STATS_CACHE_PATH);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    return cachedDaily;
  }
  if (mtimeMs === cachedMtimeMs && size === cachedSize) {
    return cachedDaily;
  }
  try {
    const raw = JSON.parse(readFileSync(STATS_CACHE_PATH, "utf8")) as StatsCacheShape;
    const entries = (raw.dailyActivity ?? [])
      .filter((e): e is Required<Pick<DailyActivityEntry, "date">> & Partial<DailyActivityEntry> =>
        typeof e.date === "string"
      )
      .map((e) => ({
        date: e.date,
        messageCount: e.messageCount ?? 0,
        sessionCount: e.sessionCount ?? 0,
        toolCallCount: e.toolCallCount ?? 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    cachedDaily = entries.slice(-RECENT_DAYS);
    cachedMtimeMs = mtimeMs;
    cachedSize = size;
  } catch {
    // keep previous cache on parse failure
  }
  return cachedDaily;
}

const TODAY_TTL_MS = 30_000;
let todayCacheAt = 0;
let todayCache: DailyActivityEntry | null = null;

interface JsonlLine {
  type?: string;
  timestamp?: string;
  message?: {
    content?: Array<{ type?: string }>;
  };
}

/**
 * Per-file memo of one file's contribution to today's activity, keyed by path.
 * A transcript that has not changed since the last scan (same mtime and size)
 * keeps the same counts, so we reuse them instead of re-reading and re-parsing
 * the whole file every 30s TTL miss. Only files whose mtime or size advanced
 * are re-parsed, so the aggregate stays O(changed bytes) per tick while
 * producing identical totals.
 */
interface FileActivity {
  mtimeMs: number;
  size: number;
  messages: number;
  toolCalls: number;
  sessionContributed: boolean;
}

const fileActivityCache = new Map<string, FileActivity>();
// The memo is date-specific (line counts depend on today's local date), so it
// is dropped whenever the active date rolls over.
let fileActivityDate = "";

// Local calendar date (YYYY-MM-DD) of a Date, using its local components.
// Claude Code's stats-cache.json buckets daily activity by local date, so we
// must match that convention when stamping and deduping the live "today" entry.
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse one transcript and tally the lines whose own timestamp falls within the
// local calendar day [startMs, endMs). Timestamps are absolute (UTC) instants,
// so comparing their epoch ms against local-midnight boundaries buckets them by
// the local day — matching how Claude Code's own stats bucket them.
function countFileActivity(content: string, startMs: number, endMs: number): {
  messages: number;
  toolCalls: number;
} {
  let messages = 0;
  let toolCalls = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line) continue;
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(line) as JsonlLine;
    } catch {
      continue;
    }
    const ts = parsed.timestamp;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs) || tsMs < startMs || tsMs >= endMs) continue;
    messages++;
    const blocks = parsed.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b && b.type === "tool_use") toolCalls++;
      }
    }
  }
  return { messages, toolCalls };
}

/**
 * Live computation of today's activity by scanning JSONL transcripts touched
 * since local midnight. Claude Code only refreshes stats-cache.json
 * periodically (on /usage or session shutdown), so without this the Activity
 * tile sits frozen on a multi-day-old entry.
 *
 * Each line is JSON-parsed and only counted if its own `timestamp` falls within
 * today's LOCAL calendar day. Local (not UTC) is what makes the live entry line
 * up with the base entries from stats-cache.json, which are keyed by local date
 * — otherwise, around midnight in any non-UTC timezone, the two disagree and the
 * dedupe on `today.date` produces a duplicated or stale count. A naive
 * mtime+line-count approach inflates the tally because long-running transcripts
 * started yesterday keep getting appended today, and would otherwise bleed all
 * their pre-midnight lines in.
 */
function computeTodayActivity(): DailyActivityEntry | null {
  const now = Date.now();
  if (now - todayCacheAt < TODAY_TTL_MS && todayCache) return todayCache;
  if (!existsSync(PROJECTS_DIR)) return null;
  const nowDate = new Date();
  // Local midnight today and tomorrow. `new Date(y, m, d+1)` rolls month/year
  // over correctly and is DST-aware, so the window is exactly one local day.
  const midnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const nextMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
  const cutoffMs = midnight.getTime();
  const endMs = nextMidnight.getTime();
  const dateIso = localDateStr(midnight);
  // The per-file memo's counts are tied to a specific local date, so drop it on
  // a day rollover before reusing any entry.
  if (dateIso !== fileActivityDate) {
    fileActivityCache.clear();
    fileActivityDate = dateIso;
  }
  let messageCount = 0;
  let toolCallCount = 0;
  let sessionCount = 0;
  let projects: string[];
  try {
    projects = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  const seen = new Set<string>();
  for (const project of projects) {
    const projectPath = join(PROJECTS_DIR, project);
    let files: string[];
    try {
      files = readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projectPath, file);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoffMs) continue;
      seen.add(path);
      let entry = fileActivityCache.get(path);
      // Re-parse only when the file is new or its stat advanced. An unchanged
      // (mtime, size) reuses the memoised counts, keeping totals identical.
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        let content: string;
        try {
          content = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const counts = countFileActivity(content, cutoffMs, endMs);
        entry = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          messages: counts.messages,
          toolCalls: counts.toolCalls,
          sessionContributed: counts.messages > 0,
        };
        fileActivityCache.set(path, entry);
      }
      if (entry.sessionContributed) {
        messageCount += entry.messages;
        toolCallCount += entry.toolCalls;
        sessionCount++;
      }
    }
  }
  // Drop memo entries for files no longer present in today's scan (deleted, or
  // aged past the midnight cutoff) so the map cannot grow unbounded within a day.
  for (const path of fileActivityCache.keys()) {
    if (!seen.has(path)) fileActivityCache.delete(path);
  }
  todayCache = {
    date: dateIso,
    messageCount,
    sessionCount,
    toolCallCount,
  };
  todayCacheAt = now;
  return todayCache;
}

export function readDailyActivity(): DailyActivityEntry[] {
  const base = readStatsCacheDaily();
  const today = computeTodayActivity();
  if (!today) return base;
  // Drop any stats-cache entry that overlaps today's date (shouldn't happen
  // because Claude only writes the cache after a day closes, but be defensive)
  // then append the live today entry and trim to the RECENT_DAYS window.
  const merged = base.filter((e) => e.date !== today.date);
  merged.push(today);
  return merged.slice(-RECENT_DAYS);
}
