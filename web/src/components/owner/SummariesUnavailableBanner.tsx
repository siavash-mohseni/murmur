import { MessageSquareOff } from "lucide-react";
import { CodeChip, WarnBanner } from "@/components/Panel";

// Shown only when the server reported a reason (a failing nested CLI), never
// when summaries are simply switched off. Without it the timeline silently falls
// back to Claude's own wording and the feature looks broken with no way to tell
// that signing in again fixes it.

const MAX_REASON_CHARS = 160;

export function SummariesUnavailableBanner({
  reason,
}: {
  reason: string;
}): React.JSX.Element {
  const clipped =
    reason.length > MAX_REASON_CHARS
      ? `${reason.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`
      : reason;
  return (
    <div className="mb-3">
      <WarnBanner
        icon={<MessageSquareOff className="h-4 w-4" />}
        title="Plain-language summaries unavailable"
      >
        <div className="mt-1.5 text-xs text-amber-100/90">
          Showing Claude's own wording below instead. Summaries run the local{" "}
          <CodeChip>claude</CodeChip> CLI, which reported:{" "}
          <span className="text-amber-200">{clipped}</span> An expired login is
          the usual cause, so try signing in again with{" "}
          <CodeChip>/login</CodeChip>.
        </div>
      </WarnBanner>
    </div>
  );
}
