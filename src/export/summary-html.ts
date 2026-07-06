import type { Activity, ActivityImage, Row, RowStatus } from "../shared-types.js";
import {
  escapeHtml,
  eventIntent,
  formatCount,
  iconSvg,
  verbPalette,
  type EventIntent,
} from "../event-intent.js";
import type { ShareContext } from "./context.js";

// Image resolver active for the current build. Renders are synchronous and
// single-threaded, so a module-scoped slot set at the top of buildSummaryHtml
// beats threading one more parameter through every render helper. When null
// (browser Share button), images are skipped: a saved standalone file cannot
// follow the dashboard's relative /api/image URLs.
let imageResolver: ShareContext["resolveImage"] | null = null;

function renderEventImages(images: ActivityImage[] | undefined): string {
  if (!images || images.length === 0 || !imageResolver) return "";
  const tags = images
    .map((img) => {
      const src = imageResolver?.(img);
      if (!src) return "";
      return `<img class="event-img" src="${src}" alt="${escapeHtml(img.alt ?? "transcript image")}" loading="lazy" />`;
    })
    .join("");
  return tags ? `<div class="event-imgs">${tags}</div>` : "";
}

// Inline lucide-style icons keyed by verb. The summary HTML opens as a
// standalone document in a new tab, so we can't import lucide-react — we
// ship the SVG paths inline. Stroke uses currentColor so the icon picks up
// the verb's ink colour from the surrounding .event-icon wrapper.
function verbIconSvg(verb: EventIntent["verb"]): string {
  switch (verb) {
    case "read":
      // eye — universally read as "view / look at"
      return iconSvg(
        '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
      );
    case "write":
      // square-pen — universally read as "edit / write"
      return iconSvg(
        '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9-4 1 1-4Z"/>'
      );
    case "search":
      return iconSvg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>');
    case "exec":
    case "shell":
      // terminal
      return iconSvg('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>');
    case "build":
      // hammer
      return iconSvg(
        '<path d="m15 12-8.4 8.4a2.1 2.1 0 0 1-2.97 0 2.1 2.1 0 0 1 0-2.97L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.9 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47Z"/>'
      );
    case "test":
      // flask-conical
      return iconSvg(
        '<path d="M10 2v7.31"/><path d="M14 9.3V2"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>'
      );
    case "git":
      // git-branch
      return iconSvg(
        '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'
      );
    case "web":
      // globe
      return iconSvg(
        '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'
      );
    case "agent":
      // bot
      return iconSvg(
        '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'
      );
    case "plan":
      // clipboard-list
      return iconSvg(
        '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>'
      );
    case "task":
      // list-checks
      return iconSvg(
        '<path d="M11 6h10"/><path d="M11 12h10"/><path d="M11 18h10"/><path d="m3 6 1.5 1.5L7 5"/><path d="m3 12 1.5 1.5L7 11"/><path d="m3 18 1.5 1.5L7 17"/>'
      );
    case "permission":
      // shield
      return iconSvg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>');
    case "question":
      // message-square
      return iconSvg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>');
    case "murmur-ask":
      // sparkles
      return iconSvg(
        '<path d="M12 3 9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5Z"/><path d="M19 3v4"/><path d="M21 5h-4"/>'
      );
    case "hook":
      // plug — matches the live activity panel's hook icon
      return iconSvg(
        '<path d="M12 22v-5"/><path d="M9 7V2"/><path d="M15 7V2"/><path d="M6 13V8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z"/>'
      );
    case "log":
      return iconSvg(
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'
      );
    case "warn":
      // alert-triangle
      return iconSvg(
        '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>'
      );
  }
}

// A logical "round" of the session: one user prompt and everything Claude did
// in response, up to the next user prompt. Activities that arrive before any
// user prompt land in a leading "Setup" round.
export interface SummaryRound {
  index: number;
  label: string;
  userPrompt?: Extract<Activity, { kind: "prompt" }>;
  events: Activity[];
  startedAt: string;
  endedAt: string;
}

/**
 * Detect Claude Code's synthetic user messages (task notifications,
 * system reminders, hook injections). These ride in as `prompt` activities
 * with `source: "user"` but they're not authored by the human — they
 * shouldn't start a new round or render as a YOU card.
 */
export function isSyntheticUserPrompt(question: string): boolean {
  const t = question.trim();
  return SYNTHETIC_PROMPT_PREFIXES.some((prefix) => t.startsWith(prefix));
}

// Claude Code wraps several non-human messages in these tags. They arrive as
// `prompt` activities with `source: "user"` but must not open a YOU round.
// A single named list keeps the membership test honest: adding a new synthetic
// tag is a one-line edit here.
const SYNTHETIC_PROMPT_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<user-prompt-submit-hook>",
] as const;

export function groupActivitiesIntoRounds(activities: Activity[]): SummaryRound[] {
  const rounds: SummaryRound[] = [];
  let current: SummaryRound | null = null;
  for (const a of activities) {
    if (a.kind === "prompt" && a.source === "user") {
      // Skip Claude Code's synthetic system messages (task notifications,
      // reminders). They're not human-authored.
      if (isSyntheticUserPrompt(a.question)) continue;
      current = {
        index: rounds.length + 1,
        label: `Round ${String(rounds.length + 1).padStart(2, "0")}`,
        userPrompt: a,
        events: [],
        startedAt: a.timestamp,
        endedAt: a.timestamp,
      };
      rounds.push(current);
      continue;
    }
    if (!current) {
      current = {
        index: 0,
        label: "Setup",
        events: [],
        startedAt: a.timestamp,
        endedAt: a.timestamp,
      };
      rounds.push(current);
    }
    current.events.push(a);
    current.endedAt = a.timestamp;
  }
  return rounds;
}

// Build a single-sentence "what happened in this round" from the event mix.
// Pure heuristic: counts the verbs the agent took (reads, edits, shells, asks,
// subagents) and lists the first few file targets if any were edited.
export function roundNarrative(r: SummaryRound): string {
  const tools = r.events.filter((e): e is Extract<Activity, { kind: "tool" }> => e.kind === "tool");
  const reads = tools.filter((t) => /^(Read|Glob|NotebookRead)$/.test(t.tool));
  const writes = tools.filter((t) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.tool));
  const bash = tools.filter((t) => t.tool === "Bash");
  const grep = tools.filter((t) => t.tool === "Grep");
  const web = tools.filter((t) => /^(WebFetch|WebSearch)$/.test(t.tool));
  const tasks = tools.filter((t) => /^(TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|TaskStop)$/.test(t.tool));
  const agents = r.events.filter((e) => e.kind === "agent");
  const asks = r.events.filter((e) => e.kind === "prompt" && e.source !== "user");
  const warns = r.events.filter((e) => e.kind === "warn");

  const bits: string[] = [];
  if (reads.length > 0) bits.push(`read ${reads.length} file${reads.length === 1 ? "" : "s"}`);
  if (grep.length > 0) bits.push(`ran ${grep.length} search${grep.length === 1 ? "" : "es"}`);
  if (writes.length > 0) {
    const targets = Array.from(new Set(
      writes
        .map((w) => (w.target ?? "").replace(/^.*\//, ""))
        .filter((s) => s.length > 0)
    )).slice(0, 3);
    const tail = targets.length > 0 ? ` (${targets.join(", ")}${writes.length > targets.length ? ", ..." : ""})` : "";
    bits.push(`edited ${writes.length} file${writes.length === 1 ? "" : "s"}${tail}`);
  }
  if (bash.length > 0) bits.push(`ran ${bash.length} shell command${bash.length === 1 ? "" : "s"}`);
  if (web.length > 0) bits.push(`fetched the web ${web.length} time${web.length === 1 ? "" : "s"}`);
  if (tasks.length > 0) bits.push(`updated ${tasks.length} task row${tasks.length === 1 ? "" : "s"}`);
  if (agents.length > 0) bits.push(`dispatched ${agents.length} subagent${agents.length === 1 ? "" : "s"}`);
  if (asks.length > 0) bits.push(`asked you ${asks.length} question${asks.length === 1 ? "" : "s"}`);
  if (warns.length > 0) bits.push(`hit ${warns.length} warning${warns.length === 1 ? "" : "s"}`);

  if (bits.length === 0) return "";
  const text = bits.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

// Walk a round's events in chronological order and collapse *runs* of
// consecutive identical hook firings into a single render unit with a count.
// Other event kinds pass through one-to-one. This keeps hooks in their
// chronological place (per user request) without ballooning the recap when a
// PostToolUse:Bash fires 200 times in a row.
type HookActivity = Extract<Activity, { kind: "hook" }>;
type RenderUnit =
  | { type: "event"; ev: Activity }
  | { type: "hookRun"; first: HookActivity; count: number; lastTs: string };

function hookKey(h: HookActivity): string {
  return h.event ? `${h.hook}:${h.event}` : h.hook;
}

function groupConsecutiveHooks(events: Activity[]): RenderUnit[] {
  const out: RenderUnit[] = [];
  for (const ev of events) {
    if (ev.kind === "hook") {
      const last = out[out.length - 1];
      if (last && last.type === "hookRun" && hookKey(last.first) === hookKey(ev)) {
        last.count += 1;
        last.lastTs = ev.timestamp;
        continue;
      }
      out.push({ type: "hookRun", first: ev, count: 1, lastTs: ev.timestamp });
    } else {
      out.push({ type: "event", ev });
    }
  }
  return out;
}

const SUMMARY_CSS = `
  :root{
    /* Murmur dark palette: zinc-based neutrals + emerald user accent. */
    --bg:#09090b; --card:#18181b; --card-2:#1f1f23;
    --ink:#fafafa; --ink-soft:#e4e4e7; --mute:#a1a1aa; --soft:#71717a;
    --rule:rgba(255,255,255,0.08); --rule-strong:rgba(255,255,255,0.14);
    --user:#10b981; --user-soft:#34d399;
    --brand-grad:linear-gradient(135deg,#3b82f6 0%,#6366f1 50%,#8b5cf6 100%);
  }
  *{box-sizing:border-box}
  ::selection{background:rgba(99,102,241,0.35);color:#fff}
  body{font-family:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:56rem;margin:3rem auto;padding:0 1.5rem;line-height:1.65;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}

  header.title{text-align:center;margin-bottom:2.5rem}
  header.title h1{font-size:2.25rem;letter-spacing:-.02em;margin:0 0 .5rem;color:var(--ink);font-weight:600}
  header.title .tagline{color:var(--mute);font-style:italic;margin:0;font-size:1rem}
  header.title hr{width:4rem;border:0;border-top:2px solid var(--rule-strong);margin:1.5rem auto 0}
  .topmeta{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap;font-size:.825rem;color:var(--mute);margin-top:.75rem}
  .topmeta code{background:var(--card);padding:.1em .4em;border-radius:.25em;color:var(--ink-soft);border:1px solid var(--rule);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}

  .round{margin:3rem 0;padding-top:2rem;border-top:1px solid var(--rule)}
  .round:first-of-type{border-top:none;padding-top:0;margin-top:1.5rem}
  .round-heading{display:flex;align-items:center;gap:.95rem;margin-bottom:1rem}
  .round-num{display:inline-flex;align-items:center;justify-content:center;min-width:2.5rem;height:2.5rem;padding:0 .6rem;background:var(--brand-grad);color:#fff;border-radius:999px;font-weight:700;font-size:.95rem;letter-spacing:.05em;font-variant-numeric:tabular-nums;flex-shrink:0;box-shadow:0 2px 8px rgba(99,102,241,.25)}
  .round-meta{display:flex;flex-direction:column;min-width:0}
  .round-title{margin:0;font-size:1.35rem;letter-spacing:-.01em;font-weight:600;color:var(--ink);line-height:1.2}
  .round-time{font-size:.78rem;color:var(--soft);font-style:italic;margin-top:.15rem;font-variant-numeric:tabular-nums}
  .round-narrative{font-size:1rem;color:var(--mute);margin:.25rem 0 1rem;font-style:italic;line-height:1.55;padding-left:3.45rem}

  /* User message: tinted emerald card with a heavy accent, reads as the human's voice. */
  .card{border-radius:.6rem;padding:1.25rem 1.4rem 1.1rem;margin-bottom:1rem}
  .card.user{background:linear-gradient(180deg,rgba(16,185,129,0.10) 0%,rgba(16,185,129,0.05) 100%);border:1px solid rgba(16,185,129,0.22);border-left:5px solid var(--user);box-shadow:0 1px 8px rgba(16,185,129,.06)}
  .card.user p{color:var(--ink-soft);font-size:1rem;line-height:1.6}
  .card.user .meta{color:var(--user-soft);opacity:.75}
  .badge{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:.18rem .6rem;border-radius:.3rem;margin-bottom:.7rem}
  .badge.user{background:var(--user);color:#022c22}
  .card p{margin:.35rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
  .meta{font-size:.78rem;color:var(--soft);font-style:italic;margin-top:.6rem}

  /* Agent thread: left-rail wrapper around Claude's actions for this round. */
  .agent-thread{position:relative;margin:.4rem 0 0 1.2rem;padding:.2rem 0 .2rem 1.4rem;border-left:2px solid var(--rule-strong)}
  .agent-thread-label{display:inline-flex;align-items:center;gap:.45rem;font-size:.66rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:0 0 .65rem -1.95rem;padding:.22rem .6rem;background:var(--card);border:1px solid var(--rule);border-radius:.3rem;width:max-content}
  .agent-thread-label::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.5)}

  .events{display:flex;flex-direction:column;gap:.32rem}
  .event{background:var(--card);border-radius:.45rem;border:1px solid var(--rule);border-left:3px solid var(--rule);overflow:hidden;transition:background .12s,border-color .12s}
  .event > summary{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem .6rem .65rem;cursor:pointer;list-style:none;font-size:.92rem;line-height:1.35;user-select:none;color:var(--ink)}
  .event > summary::-webkit-details-marker{display:none}
  /* CSS-drawn chevron — crisp at any zoom. */
  .event > summary::before{content:"";display:inline-block;width:0;height:0;border-left:6px solid var(--soft);border-top:5px solid transparent;border-bottom:5px solid transparent;flex-shrink:0;transition:transform .15s ease,border-left-color .12s;transform-origin:30% 50%;margin-right:.1rem}
  .event[open] > summary::before{transform:rotate(90deg);border-left-color:var(--ink-soft)}
  .event:hover{background:var(--card-2);border-color:var(--rule-strong)}
  .event:hover > summary::before{border-left-color:var(--ink-soft)}
  .event[open]{background:var(--card-2)}

  .event-verb{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:.14rem .48rem;border-radius:.25rem;flex-shrink:0;line-height:1.3}
  .event-icon{display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;border-radius:.35rem;flex-shrink:0;border:1px solid;line-height:0}
  .event-icon svg{width:.85rem;height:.85rem}
  .event-headline{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-soft)}
  .event-time{color:var(--soft);font-size:.72rem;font-variant-numeric:tabular-nums;flex-shrink:0}
  .event-dur{color:var(--mute);font-size:.7rem;font-variant-numeric:tabular-nums;flex-shrink:0;padding:.08rem .4rem;background:rgba(255,255,255,.05);border:1px solid var(--rule);border-radius:.25rem}
  .event-err{display:inline-block;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:rgba(244,63,94,0.18);color:#fda4af;border:1px solid rgba(244,63,94,0.30);padding:.1rem .4rem;border-radius:.25rem;flex-shrink:0}
  .event-response{display:inline-block;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:.14rem .5rem;border-radius:.25rem;flex-shrink:0;border:1px solid transparent}
  .event-response-allow{background:rgba(34,197,94,0.16);color:#86efac;border-color:rgba(34,197,94,0.32)}
  .event-response-deny{background:rgba(244,63,94,0.18);color:#fda4af;border-color:rgba(244,63,94,0.32)}

  .event-body{padding:.5rem .9rem .9rem 1.7rem;font-size:.82rem;color:var(--mute);border-top:1px solid var(--rule)}
  .event-fields{display:grid;grid-template-columns:max-content 1fr;gap:.25rem .9rem;margin:.55rem 0;align-items:baseline}
  .event-fields dt{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--soft);font-weight:600}
  .event-fields dd{margin:0;color:var(--ink-soft);font-size:.82rem;word-break:break-word;overflow-wrap:anywhere}
  .event-pre{background:var(--bg);color:var(--ink-soft);padding:.65rem .8rem;border-radius:.35rem;margin:.45rem 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;line-height:1.55;overflow-x:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--rule)}
  .event-imgs{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.55rem}
  .event-img{max-width:280px;max-height:200px;border-radius:.4rem;border:1px solid var(--rule);object-fit:contain;background:var(--bg)}
  .event-answer{margin-top:.6rem}
  .event-answer > span{display:block;font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--soft);font-weight:600;margin-bottom:.2rem}
  .events-meta{font-size:.74rem;color:var(--soft);font-style:italic;margin:.65rem 0 0;font-variant-numeric:tabular-nums}
  .event-hooks{border-left-color:var(--rule-strong);opacity:.78}
  .event-hooks .event-headline{color:var(--mute)}

  .phases{margin:2rem 0 1.5rem;padding:1.6rem 1.8rem;background:var(--card);border:1px solid var(--rule);border-radius:.75rem;box-shadow:0 1px 8px rgba(0,0,0,.18)}
  .phases-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:1.1rem}
  .phases-head h2{margin:0;font-size:1.1rem;font-weight:600;color:var(--ink);letter-spacing:-.01em}
  .phases-head .meta{font-size:.78rem;color:var(--soft);font-variant-numeric:tabular-nums;font-style:italic}
  .phase-list{display:flex;flex-direction:column;gap:.35rem}
  .phase{background:var(--card-2);border:1px solid var(--rule);border-radius:.5rem;overflow:hidden;transition:background .12s,border-color .12s}
  .phase > summary{display:flex;align-items:center;gap:.7rem;padding:.7rem .95rem;cursor:pointer;list-style:none;font-size:.92rem;user-select:none}
  .phase > summary::-webkit-details-marker{display:none}
  .phase > summary::before{content:"";display:inline-block;width:0;height:0;border-left:6px solid var(--soft);border-top:5px solid transparent;border-bottom:5px solid transparent;flex-shrink:0;transition:transform .15s ease,border-left-color .12s}
  .phase[open] > summary::before{transform:rotate(90deg);border-left-color:var(--ink-soft)}
  .phase.empty > summary{cursor:default}
  .phase.empty > summary::before{visibility:hidden}
  .phase:hover:not(.empty){border-color:var(--rule-strong)}
  .phase-status-icon{display:inline-flex;align-items:center;justify-content:center;width:1.25rem;height:1.25rem;flex-shrink:0}
  .phase-status-icon svg{width:1.05rem;height:1.05rem}
  .phase-status-icon.completed{color:#34d399}
  .phase-status-icon.in_progress{color:#60a5fa}
  .phase-status-icon.failed{color:#fb7185}
  .phase-status-icon.pending{color:var(--soft)}
  .phase-label{flex:1;min-width:0;color:var(--ink-soft);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .phase-count{color:var(--soft);font-size:.72rem;font-variant-numeric:tabular-nums;flex-shrink:0}
  .phase-dur{color:var(--mute);font-size:.72rem;font-variant-numeric:tabular-nums;flex-shrink:0;padding:.08rem .45rem;background:rgba(255,255,255,.04);border:1px solid var(--rule);border-radius:.25rem}
  .phase-pill{display:inline-block;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:.18rem .55rem;border-radius:.25rem;flex-shrink:0;border:1px solid}
  .phase-pill.completed{background:rgba(16,185,129,0.16);color:#86efac;border-color:rgba(16,185,129,0.32)}
  .phase-pill.in_progress{background:rgba(59,130,246,0.16);color:#93c5fd;border-color:rgba(59,130,246,0.32)}
  .phase-pill.failed{background:rgba(244,63,94,0.18);color:#fda4af;border-color:rgba(244,63,94,0.32)}
  .phase-pill.pending{background:rgba(161,161,170,0.18);color:#d4d4d8;border-color:rgba(161,161,170,0.30)}
  .phase-body{padding:.65rem .95rem .95rem 2rem;border-top:1px solid var(--rule);background:var(--bg)}
  .phase-detail{font-size:.82rem;color:var(--mute);font-style:italic;margin:0 0 .55rem}

  .closing{background:linear-gradient(135deg,rgba(16,185,129,0.10) 0%,rgba(245,158,11,0.08) 50%,rgba(59,130,246,0.12) 100%);padding:2rem 2.25rem;border-radius:.75rem;margin:3rem 0 2rem;border:1px solid var(--rule);box-shadow:0 4px 16px rgba(0,0,0,.25)}
  .closing h2{margin:0 0 .8rem;font-size:1.4rem;color:var(--ink);font-weight:600}
  .closing dt{font-weight:700;margin-top:.9rem;color:var(--ink);font-size:.95rem}
  .closing dt:first-of-type{margin-top:.25rem}
  .closing dd{margin:.25rem 0 0;color:var(--ink-soft);font-size:.95rem}
  .closing ul.bare{list-style:none;padding:0;margin:.35rem 0;display:flex;flex-wrap:wrap;gap:.35rem .9rem}
  .closing ul.bare li{font-size:.875rem;color:var(--ink-soft)}
  .closing code{background:rgba(0,0,0,.35);padding:.12em .4em;border-radius:.2em;font-size:.875rem;color:var(--ink-soft);border:1px solid var(--rule)}
  .closing .count{display:inline-block;background:rgba(255,255,255,.10);border-radius:.25rem;padding:0 .4em;font-size:.72rem;font-weight:600;color:var(--ink-soft);margin-left:.15rem}
  .closing .dim{color:var(--mute);font-size:.78rem}

  table.stats{width:100%;border-collapse:collapse;margin:1rem 0;background:var(--card);border-radius:.5rem;border:1px solid var(--rule);overflow:hidden}
  table.stats td{text-align:left;padding:.6rem 1rem;border-bottom:1px solid var(--rule);color:var(--ink-soft)}
  table.stats td:first-child{color:var(--mute);font-size:.875rem}
  table.stats td:last-child{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)}
  table.stats tr:last-child td{border-bottom:none}
  footer{text-align:center;color:var(--soft);font-size:.825rem;margin-top:2.5rem;font-style:italic}
  @media print{body{background:#fff;margin:0;padding:1.5rem}.card,table.stats,.closing{box-shadow:none;border:1px solid var(--rule)}}
`;

const safe = escapeHtml;

function fmtClock(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch {
    return iso;
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

// Human-readable elapsed span from two ISO timestamps. Note the deliberate
// Math.round on seconds (the rest of the dashboard's formatLongDuration uses
// Math.floor): the summary's displayed seconds must stay as-is, so this stays
// a local formatter rather than reusing format.ts.
function fmtSpan(fromIso: string, toIso: string): string {
  const ms = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr > 0 ? `${h}h ${mr}m` : `${h}h`;
}

function statusIconSvg(status: RowStatus): string {
  if (status === "completed") {
    return iconSvg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>');
  }
  if (status === "in_progress") {
    return iconSvg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>');
  }
  if (status === "failed") {
    return iconSvg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>');
  }
  return iconSvg('<circle cx="12" cy="12" r="10"/>');
}

function statusPillLabel(status: RowStatus): string {
  if (status === "in_progress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function activitiesForRow(row: Row, activities: Activity[], nowMs: number): Activity[] {
  if (!row.startedAt) return [];
  const start = new Date(row.startedAt).getTime();
  const end = row.endedAt ? new Date(row.endedAt).getTime() : nowMs;
  return activities.filter((a) => {
    if (a.kind === "hook") return false;
    const t = new Date(a.timestamp).getTime();
    return t >= start && t <= end;
  });
}

// Per-kind activity tallies. A single pass replaces the repeated full-list
// filters the stats table and round meta used to run.
interface ActivityCounts {
  tool: number;
  agent: number;
  hook: number;
  prompt: number;
  promptUser: number;
  promptAsk: number;
}

function countActivities(activities: Activity[]): ActivityCounts {
  const counts: ActivityCounts = { tool: 0, agent: 0, hook: 0, prompt: 0, promptUser: 0, promptAsk: 0 };
  for (const a of activities) {
    if (a.kind === "tool") counts.tool += 1;
    else if (a.kind === "agent") counts.agent += 1;
    else if (a.kind === "hook") counts.hook += 1;
    else if (a.kind === "prompt") {
      counts.prompt += 1;
      if (a.source === "user") counts.promptUser += 1;
      else counts.promptAsk += 1;
    }
  }
  return counts;
}

// Render one event as an expandable <details> row. The <summary> carries the
// semantic headline (what the agent was trying to do); the body has the raw
// command/target/metadata for reference.
function renderEvent(ev: Activity, hookRunCount = 1): string {
  const intent = eventIntent(ev);
  const palette = verbPalette(intent.verb);
  const time = safe(fmtClock(ev.timestamp));
  const fields: [string, string][] = [];
  let bodyTail = "";

  if (ev.kind === "tool") {
    fields.push(["Tool", ev.tool]);
    if (ev.target) fields.push(["Target", ev.target]);
    if (ev.detail && ev.detail !== ev.target) fields.push(["Detail", ev.detail]);
    if (ev.durationMs != null) fields.push(["Duration", `${ev.durationMs}ms`]);
    fields.push(["Status", ev.ok ? "ok" : "errored"]);
    if (ev.runInBackground) fields.push(["Mode", "run_in_background"]);
    if (ev.tool === "Bash" && ev.target) {
      bodyTail = `<pre class="event-pre">${safe(ev.target)}</pre>`;
    }
  } else if (ev.kind === "agent") {
    if (ev.subagentType) fields.push(["Subagent", ev.subagentType]);
    fields.push(["Brief", ev.description]);
    if (ev.durationMs != null) fields.push(["Duration", `${(ev.durationMs / 1000).toFixed(1)}s`]);
    if (ev.ok != null) fields.push(["Status", ev.ok ? "ok" : "errored"]);
  } else if (ev.kind === "prompt") {
    const sourceLabel = ev.source === "user" ? "You" : ev.source === "permission" ? "Permission" : ev.source === "murmur" ? "Murmur" : "Question";
    fields.push(["From", sourceLabel]);
    bodyTail = `<pre class="event-pre">${safe(ev.question)}</pre>`;
    if (ev.answer) bodyTail += `<div class="event-answer"><span>Answer</span><pre class="event-pre">${safe(ev.answer)}</pre></div>`;
    bodyTail += renderEventImages(ev.images);
    if (ev.ok === false) fields.push(["Status", "denied"]);
  } else if (ev.kind === "hook") {
    fields.push(["Hook", ev.hook]);
    if (ev.event) fields.push(["Event", ev.event]);
    if (ev.detail) fields.push(["Detail", ev.detail]);
    if (hookRunCount > 1) fields.push(["Firings", String(hookRunCount)]);
    if (ev.ok != null) fields.push(["Status", ev.ok ? "ok" : "errored"]);
  } else if (ev.kind === "log") {
    bodyTail = `<pre class="event-pre">${safe(ev.message)}</pre>`;
  } else if (ev.kind === "warn") {
    bodyTail = `<pre class="event-pre">${safe(ev.message)}</pre>`;
  }

  const fieldsHtml = fields.length > 0
    ? `<dl class="event-fields">${fields.map(([k, v]) => `<dt>${safe(k)}</dt><dd>${safe(v)}</dd>`).join("")}</dl>`
    : "";

  const errBadge =
    (ev.kind === "tool" && !ev.ok) || (ev.kind === "prompt" && ev.ok === false)
      ? `<span class="event-err">err</span>`
      : "";
  const durBadge =
    (ev.kind === "tool" || ev.kind === "agent") && ev.durationMs != null
      ? `<span class="event-dur">${ev.durationMs < 1000 ? `${ev.durationMs}ms` : `${(ev.durationMs / 1000).toFixed(1)}s`}</span>`
      : "";
  const countBadge =
    ev.kind === "hook" && hookRunCount > 1
      ? `<span class="event-dur">&times;${hookRunCount}</span>`
      : "";
  // Permission rows surface how the human responded as a trailing badge
  // (Approved / Always allowed / Denied) so the row reads "what was asked"
  // first, "how it was answered" second.
  let responseBadge = "";
  if (ev.kind === "prompt" && ev.source === "permission" && ev.answer) {
    const responseLabel =
      ev.answer === "allow" ? "Approved" :
      ev.answer === "always" ? "Always allowed" :
      ev.answer === "deny" ? "Denied" :
      ev.answer;
    const responseTone = ev.answer === "deny" ? "deny" : "allow";
    responseBadge = `<span class="event-response event-response-${responseTone}">${safe(responseLabel)}</span>`;
  }

  return `<details class="event" style="border-left-color:${palette.accent}">
      <summary>
        <span class="event-icon" title="${safe(intent.verb)}" style="background:${palette.bg};color:${palette.ink};border-color:${palette.bg}">${verbIconSvg(intent.verb)}</span>
        <span class="event-headline">${safe(intent.headline)}</span>
        ${errBadge}
        ${responseBadge}
        ${countBadge}
        ${durBadge}
        <span class="event-time">${time}</span>
      </summary>
      <div class="event-body">
        ${fieldsHtml}
        ${bodyTail}
      </div>
    </details>`;
}

// Render the chronological round-by-round recap of the session.
function renderRounds(rounds: SummaryRound[]): string {
  return rounds
    .map((r) => {
      const promptHtml = r.userPrompt
        ? `<article class="card user">
            <span class="badge user">You</span>
            <p>${safe(r.userPrompt.question).slice(0, 1200)}</p>
            <p class="meta">${safe(fmtClock(r.userPrompt.timestamp))}${r.userPrompt.answer ? ` &middot; answered` : ""}</p>
          </article>`
        : "";

      // One <details> row per event in chronological order — hooks render
      // inline alongside tool/agent/prompt rows rather than being collapsed
      // into a trailing block. Consecutive firings of the SAME hook collapse
      // into one row carrying a "×N" badge, keeping the chronological place
      // while preventing high-volume hooks from drowning the recap.
      const eventsHtml = groupConsecutiveHooks(r.events)
        .map((unit) =>
          unit.type === "event"
            ? renderEvent(unit.ev)
            : renderEvent(unit.first, unit.count)
        )
        .filter((s) => s.length > 0)
        .join("");

      const counts = countActivities(r.events);
      const metaParts: string[] = [];
      if (counts.tool > 0) metaParts.push(`${counts.tool} tool${counts.tool === 1 ? "" : "s"}`);
      if (counts.agent > 0) metaParts.push(`${counts.agent} subagent${counts.agent === 1 ? "" : "s"}`);
      if (counts.prompt > 0) metaParts.push(`${counts.prompt} question${counts.prompt === 1 ? "" : "s"}`);
      if (counts.hook > 0) metaParts.push(`${counts.hook} hook${counts.hook === 1 ? "" : "s"}`);
      metaParts.push(`${safe(fmtSpan(r.startedAt, r.endedAt))} elapsed`);

      const eventsBlock = eventsHtml
        ? `<div class="agent-thread">
            <div class="agent-thread-label">Claude</div>
            <div class="events">${eventsHtml}</div>
            <p class="events-meta">${metaParts.join(" &middot; ")}</p>
          </div>`
        : "";

      const narrative = roundNarrative(r);
      const narrativeHtml = narrative ? `<p class="round-narrative">${safe(narrative)}</p>` : "";

      const numLabel = r.label === "Setup" ? "..." : String(r.index).padStart(2, "0");
      const timeBits: string[] = [];
      if (r.userPrompt) timeBits.push(safe(fmtClock(r.startedAt)));
      if (r.events.length > 0 || r.userPrompt) timeBits.push(safe(fmtSpan(r.startedAt, r.endedAt)));
      const headingHtml = `<header class="round-heading">
        <span class="round-num">${safe(numLabel)}</span>
        <div class="round-meta">
          <h2 class="round-title">${safe(r.label)}</h2>
          ${timeBits.length > 0 ? `<span class="round-time">${timeBits.join(" &middot; ")}</span>` : ""}
        </div>
      </header>`;

      return `<section class="round">
        ${headingHtml}
        ${narrativeHtml}
        ${promptHtml}
        ${eventsBlock}
      </section>`;
    })
    .join("");
}

// Render the progress/phases section from the task rows.
function renderPhases(rows: Row[], activities: Activity[], nowMs: number): string {
  if (rows.length === 0) return "";

  const items = rows
    .map((row) => {
      const acts = activitiesForRow(row, activities, nowMs);
      const dur = (() => {
        if (!row.startedAt) return null;
        const start = new Date(row.startedAt).getTime();
        const end = row.endedAt ? new Date(row.endedAt).getTime() : nowMs;
        return fmtSpan(new Date(start).toISOString(), new Date(end).toISOString());
      })();
      const empty = acts.length === 0;
      const eventsHtml = acts.map((a) => renderEvent(a)).join("");
      const detailLine = row.detail
        ? `<p class="phase-detail">${safe(row.detail)}</p>`
        : "";
      const countLabel = empty
        ? ""
        : `<span class="phase-count">${acts.length} action${acts.length === 1 ? "" : "s"}</span>`;
      const durLabel = dur ? `<span class="phase-dur">${safe(dur)}</span>` : "";
      const bodyHtml = empty
        ? ""
        : `<div class="phase-body">${detailLine}<div class="events">${eventsHtml}</div></div>`;
      return `<details class="phase${empty ? " empty" : ""}"${row.status === "in_progress" && !empty ? " open" : ""}>
              <summary>
                <span class="phase-status-icon ${row.status}">${statusIconSvg(row.status)}</span>
                <span class="phase-label">${safe(row.label)}</span>
                ${countLabel}
                ${durLabel}
                <span class="phase-pill ${row.status}">${safe(statusPillLabel(row.status))}</span>
              </summary>
              ${bodyHtml}
            </details>`;
    })
    .join("");

  const completedCount = rows.filter((r) => r.status === "completed").length;
  const inProgressCount = rows.filter((r) => r.status === "in_progress").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;
  const pctDone = Math.round(((completedCount + failedCount) / rows.length) * 100);
  const metaBits: string[] = [
    `${completedCount}/${rows.length} done`,
    `${pctDone}%`,
  ];
  if (inProgressCount > 0) metaBits.push(`${inProgressCount} active`);
  if (failedCount > 0) metaBits.push(`${failedCount} failed`);

  return `<section class="phases">
          <div class="phases-head">
            <h2>Progress</h2>
            <span class="meta">${metaBits.join(" &middot; ")}</span>
          </div>
          <div class="phase-list">${items}</div>
        </section>`;
}

export function buildSummaryHtml({ state, sessions, resolveImage }: ShareContext): string {
  if (!state) {
    return `<!doctype html><html><body style="font-family:Inter,system-ui;padding:3rem;color:#475569;background:#fafafa">No session data yet. Open Murmur after Claude has produced some activity, then try again.</body></html>`;
  }
  imageResolver = resolveImage ?? null;
  const fmtNum = formatCount;

  const si = state.sessionInfo;
  const ts = state.tokenStats;
  const cur = sessions.find((s) => s.current);
  const sessionTitle = cur?.title?.trim() || `Claude session ${state.sessionId.slice(0, 8)}`;

  const rounds = groupActivitiesIntoRounds(state.activities);
  const roundsHtml = renderRounds(rounds);

  const nowMs = Date.now();
  const phasesHtml = renderPhases(state.rows, state.activities, nowMs);

  const fileEdits = new Map<string, number>();
  state.activities.forEach((a) => {
    if (a.kind === "tool" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(a.tool) && a.target) {
      fileEdits.set(a.target, (fileEdits.get(a.target) ?? 0) + 1);
    }
  });
  const filesList = Array.from(fileEdits.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([p, n]) => `<li><code>${safe(p.replace(/^.*\//, ""))}</code>${n > 1 ? ` <span class="count">${n}</span>` : ""}</li>`)
    .join("");
  const memoriesAdded = state.memoryEntries
    .filter((m) => m.thisSession)
    .map((m) => `<li><code>${safe(m.name)}</code>${m.type ? ` <span class="dim">(${safe(m.type)})</span>` : ""}</li>`)
    .join("");
  const completedRows = state.rows.filter((r) => r.status === "completed").length;
  const failedRows = state.rows.filter((r) => r.status === "failed").length;
  const openRows = state.rows.filter((r) => r.status === "pending" || r.status === "in_progress");
  const openRowsHtml = openRows
    .slice(0, 6)
    .map((r) => `<li>${safe(r.label)}${r.detail ? ` <span class="dim">${safe(r.detail)}</span>` : ""}</li>`)
    .join("");

  const closingHtml = `<section class="closing">
    <h2>Where we landed</h2>
    <dl>
      <dt>How it ended</dt>
      <dd>
        ${completedRows}/${state.rows.length} task${state.rows.length === 1 ? "" : "s"} completed${failedRows > 0 ? `, <strong>${failedRows} failed</strong>` : ""}.
        ${state.pendingQuestion ? `One pending question awaiting reply. ` : ""}
        ${state.pendingPermission ? `One pending permission. ` : ""}
      </dd>
      ${filesList ? `<dt>Files touched</dt><dd><ul class="bare">${filesList}</ul></dd>` : ""}
      ${memoriesAdded ? `<dt>Memory added this session</dt><dd><ul class="bare">${memoriesAdded}</ul></dd>` : ""}
      ${openRowsHtml ? `<dt>Still open</dt><dd><ul class="bare">${openRowsHtml}</ul></dd>` : ""}
    </dl>
  </section>`;

  const totals = countActivities(state.activities);
  const statsRows: [string, string][] = [
    ["Rounds", String(Math.max(rounds.length - (rounds[0]?.label === "Setup" ? 1 : 0), 0))],
    ["Your prompts", String(totals.promptUser)],
    ["Tools called", fmtNum(totals.tool)],
    ["Subagents dispatched", String(totals.agent)],
    ["Questions / permissions", String(totals.promptAsk)],
    ["Hooks fired", fmtNum(totals.hook)],
    ["Files touched", String(fileEdits.size)],
    ["Memory entries this session", String(state.memoryEntries.filter((m) => m.thisSession).length)],
  ];
  if (ts) {
    statsRows.push(["Tokens used", `${fmtNum(ts.totalTokens)} in / ${fmtNum(ts.outputTokens)} out`]);
    statsRows.push(["Context window", `${fmtNum(ts.lastContextTokens)} / ${fmtNum(ts.contextLimit)}`]);
  }
  statsRows.push(["Session elapsed", fmtSpan(state.startedAt, new Date().toISOString())]);
  const statsHtml = statsRows
    .map(([k, v]) => `<tr><td>${safe(k)}</td><td>${safe(v)}</td></tr>`)
    .join("");

  const subtitle = [si.cwdBasename, si.branch]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map(safe)
    .join(" &middot; ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safe(sessionTitle)} &middot; Murmur summary</title>
<style>${SUMMARY_CSS}</style>
</head>
<body>
  <header class="title">
    <h1>${safe(sessionTitle)}</h1>
    <p class="tagline">A chronological recap of this Claude Code session.</p>
    <hr />
    <div class="topmeta">
      ${subtitle ? `<span>${subtitle}</span>` : ""}
      <span>started ${safe(fmtDate(state.startedAt))}</span>
      ${si.model ? `<span><code>${safe(si.model)}</code>${si.effort ? ` effort ${safe(si.effort)}` : ""}</span>` : ""}
    </div>
  </header>

  ${phasesHtml}

  ${roundsHtml || `<p class="meta" style="text-align:center">No activity recorded yet.</p>`}

  ${closingHtml}

  <table class="stats">
    <tbody>${statsHtml}</tbody>
  </table>

  <footer>Generated by Murmur at ${safe(new Date().toLocaleString())}.</footer>
</body>
</html>`;
}
