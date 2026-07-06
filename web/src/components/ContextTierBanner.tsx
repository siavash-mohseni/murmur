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
        title="Approaching long-context pricing tier"
      >
        <div className="mt-1.5 text-xs text-amber-100/90">
          Context is at {formatTokens(tokens)}. Past 200K, every turn bills at
          roughly 2× input and 1.5× output. Consider running{" "}
          <CodeChip>/compact</CodeChip>{" "}
          soon.
        </div>
      </WarnBanner>
    );
  }
  return (
    <DangerBanner icon={<Flame className="h-4 w-4" />} title="Long-context pricing in effect">
      <div className="mt-1.5 text-xs text-rose-100/90">
        Context is at {formatTokens(tokens)} (over 200K). Every turn now bills
        at the premium tier. Run{" "}
        <CodeChip>/compact</CodeChip>{" "}
        to drop back to standard rates.
      </div>
    </DangerBanner>
  );
}
