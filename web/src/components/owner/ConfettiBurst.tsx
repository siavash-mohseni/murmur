import { useMemo } from "react";

// A one-shot confetti shower for the moment a session finishes. Pure DOM: a
// fixed set of colored shards, each given its own drift, spin, and timing via
// CSS custom properties, animated by the .confetti-piece keyframes in index.css
// (which no-op under prefers-reduced-motion). The parent mounts this only while
// celebrating and unmounts it after the animation window, so there is nothing
// to clean up here. Confined to the parent's bounds (the hero clips overflow),
// so it rains inside the card rather than over the whole page.

const COLORS = ["#34d399", "#fbbf24", "#38bdf8", "#a78bfa", "#fb7185", "#f4f4f5"];
const COUNT = 40;

interface Shard {
  left: number; // start position across the card, percent
  dx: number; // horizontal drift, px
  dy: number; // fall distance, px
  rot: number; // total rotation, deg
  dur: number; // seconds
  delay: number; // seconds
  color: string;
  wide: boolean; // ribbon vs square
}

export function ConfettiBurst(): React.JSX.Element {
  // Built once per mount. Math.random is fine in app code, and a fresh mount
  // (new celebration) reseeds it.
  const shards = useMemo<Shard[]>(
    () =>
      Array.from({ length: COUNT }, (_, n) => ({
        left: Math.random() * 100,
        dx: (Math.random() - 0.5) * 160,
        dy: 90 + Math.random() * 80,
        rot: (Math.random() - 0.5) * 720,
        dur: 1.0 + Math.random() * 0.7,
        delay: Math.random() * 0.25,
        color: COLORS[n % COLORS.length],
        wide: n % 3 === 0,
      })),
    []
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {shards.map((s, n) => (
        <span
          key={n}
          className="confetti-piece absolute top-0 block rounded-[1px]"
          style={{
            left: `${s.left}%`,
            width: s.wide ? 4 : 6,
            height: s.wide ? 9 : 6,
            backgroundColor: s.color,
            ["--cf-dx" as string]: `${s.dx}px`,
            ["--cf-dy" as string]: `${s.dy}px`,
            ["--cf-rot" as string]: `${s.rot}deg`,
            ["--cf-dur" as string]: `${s.dur}s`,
            ["--cf-delay" as string]: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
