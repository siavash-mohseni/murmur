import { useState } from "react";
import { Brain } from "lucide-react";
import type { MemoryEntry } from "@/hooks/useDashboardState";
import { formatLocalTime } from "@/lib/format";

export function memoryToneClass(type?: string): string {
  switch (type) {
    case "feedback":
      return "bg-amber-500/15 text-amber-300 ring-amber-500/30";
    case "project":
      return "bg-blue-500/15 text-blue-300 ring-blue-500/30";
    case "user":
      return "bg-violet-500/15 text-violet-300 ring-violet-500/30";
    case "reference":
      return "bg-sky-500/15 text-sky-300 ring-sky-500/30";
    default:
      return "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30";
  }
}
export function MemoryPanel({ entries }: { entries: MemoryEntry[] }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const session = entries.filter((e) => e.thisSession);
  const other = entries.filter((e) => !e.thisSession);
  const list = showAll ? entries : session;

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="text-base font-semibold text-zinc-50">Memory updates</div>
          <div className="text-xs text-zinc-500">
            {session.length === 0
              ? "Nothing written to memory this session yet"
              : `${session.length} ${session.length === 1 ? "entry" : "entries"} from this session`}
            {other.length > 0 && (
              <>
                {" · "}
                <button
                  className="text-zinc-400 underline-offset-2 hover:underline"
                  onClick={() => setShowAll((s) => !s)}
                >
                  {showAll ? "show this session only" : `show all ${entries.length}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="px-5 py-6 text-sm text-zinc-500">
          Memory entries created this session will appear here.
        </div>
      ) : (
        <div>
          <div className="tbl-head">
            <span className="w-7 shrink-0" />
            <span className="w-44 shrink-0">Name</span>
            <span className="w-20 shrink-0">Type</span>
            <span className="flex-1 min-w-0">Description</span>
            <span className="w-20 shrink-0 text-right">Modified</span>
          </div>
          {list.map((m) => (
            <div key={m.filePath} className="tbl-row">
              <span className={`avatar-blob -mt-1 ${memoryToneClass(m.type)}`}>
                <Brain className="h-3.5 w-3.5" />
              </span>
              <span className="w-44 shrink-0 text-sm font-medium text-zinc-100 break-words">
                {m.name}
                {m.thisSession && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
                    new
                  </span>
                )}
              </span>
              <span className="w-20 shrink-0 pt-0.5">
                {m.type && (
                  <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset bg-zinc-500/15 text-zinc-300 ring-zinc-500/30">
                    {m.type}
                  </span>
                )}
              </span>
              <span className="flex-1 min-w-0 text-sm text-zinc-400 whitespace-pre-wrap break-words">
                {m.description || <em className="text-zinc-600">no description</em>}
              </span>
              <span className="w-20 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                {formatLocalTime(m.modifiedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
