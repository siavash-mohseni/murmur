import type { Activity } from "./shared-types.js";
import {
  bashIntent,
  basename,
  firstQuoted,
  hostnameOf,
  mcpIntent,
  permissionIntent,
  toPresent,
  type EventIntent,
} from "./intent.js";

// Re-export the shared pure-function helpers so existing call sites
// (summary-html, future surfaces) keep working unchanged.
export { bashIntent, mcpIntent, permissionIntent, toPresent };
export type { EventIntent };

/** Verb palette tuned for the dark Murmur theme: translucent tinted background
 *  over zinc-950, 300-level ink, fully-saturated accent for the left border.
 *  Matches the dashboard's `bg-X-500/15` + `text-X-300` + `ring-X-500/30` style.
 *  Defined here rather than in `src/intent.ts` so the intent module carries no
 *  color table. Since Phase 3 this whole module lives server-side so the HTML
 *  builders (src/export/) render identically from the server, the CLI, and the
 *  browser, but it must stay browser-safe: no node:* imports, no side effects.
 *  Values verbatim from the original src/intent.ts verbPalette. */
export function verbPalette(verb: EventIntent["verb"]): { bg: string; ink: string; accent: string } {
  switch (verb) {
    case "read":       return { bg: "rgba(34,211,238,0.14)",  ink: "#67e8f9", accent: "#06b6d4" }; // cyan
    case "write":      return { bg: "rgba(251,191,36,0.14)",  ink: "#fcd34d", accent: "#f59e0b" }; // amber
    case "search":     return { bg: "rgba(129,140,248,0.16)", ink: "#a5b4fc", accent: "#6366f1" }; // indigo
    case "exec":       return { bg: "rgba(52,211,153,0.14)",  ink: "#6ee7b7", accent: "#10b981" }; // emerald
    case "build":      return { bg: "rgba(244,114,182,0.16)", ink: "#f9a8d4", accent: "#ec4899" }; // pink
    case "test":       return { bg: "rgba(250,204,21,0.14)",  ink: "#fde047", accent: "#eab308" }; // yellow
    case "git":        return { bg: "rgba(251,146,60,0.16)",  ink: "#fdba74", accent: "#f97316" }; // orange
    case "web":        return { bg: "rgba(56,189,248,0.16)",  ink: "#7dd3fc", accent: "#0ea5e9" }; // sky
    case "agent":      return { bg: "rgba(168,85,247,0.16)",  ink: "#d8b4fe", accent: "#a855f7" }; // violet
    case "plan":       return { bg: "rgba(167,139,250,0.16)", ink: "#c4b5fd", accent: "#8b5cf6" }; // purple
    case "task":       return { bg: "rgba(129,140,248,0.14)", ink: "#a5b4fc", accent: "#6366f1" }; // indigo
    case "permission": return { bg: "rgba(244,63,94,0.16)",   ink: "#fda4af", accent: "#f43f5e" }; // rose
    case "question":   return { bg: "rgba(59,130,246,0.16)",  ink: "#93c5fd", accent: "#3b82f6" }; // blue
    case "murmur-ask": return { bg: "rgba(217,70,239,0.16)",  ink: "#f0abfc", accent: "#d946ef" }; // fuchsia
    case "hook":       return { bg: "rgba(34,211,238,0.14)",  ink: "#67e8f9", accent: "#06b6d4" }; // cyan, matches live panel
    case "log":        return { bg: "rgba(113,113,122,0.20)", ink: "#d4d4d8", accent: "#71717a" }; // zinc
    case "warn":       return { bg: "rgba(245,158,11,0.18)",  ink: "#fcd34d", accent: "#f59e0b" }; // amber
    case "shell":      return { bg: "rgba(148,163,184,0.18)", ink: "#cbd5e1", accent: "#94a3b8" }; // slate
  }
}

// ---- Shared HTML-render helpers used by both HTML builders ----
// summary-html.ts and export-html.ts both render standalone HTML documents
// and previously each defined its own copy of these. Hosting them here (the
// module both builders already pull intent helpers from) keeps a single
// definition without touching the dependency-free format.ts.

/** Escape the five HTML-sensitive characters for safe interpolation. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>'"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

/** Plain locale-grouped integer (e.g. 12,345). Distinct from format.ts
 *  formatTokens, which abbreviates to K/M for the live dashboard. */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** Wrap inline lucide-style SVG paths in the shared icon attributes. The
 *  HTML documents open standalone, so we ship the SVG markup instead of
 *  importing lucide-react. */
export function iconSvg(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** Clip a string to `max` characters, appending an ellipsis when it overflows.
 *  Mirrors the hand-rolled `len > max ? slice(0, max - 3) + "..." : s` idiom
 *  used across the headline builders (the ellipsis counts toward `max`). */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/** Map any Activity to an EventIntent. */
export function eventIntent(a: Activity): EventIntent {
  if (a.kind === "tool") return toolIntent(a);
  if (a.kind === "agent") {
    const who = a.subagentType ? `the ${a.subagentType} subagent` : "a subagent";
    return { headline: `Dispatched ${who}`, verb: "agent" };
  }
  if (a.kind === "prompt") {
    if (a.source === "user") return { headline: "You sent a message", verb: "question" };
    if (a.source === "assistant") {
      // The reply's first paragraph lives in `question` and is surfaced as the
      // secondary line (see secondaryFor in atoms.tsx), so the headline stays a
      // short label. Echoing the message here too would just duplicate the
      // secondary line in the row.
      return { headline: "Claude said", verb: "agent" };
    }
    if (a.source === "permission") {
      // Question format from Murmur is "<Tool> · <command>". Split it and route
      // through the shared permissionIntent so every tool reads as its
      // present-tense intent ("Read App.tsx", "Search for X", "Run git status"),
      // not just Bash. A missing target ("null"/"undefined"/empty) collapses to
      // the tool's generic phrasing ("Read a file"), never "Read null".
      const sep = a.question.indexOf("·");
      const tool = sep >= 0 ? a.question.slice(0, sep).trim() : a.question.trim();
      const command = sep >= 0 ? a.question.slice(sep + 1).trim() : "";
      return { headline: permissionIntent(tool, command).headline, verb: "permission" };
    }
    if (a.source === "ask") {
      const short = truncate(a.question, 60);
      return {
        headline: a.answer ? `Asked you: "${short}" → ${a.answer.slice(0, 24)}` : `Asked you: "${short}"`,
        verb: "question",
      };
    }
    if (a.source === "murmur") {
      const short = truncate(a.question, 60);
      return {
        headline: a.answer ? `Murmur asked: "${short}" → ${a.answer.slice(0, 24)}` : `Murmur asked: "${short}"`,
        verb: "murmur-ask",
      };
    }
  }
  if (a.kind === "hook") return hookIntent(a);
  if (a.kind === "log") {
    return { headline: truncate(a.message, 80), verb: "log" };
  }
  if (a.kind === "warn") {
    return { headline: truncate(a.message, 80), verb: "warn" };
  }
  return { headline: a.kind, verb: "log" };
}

function toolIntent(a: Extract<Activity, { kind: "tool" }>): EventIntent {
  const t = a.tool;
  const target = a.target ?? "";
  const file = basename(target);

  if (t === "Read") return { headline: file ? `Read ${file}` : "Read a file", verb: "read" };
  if (t === "Glob") return { headline: target ? `Globbed ${target}` : "Globbed files", verb: "search" };
  if (t === "NotebookRead") return { headline: file ? `Read notebook ${file}` : "Read a notebook", verb: "read" };
  if (t === "Write") return { headline: file ? `Created ${file}` : "Created a file", verb: "write" };
  if (t === "Edit") return { headline: file ? `Edited ${file}` : "Edited a file", verb: "write" };
  if (t === "MultiEdit") return { headline: file ? `Edited ${file} (multiple ranges)` : "Multi-edited a file", verb: "write" };
  if (t === "NotebookEdit") return { headline: file ? `Edited notebook ${file}` : "Edited a notebook", verb: "write" };
  if (t === "Grep") {
    const q = firstQuoted(target) ?? target.slice(0, 40);
    return { headline: q ? `Searched code for "${q}"` : "Searched the codebase", verb: "search" };
  }
  if (t === "Bash") return bashIntent(target);

  if (t === "WebFetch") {
    const url = target.match(/https?:\/\/\S+/)?.[0];
    return { headline: url ? `Fetched ${hostnameOf(url)}` : "Fetched the web", verb: "web" };
  }
  if (t === "WebSearch") {
    return { headline: target ? `Searched the web for ${target.slice(0, 40)}` : "Searched the web", verb: "web" };
  }

  if (t === "Task" || t === "Agent" || /agent/i.test(t)) {
    return { headline: target ? `Dispatched ${target.slice(0, 40)}` : "Dispatched a subagent", verb: "agent" };
  }
  if (/^TaskCreate$/.test(t)) return { headline: target ? `Created task "${target.slice(0, 40)}"` : "Created a task row", verb: "task" };
  if (/^TaskUpdate$/.test(t)) return { headline: target ? `Updated task: ${target.slice(0, 40)}` : "Updated a task row", verb: "task" };
  if (/^TaskList$/.test(t)) return { headline: "Listed task rows", verb: "task" };
  if (/^TaskGet$/.test(t)) return { headline: "Read a task row", verb: "task" };
  if (/^TaskOutput$/.test(t)) return { headline: "Read task output", verb: "task" };
  if (/^TaskStop$/.test(t)) return { headline: "Stopped a task", verb: "task" };

  if (/AskUserQuestion/.test(t)) return { headline: "Asked you a question", verb: "question" };
  if (/murmur_ask/.test(t)) return { headline: "Asked you via Murmur", verb: "murmur-ask" };
  if (/murmur_log/.test(t)) return { headline: target ? target.slice(0, 80) : "Logged status to Murmur", verb: "log" };
  if (/murmur_open/.test(t)) return { headline: "Opened the Murmur dashboard", verb: "log" };
  if (/murmur_init/.test(t)) return { headline: "Initialised the Murmur dashboard", verb: "log" };
  if (/murmur_update/.test(t)) return { headline: target ? `Updated Murmur row: ${target.slice(0, 40)}` : "Updated a Murmur row", verb: "log" };

  if (/^Cron(Create|Delete|List)$/.test(t) || /ScheduleWakeup/.test(t)) {
    return { headline: "Scheduled background work", verb: "task" };
  }
  if (/^Skill$/.test(t)) {
    const name = target.split(/\s+/)[0];
    return { headline: name ? `Invoked the /${name} skill` : "Invoked a skill", verb: "exec" };
  }

  if (t.startsWith("mcp__")) return mcpIntent(t, target);

  return { headline: target ? `${t} · ${target.slice(0, 60)}` : t, verb: "shell" };
}

function hookIntent(a: Extract<Activity, { kind: "hook" }>): EventIntent {
  const hook = (a.hook ?? "").trim();
  const event = (a.event ?? "").trim();
  const detail = (a.detail ?? "").trim();
  return { headline: hookHeadline(hook, event, detail), verb: "hook" };
}

// What the hook acted on, in human terms. A PreToolUse Bash check carries the
// command, so describe its intent ("Analyzed the Flutter project"); a
// PostToolUse edit check carries a file path, so name the file.
function hookSubject(event: string, detail: string): string {
  if (!detail) return "";
  const e = event.toLowerCase();
  if (e.startsWith("pretooluse")) return bashIntent(detail).headline;
  // Path-looking detail -> the file; a bare command -> its intent.
  if (detail.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(detail)) return basename(detail);
  if (/\s/.test(detail)) return bashIntent(detail).headline;
  return detail;
}

function hookHeadline(hook: string, event: string, detail: string): string {
  const hookLower = hook.toLowerCase();
  const subject = hookSubject(event, detail);
  // Name the hook's job, then append what it acted on so the row reads as
  // "<purpose>: <tool/command intent>" instead of a generic "Checked a tool call".
  const withSubject = (base: string): string => (subject ? `${base}: ${subject}` : base);

  // Specific, recognizable hooks (purpose + subject).
  if (hookLower.includes("block-destructive")) return withSubject("Screened a command for destructive edits");
  if (hookLower.includes("block-raw-jira")) return withSubject("Guarded against a raw Jira API call");
  if (/em[-_]?dash[-_]?scan[-_]?stop/.test(hookLower)) return "Scanned the reply for em-dashes";
  if (hookLower.includes("em-dash-scan") || hookLower.includes("em_dash")) return withSubject("Scanned an edit for em-dashes");
  if (hookLower.includes("log-instructions")) return withSubject("Loaded project instructions");
  if (hookLower.includes("session-start")) return "Started a Claude session";
  if (/^murmur[-_]?mirror$/.test(hookLower) || hookLower.includes("murmur-mirror")) {
    return "Mirrored a tool call to Murmur";
  }
  if (hookLower.includes("git-precommit") || hookLower.includes("pre-commit")) {
    return "Ran git pre-commit checks";
  }
  if (hookLower.includes("notify-stop") || hookLower.includes("native-alert")) {
    return "Notified you that the run finished";
  }
  if (hookLower === "stop" || hookLower.includes("claude-stop")) {
    return "Wrapped up the Claude session";
  }
  if (hookLower.includes("sessionstart")) {
    return "Started a Claude session";
  }
  if (hookLower.includes("userpromptsubmit")) {
    return "Captured your last message";
  }

  // Fall back to the event type, still naming the subject when we have one.
  if (event) {
    const eventLower = event.toLowerCase();
    if (eventLower.startsWith("posttooluse")) return withSubject("Recorded a tool call");
    if (eventLower.startsWith("pretooluse")) return withSubject("Checked a command before running");
    if (eventLower === "stop") return "Wrapped up the Claude session";
    if (eventLower === "sessionstart") return "Started a Claude session";
    if (eventLower === "userpromptsubmit") return "Captured your last message";
    if (eventLower === "notification") return "Sent a notification";
  }

  if (hook) return `Background hook ran (${hook})`;
  return "A background hook ran";
}
