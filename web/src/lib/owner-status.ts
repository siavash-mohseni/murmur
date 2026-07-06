// Derives the owner view's single status headline from session state. Pure
// (state in, status out) so the precedence below is testable without React.

import type { Activity, DashboardState, Row } from "@/hooks/useDashboardState";
import type { StuckWarning } from "@/hooks/useStuckDetection";
import { eventIntent, permissionIntent, truncate, type EventIntent } from "@/lib/event-intent";
import { relativeTime } from "@/lib/format";
import { countNoun, type OwnerTone } from "@/lib/owner-language";

// How recently the last activity must have landed for the session to still
// read as "working" when no row is in progress.
export const ACTIVE_WINDOW_MS = 90_000;

export type OwnerStatusKind =
  | "connecting"
  | "offline"
  | "needs_you"
  | "stuck"
  | "working"
  | "attention"
  | "done"
  | "idle";

export interface OwnerStatus {
  kind: OwnerStatusKind;
  headline: string;
  detail?: string;
  tone: OwnerTone;
  // When set, the hero shows "since" elapsed time from this instant.
  sinceIso?: string;
}

// Precedence, first match wins:
//  1. no state yet            -> connecting
//  2. mirror went stale       -> offline
//  3. pending question        -> needs_you
//  4. pending permission      -> needs_you
//  5. stuck warnings          -> stuck
//  6. a row is in progress    -> working (named by the row's goal)
//  7. recent activity         -> working (generic)
//  8. all rows terminal       -> attention (any failed) or done
//  9. pending rows, all quiet -> idle ("Paused")
// 10. no rows                 -> idle (replied / quiet / just started)
export function deriveOwnerStatus(input: {
  state: DashboardState | null;
  stuckWarnings: StuckWarning[];
  isStale: boolean;
  now: number;
}): OwnerStatus {
  const { state, stuckWarnings, isStale, now } = input;

  if (state === null) {
    return { kind: "connecting", headline: "Connecting to your session", tone: "zinc" };
  }

  if (isStale) {
    return {
      kind: "offline",
      headline: "Murmur lost contact with this session",
      detail: "What you see below may be out of date",
      tone: "amber",
    };
  }

  if (state.pendingQuestion) {
    return {
      kind: "needs_you",
      headline: "Claude has a question for you",
      detail: truncate(state.pendingQuestion.question, 120),
      tone: "amber",
      sinceIso: state.pendingQuestion.createdAt,
    };
  }

  if (state.pendingPermission) {
    const p = state.pendingPermission;
    return {
      kind: "needs_you",
      headline: "Claude is asking for permission",
      detail: permissionIntent(p.tool, p.command).headline,
      tone: "amber",
      sinceIso: p.createdAt,
    };
  }

  if (stuckWarnings.length > 0) {
    return {
      kind: "stuck",
      headline: "This might be stuck",
      detail: stuckDetail(stuckWarnings[0]),
      tone: "amber",
    };
  }

  const rows = state.rows;
  const activities = state.activities;
  const latest = latestNonHook(activities);
  // A plain present-tense phrase for what Claude is doing right now ("Editing
  // files", "Running commands"), derived from the recent activity mix. Reads
  // better for a non-programmer than the past-tense recap, which we keep as a
  // fallback when the recent mix has no clear shape.
  const workPhrase = recentWorkPhrase(activities, now);
  // eventIntent headlines are past tense ("Built the project"), which reads
  // naturally as a recap line. Do not pipe them through toPresent, that maps
  // to the imperative, not the progressive.
  const latestRecap = latest ? `Latest: ${lowerFirst(eventIntent(latest).headline)}` : undefined;
  const workDetail = workPhrase ?? latestRecap;

  const running = latestInProgressRow(rows);
  if (running) {
    return {
      kind: "working",
      headline: `Working on: ${running.label}`,
      detail: workDetail,
      tone: "blue",
      sinceIso: running.startedAt,
    };
  }

  const lastActivityMs = latest ? Date.parse(latest.timestamp) : Number.NaN;
  const recentlyActive = Number.isFinite(lastActivityMs) && now - lastActivityMs < ACTIVE_WINDOW_MS;
  if (recentlyActive) {
    return {
      kind: "working",
      headline: workPhrase ?? "Claude is working",
      detail: workPhrase ? latestRecap : undefined,
      tone: "blue",
    };
  }

  if (rows.length > 0) {
    const failed = rows.filter((r) => r.status === "failed").length;
    const completed = rows.filter((r) => r.status === "completed").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    const allTerminal = failed + completed === rows.length;
    if (allTerminal) {
      const endedIso = latestEndedAt(rows);
      if (failed > 0) {
        return {
          kind: "attention",
          headline: "Something needs attention",
          detail: `${failed} of ${countNoun(rows.length, "step")} failed`,
          tone: "rose",
          sinceIso: endedIso,
        };
      }
      return {
        kind: "done",
        headline: "All done",
        detail: `${countNoun(completed, "step")} finished`,
        tone: "emerald",
        sinceIso: endedIso,
      };
    }
    if (pending > 0) {
      return {
        kind: "idle",
        headline: "Paused",
        detail: `${countNoun(pending, "step")} still queued`,
        tone: "zinc",
      };
    }
  }

  if (latest && latest.kind === "prompt" && latest.source === "assistant") {
    return {
      kind: "idle",
      headline: "Claude replied and is waiting for you",
      tone: "zinc",
      sinceIso: latest.timestamp,
    };
  }
  if (latest) {
    return {
      kind: "idle",
      headline: "Quiet right now",
      detail: `Last activity ${relativeTime(latest.timestamp, now)}`,
      tone: "zinc",
    };
  }
  return { kind: "idle", headline: "Session just started", tone: "zinc" };
}

// A plain-language phrase for the kind of work happening right now, derived
// from the dominant verb among the recent tool/agent activities. Conversation,
// logs, and background hooks are not "work" and never count. Returns undefined
// when nothing recent has a clear shape, so the caller keeps its generic
// "Claude is working" headline.
const WORK_PHRASE: Partial<Record<EventIntent["verb"], string>> = {
  write: "Editing files",
  build: "Building the project",
  test: "Running tests",
  git: "Working with Git",
  exec: "Running commands",
  shell: "Running commands",
  search: "Searching the project",
  read: "Reading the code",
  web: "Looking something up online",
  agent: "Working with a helper",
  task: "Updating the plan",
  plan: "Planning the work",
};

// Tie-break order: a more active/specific verb wins over a passive one when two
// are equally frequent in the window.
const VERB_PRIORITY: EventIntent["verb"][] = [
  "write",
  "build",
  "test",
  "git",
  "exec",
  "shell",
  "search",
  "read",
  "web",
  "agent",
  "task",
  "plan",
];

function recentWorkPhrase(activities: Activity[], now: number): string | undefined {
  const counts = new Map<EventIntent["verb"], number>();
  // Walk newest-first, stop once outside the active window or after 12 samples.
  let sampled = 0;
  for (let i = activities.length - 1; i >= 0 && sampled < 12; i--) {
    const a = activities[i];
    if (a.kind !== "tool" && a.kind !== "agent") continue;
    const ms = Date.parse(a.timestamp);
    if (Number.isFinite(ms) && now - ms > ACTIVE_WINDOW_MS) break;
    const verb = eventIntent(a).verb;
    if (!(verb in WORK_PHRASE)) continue;
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
    sampled++;
  }
  if (counts.size === 0) return undefined;
  let best: EventIntent["verb"] | undefined;
  let bestCount = -1;
  for (const verb of VERB_PRIORITY) {
    const c = counts.get(verb) ?? 0;
    if (c > bestCount) {
      best = verb;
      bestCount = c;
    }
  }
  return best ? WORK_PHRASE[best] : undefined;
}

// How busy the session is right now, as a 0..1 value, from the count of real
// (non-hook) activities in the last minute. The hero's heartbeat uses it to set
// its speed and amplitude: a quiet session flatlines, a busy one races. Six or
// more events a minute reads as full intensity.
const RATE_WINDOW_MS = 60_000;
const RATE_FULL = 6;

export function recentActivityIntensity(activities: Activity[], now: number): number {
  let count = 0;
  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i];
    if (a.kind === "hook") continue;
    const ms = Date.parse(a.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (now - ms > RATE_WINDOW_MS) break;
    count++;
  }
  return Math.min(1, count / RATE_FULL);
}

function stuckDetail(w: StuckWarning): string {
  if (w.kind === "row-stalled") {
    const min = Math.max(1, Math.round(w.sinceMs / 60_000));
    return `"${w.label}" has been running for ${countNoun(min, "minute")}`;
  }
  return "The same command keeps repeating";
}

// Hooks fire constantly in the background (the mirror itself is one), so they
// never count as "the agent did something" for status purposes.
function latestNonHook(activities: Activity[]): Activity | undefined {
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i].kind !== "hook") return activities[i];
  }
  return undefined;
}

function latestInProgressRow(rows: Row[]): Row | undefined {
  let best: Row | undefined;
  let bestMs = -Infinity;
  for (const r of rows) {
    if (r.status !== "in_progress") continue;
    const ms = r.startedAt ? Date.parse(r.startedAt) : Number.NaN;
    if (!best || (Number.isFinite(ms) && ms >= bestMs)) {
      best = r;
      bestMs = Number.isFinite(ms) ? ms : bestMs;
    }
  }
  return best;
}

function latestEndedAt(rows: Row[]): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const r of rows) {
    if (!r.endedAt) continue;
    const ms = Date.parse(r.endedAt);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = r.endedAt;
      bestMs = ms;
    }
  }
  return best;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}
