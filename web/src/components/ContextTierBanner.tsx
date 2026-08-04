import { AlertTriangle, Flame } from "lucide-react";
import { CodeChip, DangerBanner, WarnBanner } from "@/components/Panel";
import { formatTokens } from "@/lib/format";

export type ContextTier = "ok" | "warn" | "cliff";

export function ContextTierBanner({
  tier,
  tokens,
}: {
  tier: ContextTier;
  tokens: number;
}): React.JSX.Element | null {
  if (tier === "ok") return null;
  if (tier === "warn") {
    return (
      <WarnBanner
        icon={<AlertTriangle className="h-4 w-4" />}
        title="Context window filling up"
      >
        <div className="mt-1.5 text-xs text-amber-100/90">
          Context is at {formatTokens(tokens)}, past 70% of the window. Consider
          running <CodeChip>/compact</CodeChip> soon so a compaction lands
          where you choose rather than mid-task.
        </div>
      </WarnBanner>
    );
  }
  return (
    <DangerBanner icon={<Flame className="h-4 w-4" />} title="Context window nearly full">
      <div className="mt-1.5 text-xs text-rose-100/90">
        Context is at {formatTokens(tokens)}, past 90% of the window. Run{" "}
        <CodeChip>/compact</CodeChip> to free room before the session compacts
        on its own.
      </div>
    </DangerBanner>
  );
}
