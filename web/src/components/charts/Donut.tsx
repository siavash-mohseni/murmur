import type React from "react";

export interface DonutSegment {
  value: number;
  color: string;
}

export interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  trackColor?: string;
  centerLabel?: string;
  centerCaption?: string;
}

export function Donut({
  segments,
  size = 84,
  thickness = 9,
  trackColor = "rgba(255,255,255,0.06)",
  centerLabel,
  centerCaption,
}: DonutProps): React.JSX.Element {
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);

  let acc = 0;
  const arcs = segments.map((seg, i) => {
    const v = Math.max(0, seg.value);
    const frac = total > 0 ? v / total : 0;
    const dash = frac * circumference;
    const gap = circumference - dash;
    const dashOffset = -acc * circumference;
    acc += frac;
    return (
      <circle
        key={`arc-${i}`}
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={seg.color}
        strokeWidth={thickness}
        strokeLinecap="butt"
        strokeDasharray={`${dash} ${gap}`}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    );
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden role="img">
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke={trackColor} strokeWidth={thickness} />
      {arcs}
      {(centerLabel || centerCaption) && (
        <g>
          {centerLabel && (
            <text
              x={cx}
              y={centerCaption ? cy - 4 : cy}
              textAnchor="middle"
              dominantBaseline="central"
              fill="rgb(244 244 245)"
              fontSize={size * 0.22}
              fontWeight={600}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {centerLabel}
            </text>
          )}
          {centerCaption && (
            <text
              x={cx}
              y={cy + size * 0.14}
              textAnchor="middle"
              dominantBaseline="central"
              fill="rgb(161 161 170)"
              fontSize={size * 0.11}
              fontWeight={500}
            >
              {centerCaption}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
