// The model registry (context limits, long-context threshold, pricing, and
// the tiered cost math) lives in the shared src/model-caps.ts so this bundle
// and the server cannot drift. Re-exported here so existing consumers keep
// importing everything from "@/lib/cost" unchanged. This module keeps only
// the web-specific helpers: workflow cost coalescing and display formatting.
import {
  DEFAULT_PRICING,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  PRICING,
  costByComponent,
  estimateCost,
  type CostByComponent,
  type CostInputs,
  type Pricing,
} from "../../../src/model-caps";
export {
  DEFAULT_PRICING,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  PRICING,
  costByComponent,
  estimateCost,
};
export type { CostByComponent, CostInputs, Pricing };

export const LONG_CONTEXT_WARN_TOKENS = 160_000;

// Minimal shape of a mirrored workflow run for cost estimation (see
// WorkflowMirror in useDashboardState). Kept local to avoid a circular import.
interface WorkflowCostInput {
  totalTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  agents: { model?: string; tokens?: number }[];
}

// Dynamic-workflow agents always run on Opus (the project pins them there and
// forbids Fable), so when a run carries no per-agent model yet — early in a live
// run, or a journal without model metadata — price it as Opus rather than
// letting dominantModel return undefined and falling back to Sonnet-rate
// DEFAULT_PRICING, which understates an Opus run by ~5x.
const WORKFLOW_FALLBACK_MODEL = "claude-opus-4-8";

// Pick the model that produced the most output tokens in a run, so a mixed
// fan-out (Opus orchestrator + Haiku workers) is priced on its dominant model.
function dominantModel(run: WorkflowCostInput): string | undefined {
  let best: string | undefined;
  let bestTokens = -1;
  const byModel = new Map<string, number>();
  for (const a of run.agents) {
    if (!a.model) continue;
    const next = (byModel.get(a.model) ?? 0) + (a.tokens ?? 0);
    byModel.set(a.model, next);
    if (next > bestTokens) {
      bestTokens = next;
      best = a.model;
    }
  }
  return best;
}

/**
 * Estimate the USD cost of dynamic-workflow sub-agents. Live runs carry the
 * full input/cache/output split (parsed from each agent transcript); completed
 * runs carry output only. Priced per run on its dominant model.
 */
export function estimateWorkflowCost(runs: WorkflowCostInput[] | undefined): number {
  if (!runs || runs.length === 0) return 0;
  let total = 0;
  for (const run of runs) {
    const output = run.totalOutputTokens ?? run.totalTokens ?? 0;
    total += estimateCost({
      inputTokens: run.totalInputTokens ?? 0,
      outputTokens: output,
      cacheReadTokens: run.totalCacheReadTokens ?? 0,
      cacheCreationTokens: run.totalCacheCreationTokens ?? 0,
      model: dominantModel(run) ?? WORKFLOW_FALLBACK_MODEL,
    });
  }
  return total;
}

// Sum the token buckets of dynamic-workflow sub-agents the same way
// estimateWorkflowCost coalesces them, so the Tokens KPI and the Cost KPI never
// drift on which buckets they count. Mirrors App's former inline reduce exactly.
export function sumWorkflowTokens(
  runs: WorkflowCostInput[] | undefined
): number {
  if (!runs || runs.length === 0) return 0;
  return runs.reduce(
    (s, r) =>
      s +
      (r.totalOutputTokens ?? r.totalTokens ?? 0) +
      (r.totalInputTokens ?? 0) +
      (r.totalCacheReadTokens ?? 0) +
      (r.totalCacheCreationTokens ?? 0),
    0
  );
}

export function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
export function cacheRatio(stats: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const denom = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
  if (denom === 0) return 0;
  return stats.cacheReadTokens / denom;
}
