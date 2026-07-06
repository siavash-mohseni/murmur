import { useId } from "react";
import type React from "react";

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
  showDot?: boolean;
}

export function Sparkline({
  data,
  width = 112,
  height = 56,
  color = "rgb(129 140 248)",
  strokeWidth = 1.5,
  showDot = true,
}: SparklineProps): React.JSX.Element {
  const id = useId();
  const padX = 1;
  const padY = 4;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  if (data.length === 0) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden role="img">
        <line
          x1={padX}
          x2={width - padX}
          y1={height / 2}
          y2={height / 2}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const max = Math.max(...data, 1);
  const min = 0;
  const range = max - min || 1;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const points = data.map((v, i) => {
    const x = padX + (data.length === 1 ? innerW / 2 : i * stepX);
    const y = padY + innerH * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const lineD = points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)},${y.toFixed(2)}` : `L${x.toFixed(2)},${y.toFixed(2)}`))
    .join(" ");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const areaD = `${lineD} L${last[0].toFixed(2)},${(height - padY).toFixed(2)} L${first[0].toFixed(2)},${(height - padY).toFixed(2)} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden role="img">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${id}-fill)`} />
      <path
        d={lineD}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showDot && (
        <circle
          cx={last[0]}
          cy={last[1]}
          r={2.5}
          fill={color}
          stroke="rgb(9 9 11)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
