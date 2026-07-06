import { useEffect, useMemo, useRef } from "react";
import type { DashboardState, PermissionDecision } from "@/hooks/useDashboardState";
import type { StuckWarning } from "@/hooks/useStuckDetection";
import { deriveOwnerStatus, recentActivityIntensity } from "@/lib/owner-status";
import { OwnerInbox } from "@/components/owner/OwnerInbox";
import { OwnerOutcomes } from "@/components/owner/OwnerOutcomes";
import { OwnerStatusHero } from "@/components/owner/OwnerStatusHero";
import { OwnerTimeline } from "@/components/owner/OwnerTimeline";

// The non-programmer rendering of the session. Same data as the operator
// view, one altitude up: what is it doing, does it need me, did it work.
export function OwnerView({
  state,
  isStale,
  stuckWarnings,
  now,
  submitAnswer,
  cancelQuestion,
  submitPermission,
}: {
  state: DashboardState | null;
  isStale: boolean;
  stuckWarnings: StuckWarning[];
  now: number;
  submitAnswer: (questionId: string, answer: string) => Promise<boolean>;
  cancelQuestion: (questionId: string) => Promise<boolean>;
  submitPermission: (permissionId: string, decision: PermissionDecision) => Promise<boolean>;
}): React.JSX.Element {
  const status = deriveOwnerStatus({ state, stuckWarnings, isStale, now });
  const intensity = useMemo(
    () => (state ? recentActivityIntensity(state.activities, now) : 0),
    [state, now]
  );

  // When a fresh question or permission appears, pull the reader to the inbox
  // even if they have scrolled down into the timeline. Keyed on the pending id
  // so it fires once per ask, not on every render while one is open.
  const needsMeKey =
    state?.pendingQuestion?.questionId ?? state?.pendingPermission?.permissionId ?? null;
  const inboxRef = useRef<HTMLDivElement>(null);
  const prevNeedsRef = useRef<string | null>(null);
  useEffect(() => {
    if (needsMeKey && needsMeKey !== prevNeedsRef.current) {
      inboxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    prevNeedsRef.current = needsMeKey;
  }, [needsMeKey]);

  return (
    <div className="space-y-6">
      {/* First box stays pinned. The hero panel is translucent, so the wrapper
          carries a frosted opaque band, otherwise scrolled content shows
          through it. */}
      <div className="sticky top-0 z-[15] -mx-6 bg-zinc-950/85 px-6 pb-3 pt-4 backdrop-blur-md">
        <OwnerStatusHero status={status} startedAt={state?.startedAt} intensity={intensity} />
      </div>
      {/* scroll-mt clears the sticky hero so the auto-scroll lands the inbox
          below it, not behind it. */}
      <div ref={inboxRef} className="scroll-mt-44">
        <OwnerInbox
          question={state?.pendingQuestion ?? null}
          permission={state?.pendingPermission ?? null}
          stuckWarnings={stuckWarnings}
          agentSessions={state?.agentSessions ?? []}
          currentSessionId={state?.sessionInfo?.claudeSessionId}
          onAnswer={submitAnswer}
          onCancelQuestion={cancelQuestion}
          onDecide={submitPermission}
        />
      </div>
      {state && (
        <>
          <OwnerTimeline
            rows={state.rows}
            activities={state.activities}
            now={now}
            autoScrollNew={needsMeKey === null}
          />
          <OwnerOutcomes
            rows={state.rows}
            workflows={state.workflows}
            activities={state.activities}
            tokenStats={state.tokenStats ?? null}
            startedAt={state.startedAt}
            now={now}
          />
        </>
      )}
    </div>
  );
}
