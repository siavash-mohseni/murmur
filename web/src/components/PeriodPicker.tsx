import { useRef, useState } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { PERIODS, periodLabel, type Period } from "@/lib/period";

export function PeriodPicker({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="period-pill"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {periodLabel(period)}
        <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-md border border-white/10 bg-zinc-900 shadow-lg ring-1 ring-black/30"
        >
          {PERIODS.map((p) => (
            <button
              key={p.key}
              role="option"
              aria-selected={p.key === period}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition ${
                p.key === period
                  ? "bg-blue-500/15 text-blue-200"
                  : "text-zinc-200 hover:bg-white/[0.06]"
              }`}
              onClick={() => {
                onChange(p.key);
                setOpen(false);
              }}
            >
              {p.label}
              {p.key === period && <CheckCircle2 className="h-3.5 w-3.5 text-blue-300" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
