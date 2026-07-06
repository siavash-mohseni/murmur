import { Bell, X, ExternalLink } from "lucide-react";
import type { Notification } from "@/hooks/useDashboardState";
import { formatLocalTime } from "@/lib/format";

// Routine notifications: a global feed posted by scheduled jobs (the morning
// review queue, thread triage, future routines) via POST /api/notify or the
// notify helper. Lives outside any session, so it shows in every pane.
function post(path: string, id: string): void {
  void fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

// Only render an http(s) link as an anchor href. The server already drops
// non-http(s) schemes at ingest, but React does not neutralize a `javascript:`
// href at runtime, so guard here too as defense-in-depth against a stale or
// otherwise-sourced link executing script in the dashboard origin on click.
function safeHref(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    const { protocol } = new URL(link, window.location.origin);
    return protocol === "http:" || protocol === "https:" ? link : undefined;
  } catch {
    return undefined;
  }
}

export function RoutinesPanel({
  notifications,
}: {
  notifications: Notification[];
}): React.JSX.Element {
  const list = [...notifications].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );
  const unread = list.filter((n) => !n.read).length;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-zinc-400" />
          <div>
            <div className="text-base font-semibold text-zinc-50">Routines</div>
            <div className="text-xs text-zinc-500">
              {list.length === 0
                ? "Scheduled routines will post here"
                : `${list.length} ${list.length === 1 ? "notification" : "notifications"}${unread > 0 ? ` · ${unread} unread` : ""}`}
            </div>
          </div>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="px-5 py-6 text-sm text-zinc-500">
          Nothing yet. The morning review queue and thread triage post their digests here.
        </div>
      ) : (
        <div className="divide-y divide-zinc-800">
          {list.map((n) => (
            <div
              key={n.id}
              className={`flex items-start gap-3 px-5 py-3 ${n.read ? "opacity-60" : ""}`}
              onMouseEnter={() => {
                if (!n.read) post("/api/notify/read", n.id);
              }}
            >
              {!n.read && (
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
              )}
              <div className={`min-w-0 flex-1 ${n.read ? "" : "-ml-0"}`}>
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-semibold text-zinc-100">
                    {n.title}
                  </span>
                  {n.source && (
                    <span className="shrink-0 rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-zinc-500/30">
                      {n.source}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-400">
                  {n.body}
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-[11px] text-zinc-500">
                    {formatLocalTime(n.timestamp)}
                  </span>
                  {safeHref(n.link) && (
                    <a
                      href={safeHref(n.link)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-blue-400 underline-offset-2 hover:underline"
                    >
                      Open <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              <button
                aria-label="Dismiss"
                className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={() => post("/api/notify/dismiss", n.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
