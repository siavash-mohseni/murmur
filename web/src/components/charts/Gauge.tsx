import { useId } from "react";
import type React from "react";

export interface GaugeProps {
  value: number;
  size?: number;
  thickness?: number;
  color?: string;
  trackColor?: string;
  thresholds?: { at: number; color: string }[];
  centerLabel?: string;
  centerCaption?: string;
}

function polarToCartesian(cx: number, cy: number, r: number, angleRad: number): [number, number] {
  return [cx + r * Math.cos(angleRad), cy + r * Math.sin(angleRad)];
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngleRad: number,
  endAngleRad: number
): string {
  const [sx, sy] = polarToCartesian(cx, cy, r, startAngleRad);
  const [ex, ey] = polarToCartesian(cx, cy, r, endAngleRad);
  const largeArc = Math.abs(endAngleRad - startAngleRad) > Math.PI ? 1 : 0;
  const sweep = endAngleRad > startAngleRad ? 1 : 0;
  return `M ${sx.toFixed(3)} ${sy.toFixed(3)} A ${r} ${r} 0 ${largeArc} ${sweep} ${ex.toFixed(3)} ${ey.toFixed(3)}`;
}

export function Gauge({
  value,
  size = 124,
  thickness = 10,
  color = "rgb(96 165 250)",
  trackColor = "rgba(255,255,255,0.1)",
  thresholds = [],
  centerLabel,
  centerCaption,
}: GaugeProps): React.JSX.Element {
  const id = useId();
  const clamped = Math.max(0, Math.min(1, value));
  const padding = thickness / 2 + 4;
  const r = (size - padding * 2) / 2;
  const cx = size / 2;
  const cy = r + padding;
  const labelSpace = centerLabel || centerCaption ? 14 : 0;
  const totalH = cy + thickness / 2 + 4 + labelSpace;

  const START = Math.PI;
  const END = 2 * Math.PI;
  const valueEnd = START + clamped * (END - START);

  const trackPath = arcPath(cx, cy, r, START, END);
  const valuePath = clamped > 0 ? arcPath(cx, cy, r, START, valueEnd) : null;
  const endpoint = valuePath
    ? polarToCartesian(cx, cy, r, valueEnd)
    : null;

  return (
    <svg
      width={size}
      height={totalH}
      viewBox={`0 0 ${size} ${totalH}`}
      aria-hidden
      role="img"
    >
      <defs>
        <linearGradient id={`${id}-grad`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={color} stopOpacity="0.7" />
          <stop offset="100%" stopColor={color} stopOpacity="1" />
        </linearGradient>
      </defs>
      <path
        d={trackPath}
        fill="none"
        stroke={trackColor}
        strokeWidth={thickness}
        strokeLinecap="round"
      />
      {valuePath && endpoint && (
        <>
          <path
            d={valuePath}
            fill="none"
            stroke={`url(#${id}-grad)`}
            strokeWidth={thickness}
            strokeLinecap="round"
          />
          <circle
            cx={endpoint[0]}
            cy={endpoint[1]}
            r={thickness / 2 + 1}
            fill={color}
            stroke="rgb(9 9 11)"
            strokeWidth={1.5}
          />
        </>
      )}
      {thresholds.map((t, i) => {
        const a = START + Math.max(0, Math.min(1, t.at)) * (END - START);
        const inner = r - thickness / 2 - 2;
        const outer = r + thickness / 2 + 2;
        const [x1, y1] = polarToCartesian(cx, cy, inner, a);
        const [x2, y2] = polarToCartesian(cx, cy, outer, a);
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={t.color}
            strokeWidth={1.25}
            strokeLinecap="round"
            opacity={0.6}
          />
        );
      })}
      {centerLabel && (
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          dominantBaseline="alphabetic"
          fill="rgb(244 244 245)"
          fontSize={size * 0.16}
          fontWeight={600}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {centerLabel}
        </text>
      )}
      {centerCaption && (
        <text
          x={cx}
          y={cy + 12}
          textAnchor="middle"
          dominantBaseline="hanging"
          fill="rgb(161 161 170)"
          fontSize={size * 0.085}
          fontWeight={500}
        >
          {centerCaption}
        </text>
      )}
    </svg>
  );
}
