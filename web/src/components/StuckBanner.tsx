import { AlertTriangle } from "lucide-react";
import type { StuckWarning } from "@/hooks/useStuckDetection";
import { WarnBanner } from "@/components/Panel";
import { formatLongDuration } from "@/lib/format";

export function StuckBanner({ warnings }: { warnings: StuckWarning[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <WarnBanner
      icon={<AlertTriangle className="h-4 w-4" />}
      title={warnings.length === 1 ? "Possible stall" : `${warnings.length} possible issues`}
    >
      <ul className="mt-1.5 space-y-1 text-xs text-amber-100/90">
        {warnings.map((w, i) => (
          <li key={i}>
            {w.kind === "row-stalled" ? (
              <>
                <span className="font-semibold">{w.label}</span> hasn&apos;t moved for{" "}
                {formatLongDuration(w.sinceMs)}.
              </>
            ) : (
              <>
                Bash command ran <span className="font-semibold">{w.count}×</span> in the last 60s:{" "}
                <code className="rounded bg-white/[0.04] px-1 py-0.5 font-mono text-[11px]">
                  {w.command}
                </code>
              </>
            )}
          </li>
        ))}
      </ul>
    </WarnBanner>
  );
}
