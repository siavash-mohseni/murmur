import { Clock } from "lucide-react";
import { useNow } from "@/hooks/useNow";

// Live countdown for a pending question/permission card. Every pending prompt
// carries expiresAt; when it lapses the server resolves the caller with a
// timeout and the card silently vanishes, so the countdown is the user's only
// warning that a decision is about to be made without them. Amber while
// comfortable, rose for the final stretch.
export function Countdown({ expiresAt }: { expiresAt: string }): React.JSX.Element | null {
  const now = useNow(1_000);
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return null;
  const remainingMs = end - now;
  if (remainingMs <= 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-rose-300 ring-1 ring-inset ring-rose-500/30">
        <Clock className="h-3 w-3" aria-hidden />
        expired
      </span>
    );
  }
  const totalSec = Math.ceil(remainingMs / 1_000);
  const label =
    totalSec >= 60
      ? `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, "0")}s`
      : `${totalSec}s`;
  const urgent = remainingMs < 30_000;
  const tone = urgent
    ? "bg-rose-500/10 text-rose-300 ring-rose-500/30"
    : "bg-white/[0.04] text-zinc-400 ring-white/10";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums ring-1 ring-inset ${tone}`}
      title="Time left before Claude continues without an answer"
    >
      <Clock className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}
