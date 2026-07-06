// A tiling ECG-style waveform that reflects how busy the session is. The line
// scrolls and stands tall when activity is high, slows and flattens toward a
// resting baseline when the session goes quiet. Speed and amplitude come from
// the live activity rate (0..1), so this is "more visual" that still carries a
// real signal: is anything happening right now.
//
// All motion is the .hb-scroll CSS animation, which disables itself under
// prefers-reduced-motion (see index.css), leaving a static, readable line.

// One tile of the trace, baseline at y=16 so both ends meet for a seamless
// loop. Two P-QRS-T beats per tile with short rests between, so the line reads
// as an active monitor rather than one lonely spike on a flat baseline.
const TILE =
  "0,16 6,16 12,16 16,11 20,16 27,16 31,3 35,29 39,16 45,13 51,16 60,16 66,16 72,11 76,16 83,16 87,3 91,29 95,16 101,13 107,16 120,16";

export function Heartbeat({
  intensity,
  colorClass,
  className,
}: {
  intensity: number;
  colorClass: string;
  className?: string;
}): React.JSX.Element {
  const i = Math.max(0, Math.min(1, intensity));
  // Busy: ~2.5s per loop and near-full height. Calmer: ~3.4s and still clearly
  // standing off the baseline (the caller floors intensity while live).
  const dur = 4.5 - i * 2.0;
  const amp = 0.55 + i * 0.45;

  // Amplitude (scaleY) sits on the outer element and the scroll animation on the
  // inner one: the .hb-scroll keyframes own `transform`, so a scaleY on the same
  // element would be overridden while the animation runs.
  return (
    <div
      className={`relative h-8 w-full overflow-hidden ${colorClass} ${className ?? ""}`}
      style={{ transform: `scaleY(${amp})` }}
    >
      <div
        className="hb-scroll flex h-full w-[200%]"
        style={{ ["--hb-dur" as string]: `${dur}s`, filter: "drop-shadow(0 0 2px currentColor)" }}
      >
        <Trace />
        <Trace />
      </div>
    </div>
  );
}

function Trace(): React.JSX.Element {
  return (
    <svg aria-hidden viewBox="0 0 120 32" preserveAspectRatio="none" className="h-full w-1/2">
      <polyline
        points={TILE}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
