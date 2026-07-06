import type React from "react";

export interface StackedBarSegment {
  value: number;
  color: string;
  label: string;
}

export interface StackedBarProps {
  segments: StackedBarSegment[];
  width?: number;
  height?: number;
  trackColor?: string;
  showLegend?: boolean;
  legendFormatter?: (segment: StackedBarSegment) => string;
}

export function StackedBar({
  segments,
  width = 116,
  height = 12,
  trackColor = "rgba(255,255,255,0.05)",
  showLegend = true,
  legendFormatter,
}: StackedBarProps): React.JSX.Element {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const radius = height / 2;
  const visible = segments.filter((s) => s.value > 0);

  let cursor = 0;
  const rects = visible.map((seg, i) => {
    const w = total > 0 ? (Math.max(0, seg.value) / total) * width : 0;
    const x = cursor;
    cursor += w;
    return <rect key={i} x={x} y={0} width={w} height={height} fill={seg.color} />;
  });

  return (
    <div className="flex flex-col items-end gap-2" style={{ width }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden
        role="img"
        style={{ overflow: "hidden", borderRadius: radius }}
      >
        <rect x={0} y={0} width={width} height={height} fill={trackColor} />
        {rects}
      </svg>
      {showLegend && visible.length > 0 && (
        <ul className="flex w-full flex-col gap-1">
          {visible.map((seg, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 text-[10px] leading-none text-zinc-400"
            >
              <span className="flex items-center gap-1.5 truncate">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: seg.color }}
                />
                <span className="truncate">{seg.label}</span>
              </span>
              <span className="tabular-nums text-zinc-500">
                {legendFormatter
                  ? legendFormatter(seg)
                  : total > 0
                    ? `${Math.round((seg.value / total) * 100)}%`
                    : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
