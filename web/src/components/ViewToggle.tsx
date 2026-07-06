import { Eye, Gauge } from "lucide-react";
import type { ViewMode } from "@/hooks/useViewMode";

// Segmented Operator/Owner switch for the header. Sized to sit beside the
// other h-8 header pills (.icon-pill, .period-pill).
export function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Dashboard view"
      className="inline-flex h-8 items-center rounded-md border border-white/10 bg-white/[0.03] p-0.5"
    >
      <Segment
        active={view === "owner"}
        label="Owner"
        icon={<Eye className="h-3.5 w-3.5" />}
        onClick={() => onChange("owner")}
      />
      <Segment
        active={view === "operator"}
        label="Operator"
        icon={<Gauge className="h-3.5 w-3.5" />}
        onClick={() => onChange("operator")}
      />
    </div>
  );
}

function Segment({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-full items-center gap-1.5 rounded px-2.5 text-xs font-medium transition ${
        active ? "bg-white/[0.08] text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
