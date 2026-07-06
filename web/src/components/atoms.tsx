import type { Activity, RowStatus } from "@/hooks/useDashboardState";
import { eventIntent } from "@/lib/event-intent";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  Eye,
  FilePlus,
  Files,
  Globe,
  Loader2,
  MessageSquare,
  NotebookPen,
  Plug,
  Search,
  Shield,
  SquarePen,
  Terminal,
  User,
  XCircle,
  Zap,
} from "lucide-react";

export function StatusIcon({ status }: { status: RowStatus }): React.JSX.Element {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === "in_progress") return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-rose-400" />;
  return <Circle className="h-4 w-4 text-zinc-500" />;
}
// Pill tone (background + text + ring) for a status. Covers RowStatus plus the
// workflow-run extras (`running`, `stale`, `stopped`). Values copied verbatim
// from the StatusPill and WorkflowsPanel pill maps so both render identically.
// `in_progress` (rows) and `running` (workflow runs) share the blue tone, and
// any unknown status (pending, stopped, ...) falls through to the zinc default.
export function toneForStatus(status: string): string {
  if (status === "completed") return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30";
  if (status === "in_progress" || status === "running")
    return "bg-blue-500/15 text-blue-300 ring-blue-500/30";
  if (status === "failed") return "bg-rose-500/15 text-rose-300 ring-rose-500/30";
  if (status === "stale") return "bg-amber-500/15 text-amber-300 ring-amber-500/30";
  return "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30";
}
export function StatusPill({ status }: { status: RowStatus }): React.JSX.Element {
  const cls = toneForStatus(status);
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${cls}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
export function activityIcon(activity: Activity): React.JSX.Element {
  if (activity.kind === "log") return <MessageSquare className="h-3.5 w-3.5" />;
  if (activity.kind === "agent") return <Bot className="h-3.5 w-3.5" />;
  if (activity.kind === "warn") return <AlertTriangle className="h-3.5 w-3.5" />;
  if (activity.kind === "hook") return <Plug className="h-3.5 w-3.5" />;
  if (activity.kind === "prompt") {
    if (activity.source === "user") return <User className="h-3.5 w-3.5" />;
    if (activity.source === "permission") return <Shield className="h-3.5 w-3.5" />;
    if (activity.source === "assistant") return <Bot className="h-3.5 w-3.5" />;
    return <MessageSquare className="h-3.5 w-3.5" />;
  }
  const t = activity.tool;
  if (t === "Edit") return <SquarePen className="h-3.5 w-3.5" />;
  if (t === "Write") return <FilePlus className="h-3.5 w-3.5" />;
  if (t === "MultiEdit") return <Files className="h-3.5 w-3.5" />;
  if (t === "NotebookEdit") return <NotebookPen className="h-3.5 w-3.5" />;
  if (t === "Read") return <Eye className="h-3.5 w-3.5" />;
  if (t === "Bash") return <Terminal className="h-3.5 w-3.5" />;
  if (t === "Glob" || t === "Grep") return <Search className="h-3.5 w-3.5" />;
  if (t === "WebFetch" || t === "WebSearch") return <Globe className="h-3.5 w-3.5" />;
  return <Zap className="h-3.5 w-3.5" />;
}
export function activityAvatarTone(activity: Activity): string {
  if (activity.kind === "log") return "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30";
  if (activity.kind === "agent") return "bg-violet-500/15 text-violet-300 ring-violet-500/30";
  if (activity.kind === "warn") return "bg-amber-500/15 text-amber-300 ring-amber-500/30";
  if (activity.kind === "hook") return "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30";
  if (activity.kind === "prompt") {
    // Solid, high-contrast so prompts pop out of the feed.
    if (activity.source === "user")
      return "bg-pink-500 text-white ring-pink-400";
    if (activity.source === "permission")
      return "bg-rose-600 text-white ring-rose-400";
    if (activity.source === "murmur")
      return "bg-amber-500 text-zinc-950 ring-amber-300";
    if (activity.source === "assistant")
      return "bg-violet-500 text-white ring-violet-400";
    return "bg-blue-500 text-white ring-blue-400";
  }
  const t = activity.tool;
  if (t === "Edit") return "bg-blue-500/15 text-blue-300 ring-blue-500/30";
  if (t === "Write") return "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30";
  if (t === "MultiEdit") return "bg-purple-500/15 text-purple-300 ring-purple-500/30";
  if (t === "NotebookEdit") return "bg-teal-500/15 text-teal-300 ring-teal-500/30";
  if (t === "Bash") return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30";
  if (t === "WebFetch" || t === "WebSearch") return "bg-sky-500/15 text-sky-300 ring-sky-500/30";
  return "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30";
}
export function activityLabel(activity: Activity): { primary: string; secondary?: string } {
  return { primary: eventIntent(activity).headline, secondary: secondaryFor(activity) };
}

function secondaryFor(activity: Activity): string | undefined {
  if (activity.kind === "tool") return activity.target || undefined;
  if (activity.kind === "agent") return activity.description || undefined;
  if (activity.kind === "prompt") {
    // For "user" and "assistant" prompts the headline is generic ("You sent a
    // message" / "Claude replied"), so the question text is the meaningful
    // detail to show. For ask/murmur/permission the question is already echoed
    // in the headline; surface the answer (or nothing) underneath instead.
    if (activity.source === "user" || activity.source === "assistant") {
      return activity.question || undefined;
    }
    return activity.answer && activity.answer.length > 0 ? `→ ${activity.answer}` : undefined;
  }
  if (activity.kind === "hook") {
    const parts: string[] = [];
    if (activity.event) parts.push(activity.event);
    if (activity.detail) parts.push(activity.detail);
    return parts.length === 0 ? undefined : parts.join(" · ");
  }
  return undefined;
}

export function rawTooltip(a: Activity): string | undefined {
  if (a.kind === "tool") {
    const parts = [a.tool];
    if (a.target) parts.push(a.target);
    return parts.join(" · ");
  }
  if (a.kind === "agent") {
    const parts = ["Agent"];
    if (a.subagentType) parts.push(a.subagentType);
    if (a.description) parts.push(a.description);
    return parts.join(" · ");
  }
  if (a.kind === "hook") {
    const parts = ["Hook", a.hook];
    if (a.event) parts.push(a.event);
    if (a.detail) parts.push(a.detail);
    return parts.filter(Boolean).join(" · ");
  }
  if (a.kind === "prompt") {
    const tag =
      a.source === "user" ? "You"
      : a.source === "permission" ? "Permission"
      : a.source === "murmur" ? "Murmur"
      : a.source === "assistant" ? "Claude"
      : "AskUser";
    return `${tag}: ${a.question}${a.answer ? ` → ${a.answer}` : ""}`;
  }
  if (a.kind === "log") return `Log: ${a.message}`;
  if (a.kind === "warn") return `Warning: ${a.message}`;
  return undefined;
}
