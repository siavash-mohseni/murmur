import type React from "react";

export function KpiTile({
  label,
  value,
  delta,
  caption,
  tone,
  chart,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  caption?: string;
  tone?: "up" | "down" | "neutral";
  chart?: React.ReactNode;
}): React.JSX.Element {
  const toneClass =
    tone === "up" ? "delta-up" : tone === "down" ? "delta-down" : "delta-neutral";
  return (
    <div className="kpi-tile">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="kpi-label">{label}</div>
          <div className="kpi-number">{value}</div>
          {(delta || caption) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              {delta && <span className={toneClass}>{delta}</span>}
              {caption && <span className="text-xs text-zinc-500">{caption}</span>}
            </div>
          )}
        </div>
        {chart && (
          <div className="kpi-chart shrink-0" aria-hidden>
            {chart}
          </div>
        )}
      </div>
    </div>
  );
}
