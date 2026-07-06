import { useCallback, useEffect, useState } from "react";
import { Archive, Download, Sparkles, Trash2, X } from "lucide-react";
import type { DashboardState } from "@/hooks/useDashboardState";
import { downloadHtml, openHtmlInNewTab, stamp } from "@/components/ShareButtons";
import { buildExportHtml } from "@/lib/export-html";
import { buildSummaryHtml } from "@/lib/summary-html";
import { formatCost } from "@/lib/cost";
import { formatLocalTime } from "@/lib/format";

export interface PastSession {
  key: string;
  claudeSessionId?: string;
  branch?: string;
  cwdBasename?: string;
  cwd?: string;
  title?: string;
  startedAt?: string;
  lastActivityAt?: string;
  rowCount: number;
  activityCount: number;
  isLive: boolean;
  port?: number;
  bytes: number;
  mtime: string;
  // Server-derived from the persisted tokenStats (absent when the session
  // never recorded any): lets history answer "what did this run cost".
  model?: string;
  totalTokens?: number;
  costUsd?: number;
}

function shortId(s: PastSession): string {
  return (s.claudeSessionId ?? s.key).slice(0, 8);
}

function displayLabel(s: PastSession): string {
  if (s.title && s.title.trim().length > 0) return s.title.trim();
  const m = s.key.match(/^claude-(\d+)$/);
  if (m) return `pid ${m[1]}`;
  return s.key.slice(0, 12);
}
export function PastSessionsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<"list" | "compare">("list");
  const [compareA, setCompareA] = useState<DashboardState | null>(null);
  const [compareB, setCompareB] = useState<DashboardState | null>(null);

  const refresh = useCallback(() => {
    void fetch("/sessions/all")
      .then((r) => r.json())
      .then((list: PastSession[]) => setSessions(list))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) {
      setSelected([]);
      setView("list");
      setCompareA(null);
      setCompareB(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const toggleSelect = (key: string): void => {
    setSelected((s) => {
      if (s.includes(key)) return s.filter((k) => k !== key);
      if (s.length >= 2) return [s[1]!, key];
      return [...s, key];
    });
  };

  const doCompare = async (): Promise<void> => {
    if (selected.length !== 2) return;
    const [a, b] = await Promise.all(
      selected.map((k) =>
        fetch(`/sessions/by-key?key=${encodeURIComponent(k)}`).then((r) => r.json())
      )
    );
    setCompareA(a);
    setCompareB(b);
    setView("compare");
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-5xl max-h-[85vh] overflow-hidden rounded-xl border border-white/10 bg-zinc-950 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-base font-semibold text-zinc-50">
              {view === "list" ? "Past sessions" : "Compare sessions"}
            </div>
            <div className="text-xs text-zinc-500">
              {view === "list"
                ? `${sessions.length} on disk · live first, then by modified date`
                : "Side-by-side KPI comparison"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {view === "list" && selected.length === 2 && (
              <button
                onClick={() => void doCompare()}
                className="inline-flex items-center rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white ring-1 ring-inset ring-blue-400 hover:bg-blue-400"
              >
                Compare two
              </button>
            )}
            {view === "compare" && (
              <button
                onClick={() => {
                  setView("list");
                  setCompareA(null);
                  setCompareB(null);
                }}
                className="period-pill"
              >
                Back to list
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {view === "list" ? (
            <PastSessionsList
              sessions={sessions}
              selected={selected}
              onToggleSelect={toggleSelect}
              onDeleted={refresh}
            />
          ) : (
            <CompareView a={compareA} b={compareB} />
          )}
        </div>
      </div>
    </div>
  );
}
export function PastSessionsList({
  sessions,
  selected,
  onToggleSelect,
  onDeleted,
}: {
  sessions: PastSession[];
  selected: string[];
  onToggleSelect: (key: string) => void;
  onDeleted?: () => void;
}): React.JSX.Element {
  if (sessions.length === 0) {
    return <div className="px-5 py-8 text-sm text-zinc-500">No sessions on disk yet.</div>;
  }
  const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  return (
    <div>
      {totalCost > 0 && (
        <div className="px-5 py-2 text-xs text-zinc-500">
          {sessions.length} session{sessions.length === 1 ? "" : "s"} on disk · est. total
          spend {formatCost(totalCost)}
        </div>
      )}
      <div className="tbl-head sticky top-0 bg-zinc-950 z-10">
        <span className="w-6 shrink-0" />
        <span className="flex-1">Session</span>
        {/* Secondary columns collapse on phones: the fixed widths otherwise
            push Cost/Status/Actions off a narrow screen. */}
        <span className="hidden w-16 shrink-0 text-right sm:block">Rows</span>
        <span className="hidden w-16 shrink-0 text-right sm:block">Events</span>
        <span className="w-20 shrink-0 text-right">Cost</span>
        <span className="hidden w-24 shrink-0 text-right sm:block">Last</span>
        <span className="w-24 shrink-0 text-right">Status</span>
        <span className="w-28 shrink-0 text-right">Actions</span>
      </div>
      {sessions.map((s) => {
        const isSelected = selected.includes(s.key);
        return (
          <PastSessionRow
            key={s.key}
            session={s}
            isSelected={isSelected}
            onToggleSelect={onToggleSelect}
            onDeleted={onDeleted}
          />
        );
      })}
    </div>
  );
}

function PastSessionRow({
  session: s,
  isSelected,
  onToggleSelect,
  onDeleted,
}: {
  session: PastSession;
  isSelected: boolean;
  onToggleSelect: (key: string) => void;
  onDeleted?: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<null | "summary" | "export" | "delete">(null);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async (): Promise<DashboardState | null> => {
    try {
      const res = await fetch(`/sessions/by-key?key=${encodeURIComponent(s.key)}`);
      if (!res.ok) {
        setError(`failed to load (${res.status})`);
        return null;
      }
      return (await res.json()) as DashboardState;
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
      return null;
    }
  }, [s.key]);

  const onSummary = useCallback(async () => {
    setBusy("summary");
    setError(null);
    try {
      const state = await fetchState();
      if (!state) return;
      const synthetic = [
        {
          key: s.key,
          port: s.port ?? 0,
          url: "",
          current: true,
          alive: false,
          branch: s.branch,
          cwdBasename: s.cwdBasename,
          startedAt: s.startedAt,
          claudeSessionId: s.claudeSessionId,
          cwd: s.cwd,
          title: s.title,
        },
      ];
      openHtmlInNewTab(
        buildSummaryHtml({ state, sessions: synthetic }),
        `murmur-summary-${shortId(s)}-${stamp()}.html`
      );
    } finally {
      setBusy(null);
    }
  }, [fetchState, s]);

  const onExport = useCallback(async () => {
    setBusy("export");
    setError(null);
    try {
      const state = await fetchState();
      if (!state) return;
      downloadHtml(
        buildExportHtml({ state, sessions: [] }),
        `claude-session-${shortId(s)}-${stamp()}.html`
      );
    } finally {
      setBusy(null);
    }
  }, [fetchState, s]);

  const onDelete = useCallback(async () => {
    const label = displayLabel(s);
    const confirmed = window.confirm(
      `Delete session "${label}"? This removes the on-disk state file and cannot be undone.`
    );
    if (!confirmed) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(`/sessions/by-key?key=${encodeURIComponent(s.key)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        setError(body.reason ?? `delete failed (${res.status})`);
        return;
      }
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(null);
    }
  }, [s, onDeleted]);

  const idLabel = (s.claudeSessionId ?? s.key).slice(0, 12);

  return (
    <div className="tbl-row">
      <span className="w-6 shrink-0 pt-0.5">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(s.key)}
          className="accent-blue-500 cursor-pointer"
        />
      </span>
      <span className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-100 truncate">
          {displayLabel(s)}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500 flex flex-wrap gap-1.5">
          <span className="font-mono">{idLabel}</span>
          {s.branch && <span className="font-mono">· {s.branch}</span>}
          {s.cwdBasename && <span>· {s.cwdBasename}</span>}
          {s.startedAt && (
            <span>· started {new Date(s.startedAt).toLocaleString()}</span>
          )}
        </div>
        {error && (
          <div className="mt-1 text-xs text-rose-300">{error}</div>
        )}
      </span>
      <span className="hidden w-16 shrink-0 pt-0.5 text-right text-sm tabular-nums text-zinc-300 sm:block">
        {s.rowCount}
      </span>
      <span className="hidden w-16 shrink-0 pt-0.5 text-right text-sm tabular-nums text-zinc-300 sm:block">
        {s.activityCount}
      </span>
      <span
        className="w-20 shrink-0 pt-0.5 text-right text-sm tabular-nums text-zinc-300"
        title={
          s.costUsd !== undefined
            ? `estimated · ${s.totalTokens?.toLocaleString() ?? "?"} tokens${s.model ? ` · ${s.model.replace("claude-", "")}` : ""}`
            : undefined
        }
      >
        {s.costUsd !== undefined ? formatCost(s.costUsd) : "—"}
      </span>
      <span className="hidden w-24 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums sm:block">
        {s.lastActivityAt ? formatLocalTime(s.lastActivityAt) : "—"}
      </span>
      <span className="w-24 shrink-0 pt-0.5 text-right text-xs">
        {s.isLive ? (
          <a
            href={`http://127.0.0.1:${s.port}/`}
            className="text-emerald-300 hover:underline"
          >
            open :{s.port}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 text-zinc-500">
            <Archive className="h-3 w-3" /> archived
          </span>
        )}
      </span>
      <span className="w-28 shrink-0 pt-0.5 text-right">
        <span className="inline-flex items-center gap-1 justify-end">
          <button
            type="button"
            onClick={() => void onSummary()}
            disabled={busy !== null}
            className="rounded-md p-1.5 text-violet-300 ring-1 ring-inset ring-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-40 disabled:cursor-wait"
            title="Open a chronological recap of this session in a new tab"
            aria-label="Open session summary"
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void onExport()}
            disabled={busy !== null}
            className="rounded-md p-1.5 text-zinc-300 ring-1 ring-inset ring-white/10 bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-wait"
            title="Download a standalone HTML snapshot of this session"
            aria-label="Export session snapshot"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={busy !== null || s.isLive}
            className="rounded-md p-1.5 text-rose-300 ring-1 ring-inset ring-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            title={s.isLive ? "Cannot delete a live session" : "Delete this archived session"}
            aria-label="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </span>
    </div>
  );
}
export function CompareView({
  a,
  b,
}: {
  a: DashboardState | null;
  b: DashboardState | null;
}): React.JSX.Element {
  if (!a || !b) {
    return <div className="px-5 py-8 text-sm text-zinc-500">Loading comparison…</div>;
  }
  const stats = (s: DashboardState): { label: string; value: string }[] => {
    const completed = s.rows.filter((r) => r.status === "completed").length;
    const failed = s.rows.filter((r) => r.status === "failed").length;
    const tools = s.activities.filter((x) => x.kind === "tool").length;
    const ts = s.tokenStats;
    return [
      { label: "Session", value: s.sessionId.slice(0, 12) },
      { label: "Branch", value: s.sessionInfo.branch ?? "—" },
      { label: "Repo", value: s.sessionInfo.cwdBasename ?? "—" },
      { label: "Started", value: new Date(s.startedAt).toLocaleString() },
      { label: "Progress rows", value: `${completed}/${s.rows.length}` },
      { label: "Failed", value: String(failed) },
      { label: "Activities", value: String(s.activities.length) },
      { label: "Tool calls", value: String(tools) },
      { label: "Assistant turns", value: ts ? String(ts.messageCount) : "—" },
      {
        label: "Tokens total",
        value: ts ? ts.totalTokens.toLocaleString() : "—",
      },
      {
        label: "Cache read",
        value: ts ? ts.cacheReadTokens.toLocaleString() : "—",
      },
      {
        label: "Last context",
        value: ts ? `${ts.lastContextTokens.toLocaleString()} / ${ts.contextLimit.toLocaleString()}` : "—",
      },
    ];
  };
  const aStats = stats(a);
  const bStats = stats(b);
  return (
    <div className="px-5 py-4">
      <div className="grid grid-cols-3 gap-x-4 text-sm">
        <div className="text-xs uppercase tracking-wider text-zinc-500">Metric</div>
        <div className="text-xs uppercase tracking-wider text-zinc-500">A</div>
        <div className="text-xs uppercase tracking-wider text-zinc-500">B</div>
      </div>
      <div className="mt-2 divide-y divide-white/5">
        {aStats.map((row, i) => {
          const bRow = bStats[i];
          const diff = row.value !== bRow?.value;
          return (
            <div key={row.label} className="grid grid-cols-3 gap-x-4 py-2 text-sm">
              <div className="text-zinc-400">{row.label}</div>
              <div className={`font-mono tabular-nums ${diff ? "text-blue-200" : "text-zinc-300"}`}>
                {row.value}
              </div>
              <div className={`font-mono tabular-nums ${diff ? "text-blue-200" : "text-zinc-300"}`}>
                {bRow?.value ?? "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
