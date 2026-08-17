import { useState } from "react";
import { useDashboardKpis } from "@/hooks/useDashboardKpis";
import type { DashboardState, PermissionDecision } from "@/hooks/useDashboardState";
import type { StuckWarning } from "@/hooks/useStuckDetection";
import { KpiTile } from "@/components/KpiTile";
import { OwnerInbox } from "@/components/owner/OwnerInbox";
import { PeriodPicker } from "@/components/PeriodPicker";
import { StuckBanner } from "@/components/StuckBanner";
import { AgentWaitingBanner } from "@/components/AgentWaitingBanner";
import { ContextTierBanner } from "@/components/ContextTierBanner";
import { ActivityPanel } from "@/components/panels/ActivityPanel";
import { BackgroundTasksPanel } from "@/components/panels/BackgroundTasksPanel";
import { FilesTouchedPanel } from "@/components/panels/FilesTouchedPanel";
import { MemoryPanel } from "@/components/panels/MemoryPanel";
import { ProgressPanel } from "@/components/panels/ProgressPanel";
import { SkillsLoadedPanel } from "@/components/panels/SkillsLoadedPanel";
import { SlashCommandsPanel } from "@/components/panels/SlashCommandsPanel";
import { SubAgentsPanel } from "@/components/panels/SubAgentsPanel";
import { ToolBreakdownPanel } from "@/components/panels/ToolBreakdownPanel";
import { Donut, Gauge, Sparkline, StackedBar } from "@/components/charts";
import { isWaiting } from "@/lib/agent-session";
import { estimateCost, formatCost } from "@/lib/cost";
import { formatTokens } from "@/lib/format";
import { periodLabel, type Period } from "@/lib/period";

// The expert dashboard: KPI grid plus the full panel stack, moved verbatim
// from App.tsx when the Owner view landed. The period picker and the KPI
// derivation live here because only this view uses them.
export function OperatorView({
  state,
  stuckWarnings,
  now,
  submitAnswer,
  cancelQuestion,
  submitPermission,
}: {
  state: DashboardState | null;
  stuckWarnings: StuckWarning[];
  now: number;
  submitAnswer: (questionId: string, answer: string) => Promise<boolean>;
  cancelQuestion: (questionId: string) => Promise<boolean>;
  submitPermission: (permissionId: string, decision: PermissionDecision) => Promise<boolean>;
}): React.JSX.Element {
  const [period, setPeriod] = useState<Period>("session");

  const rows = state?.rows ?? [];
  const activities = state?.activities ?? [];

  const {
    activitiesInPeriod,
    toolCount,
    tokenStats,
    workflowCost,
    workflowTokens,
    toolSparkline,
    tokenSegments,
    costSegments,
    activityKpi,
    contextPct,
    warnPct,
    cliffPct,
    contextTier,
    contextGaugeColor,
    cacheHitPct,
    cacheHitColor,
  } = useDashboardKpis(state, period, now);

  // The banner block only mounts when a banner will actually render. Each
  // banner returns null when inactive, and an always-present empty wrapper
  // would still earn a space-y gap from the page container.
  const anyBanner =
    contextTier !== "ok" ||
    stuckWarnings.length > 0 ||
    (state?.agentSessions ?? []).some(isWaiting);

  return (
    <div className="space-y-8">
      {/* Inline answer surface. Always usable regardless of the "In this tab"
          notification channel: the overlay is a notification, this is THE
          place to answer. Stuck/waiting items already have dedicated banners
          below, so this card only carries the question and the permission. */}
      {(state?.pendingQuestion || state?.pendingPermission) && (
        <OwnerInbox
          question={state?.pendingQuestion ?? null}
          permission={state?.pendingPermission ?? null}
          stuckWarnings={[]}
          agentSessions={[]}
          currentSessionId={state?.sessionInfo?.claudeSessionId}
          onAnswer={submitAnswer}
          onCancelQuestion={cancelQuestion}
          onDecide={submitPermission}
        />
      )}
      {anyBanner && (
        <div className="flex flex-col gap-3">
          <ContextTierBanner tier={contextTier} tokens={tokenStats?.lastContextTokens ?? 0} />
          <StuckBanner warnings={stuckWarnings} />
          <AgentWaitingBanner
            agentSessions={state?.agentSessions ?? []}
            currentSessionId={state?.sessionInfo?.claudeSessionId}
          />
        </div>
      )}

      {/* Overview row */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">Overview</h2>
          <PeriodPicker period={period} onChange={setPeriod} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="Activity"
            value={
              activityKpi.latest
                ? activityKpi.latest.messageCount.toLocaleString()
                : "—"
            }
            delta={
              activityKpi.latest
                ? `${activityKpi.latest.toolCallCount.toLocaleString()} tool calls`
                : "—"
            }
            caption={
              activityKpi.latest
                ? activityKpi.daysStale === 0
                  ? `messages today · ${activityKpi.avgMessages.toLocaleString()} avg`
                  : `messages ${activityKpi.daysStale}d ago · ${activityKpi.avgMessages.toLocaleString()} avg`
                : "no stats cache yet"
            }
            tone="neutral"
            chart={
              <Sparkline
                data={activityKpi.sparkline}
                width={120}
                height={56}
                color="rgb(52 211 153)"
              />
            }
          />
          <KpiTile
            label="Context"
            value={tokenStats ? formatTokens(tokenStats.lastContextTokens) : "—"}
            delta={
              tokenStats
                ? `${Math.min(999, Math.round((tokenStats.lastContextTokens / tokenStats.contextLimit) * 100))}%`
                : "—"
            }
            caption={
              tokenStats
                ? `of ${formatTokens(tokenStats.contextLimit)} window`
                : "waiting for first response"
            }
            tone={
              contextTier === "cliff"
                ? "down"
                : contextTier === "warn"
                  ? "neutral"
                  : tokenStats
                    ? "up"
                    : "neutral"
            }
            chart={
              <Gauge
                value={contextPct}
                size={124}
                thickness={10}
                color={contextGaugeColor}
                thresholds={[
                  { at: warnPct, color: "rgb(251 191 36)" },
                  { at: cliffPct, color: "rgb(244 63 94)" },
                ]}
                centerLabel={
                  tokenStats ? `${Math.round(contextPct * 100)}%` : "—"
                }
                centerCaption="used"
              />
            }
          />
          <KpiTile
            label="Tokens used"
            value={
              tokenStats
                ? formatTokens(tokenStats.totalTokens + workflowTokens)
                : workflowTokens > 0
                  ? formatTokens(workflowTokens)
                  : "—"
            }
            delta={
              tokenStats
                ? `in ${formatTokens(tokenStats.inputTokens + tokenStats.cacheReadTokens + tokenStats.cacheCreationTokens)} · out ${formatTokens(tokenStats.outputTokens)}`
                : "—"
            }
            caption={
              workflowTokens > 0
                ? `incl. ${formatTokens(workflowTokens)} from workflows`
                : tokenStats
                  ? `${tokenStats.messageCount} assistant turn${tokenStats.messageCount === 1 ? "" : "s"}`
                  : "no turns yet"
            }
            tone="neutral"
            chart={
              tokenStats ? (
                <StackedBar
                  segments={tokenSegments}
                  width={120}
                  height={10}
                  legendFormatter={(s) => formatTokens(s.value)}
                />
              ) : undefined
            }
          />
          <KpiTile
            label="Cost"
            value={
              tokenStats
                ? formatCost(estimateCost(tokenStats) + workflowCost)
                : workflowCost > 0
                  ? formatCost(workflowCost)
                  : "—"
            }
            delta={tokenStats?.model ? tokenStats.model.replace("claude-", "") : "—"}
            caption={
              workflowCost > 0
                ? `estimated · incl. ${formatCost(workflowCost)} workflows`
                : tokenStats
                  ? "estimated, this session"
                  : "waiting for first response"
            }
            tone="neutral"
            chart={
              tokenStats ? (
                <StackedBar
                  segments={costSegments}
                  width={120}
                  height={10}
                  legendFormatter={(s) => formatCost(s.value)}
                />
              ) : undefined
            }
          />
          <KpiTile
            label="Cache hit"
            value={
              tokenStats
                ? `${Math.round(cacheHitPct * 100)}%`
                : "—"
            }
            delta={
              tokenStats
                ? `${formatTokens(tokenStats.cacheReadTokens)} read`
                : "—"
            }
            caption={
              tokenStats
                ? `${formatTokens(tokenStats.cacheCreationTokens)} created`
                : "no cache yet"
            }
            tone={
              tokenStats
                ? cacheHitPct > 0.7
                  ? "up"
                  : cacheHitPct > 0.3
                    ? "neutral"
                    : "down"
                : "neutral"
            }
            chart={
              tokenStats ? (
                <Donut
                  segments={[
                    { value: tokenStats.cacheReadTokens, color: cacheHitColor },
                    {
                      value:
                        tokenStats.cacheCreationTokens + tokenStats.inputTokens,
                      color: "rgba(255,255,255,0.08)",
                    },
                  ]}
                  size={84}
                  thickness={9}
                  centerLabel={`${Math.round(cacheHitPct * 100)}%`}
                  centerCaption="cache"
                />
              ) : undefined
            }
          />
          <KpiTile
            label="Tool calls"
            value={toolCount}
            delta={periodLabel(period).toLowerCase()}
            caption={`${activitiesInPeriod.length} total activities`}
            tone="neutral"
            chart={
              <Sparkline
                data={toolSparkline}
                width={120}
                height={56}
                color="rgb(129 140 248)"
              />
            }
          />
        </div>
      </section>

      {/* Progress + Activity stacked */}
      <section className="space-y-4">
        <ProgressPanel
          rows={rows}
          activities={activities}
          workflows={state?.workflows}
          period={period}
          now={now}
        />
        <ActivityPanel activities={activities} period={period} now={now} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ToolBreakdownPanel activities={activities} period={period} now={now} />
          <SubAgentsPanel activities={activities} period={period} now={now} />
        </div>
        <BackgroundTasksPanel activities={activities} period={period} now={now} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SlashCommandsPanel activities={activities} period={period} now={now} />
          <SkillsLoadedPanel activities={activities} period={period} now={now} />
        </div>
        <MemoryPanel entries={state?.memoryEntries ?? []} />
        <FilesTouchedPanel activities={activities} period={period} now={now} />
      </section>
    </div>
  );
}
