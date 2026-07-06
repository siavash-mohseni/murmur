import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Hourglass,
  Loader2,
  PauseCircle,
  WifiOff,
} from "lucide-react";
import { useNow } from "@/hooks/useNow";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { elapsedString, relativeTime } from "@/lib/format";
import { toneClasses } from "@/lib/owner-language";
import type { OwnerStatus, OwnerStatusKind } from "@/lib/owner-status";
import { ConfettiBurst } from "@/components/owner/ConfettiBurst";
import { Heartbeat } from "@/components/owner/Heartbeat";

// The 1s tick lives in this leaf so the clock re-renders alone, copying the
// ElapsedClock pattern in SessionMeta.tsx.
function SinceChip({
  status,
  startedAt,
}: {
  status: OwnerStatus;
  startedAt?: string;
}): React.JSX.Element | null {
  const now = useNow(1000);
  if (status.sinceIso) {
    return (
      <span className="shrink-0 rounded-md bg-white/[0.04] px-2 py-1 text-xs tabular-nums text-zinc-400 ring-1 ring-inset ring-white/10">
        {relativeTime(status.sinceIso, now)}
      </span>
    );
  }
  if (startedAt) {
    return (
      <span className="shrink-0 rounded-md bg-white/[0.04] px-2 py-1 text-xs tabular-nums text-zinc-400 ring-1 ring-inset ring-white/10">
        session {elapsedString(startedAt, now)}
      </span>
    );
  }
  return null;
}

// One iconic glyph per status, so the hero names its state by shape before a
// word is read. spin marks live work (a turning loader).
const STATUS_GLYPH: Record<
  OwnerStatusKind,
  { Icon: React.ComponentType<{ className?: string }>; spin?: boolean }
> = {
  connecting: { Icon: Loader2, spin: true },
  offline: { Icon: WifiOff },
  needs_you: { Icon: HelpCircle },
  stuck: { Icon: Hourglass },
  working: { Icon: Loader2, spin: true },
  attention: { Icon: AlertTriangle },
  done: { Icon: CheckCircle2 },
  idle: { Icon: PauseCircle },
};

export function OwnerStatusHero({
  status,
  startedAt,
  intensity = 0,
}: {
  status: OwnerStatus;
  startedAt?: string;
  // 0..1, how busy the session is right now. Drives the heartbeat.
  intensity?: number;
}): React.JSX.Element {
  const tone = toneClasses(status.tone);
  const { Icon: Glyph, spin } = STATUS_GLYPH[status.kind];
  const attention = status.kind === "needs_you" || status.kind === "stuck";
  const reduced = usePrefersReducedMotion();

  // Fire confetti once on the transition into "done", then tear it down. Keyed
  // on a counter so a later done (after more work) celebrates again.
  const [celebrations, setCelebrations] = useState(0);
  const prevKind = useRef<OwnerStatusKind>(status.kind);
  useEffect(() => {
    if (status.kind === "done" && prevKind.current !== "done" && !reduced) {
      setCelebrations((n) => n + 1);
    }
    prevKind.current = status.kind;
  }, [status.kind, reduced]);
  const [showConfetti, setShowConfetti] = useState(false);
  useEffect(() => {
    if (celebrations === 0) return;
    setShowConfetti(true);
    const t = setTimeout(() => setShowConfetti(false), 1800);
    return () => clearTimeout(t);
  }, [celebrations]);

  // The heartbeat means "is it alive right now", so it only shows while the
  // session is actively working or connecting. On done, idle, and waiting
  // states there is no pulse to draw, and a near-flat resting trace just reads
  // as a glitch, so it is hidden. While live, floor it so it never flatlines
  // between sampled beats.
  const live = status.kind === "working" || status.kind === "connecting";
  const beat = Math.max(intensity, 0.55);

  return (
    <div
      className={`panel relative overflow-hidden p-6 ring-1 ring-inset transition-colors duration-500 ${tone.ring}`}
    >
      {/* A soft tone glow washes the whole card in its state color without
          touching text contrast: green when done, blue while working, rose when
          something needs attention. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -left-10 -top-10 h-36 w-36 rounded-full blur-2xl transition-colors duration-500 ${tone.dot} opacity-[0.08]`}
      />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative shrink-0">
              {/* An attention ripple pulses out from behind the badge when the
                  session wants the reader (a question or a stuck step). */}
              {attention && (
                <span
                  aria-hidden
                  className={`absolute inset-0 rounded-xl ${tone.dot} opacity-30 motion-safe:animate-ping`}
                />
              )}
              <span
                className={`relative flex h-12 w-12 items-center justify-center rounded-xl ring-1 ring-inset transition-colors duration-500 ${tone.pill}`}
              >
                <Glyph className={`h-6 w-6 ${tone.text} ${spin ? "motion-safe:animate-spin" : ""}`} />
              </span>
            </div>
            {/* Keyed on kind so the headline fades and rises in on a real state
                change instead of snapping. */}
            <div key={status.kind} className="owner-rise min-w-0">
              <div className="text-2xl font-semibold tracking-tight text-zinc-50">
                {status.headline}
              </div>
              {status.detail && <div className="mt-1 text-sm text-zinc-400">{status.detail}</div>}
            </div>
          </div>
          <SinceChip status={status} startedAt={startedAt} />
        </div>
        {/* The vital sign: only while live, faster and taller the busier the
            session is. */}
        {live && <Heartbeat intensity={beat} colorClass={tone.text} className="mt-4 opacity-90" />}
      </div>
      {showConfetti && <ConfettiBurst key={celebrations} />}
    </div>
  );
}
