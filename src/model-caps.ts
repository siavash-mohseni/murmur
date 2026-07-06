// Single source of truth for model metadata: context windows, long-context
// tiering, and per-token pricing. Shared by the server (src/transcript.ts,
// src/state.ts, src/http.ts) and the web bundle (web/src/lib/cost.ts). This
// module is imported by the web bundle, so it must stay browser-safe: pure
// data and pure functions, no node:* imports and no side effects.
//
// When a new Claude model ships, add it to BOTH maps below. The server warns
// once per session when a transcript names a model missing from either map
// (see Store.setTokenStats), so drift shows up as a dashboard warning instead
// of a silently wrong context gauge and cost estimate.

// Context window sizes (input tokens). Claude Opus 4.x and Sonnet 4.x
// support up to 1M tokens via the extended-context beta that Claude Code
// uses for long sessions. Haiku stays at the 200K standard.
export const CONTEXT_LIMITS: Record<string, number> = {
  // Fable 5 runs the extended-context beta like the other 4.x+ flagships
  // (observed: sessions cross 200K input-side before compaction).
  "claude-fable-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;

// Long-context pricing tier kicks in once a single turn's input side
// (input + cache read + cache creation) exceeds this many tokens.
// Applies to models on the 1M-context beta (Sonnet/Opus 4.x).
// Haiku has no long-context tier (capped at 200K context).
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

// The long-context model set is exactly the models whose context limit
// exceeds the long-context threshold (Haiku is excluded because it caps at
// 200K). Derived from CONTEXT_LIMITS so a new model only has to be added in
// one place.
export const LONG_CONTEXT_MODELS = new Set<string>(
  Object.entries(CONTEXT_LIMITS)
    .filter(([, limit]) => limit > LONG_CONTEXT_THRESHOLD_TOKENS)
    .map(([model]) => model)
);

// --- pricing -----------------------------------------------------------------

export interface Pricing {
  input: number;            // USD per million tokens
  output: number;
  cacheCreation: number;
  cacheRead: number;
  // Long-context tier: rates applied to tokens from turns whose input
  // side exceeded 200K. Omit when the model has no long-context tier
  // (Haiku stays at standard rates because it caps at 200K context).
  longContext?: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
}

// Sonnet 4.x 1M-context beta tiers input at 2×, output at 1.5×, cache at 2×.
// Opus 4.x uses the same multiplier shape on the 1M-context beta.
export const PRICING: Record<string, Pricing> = {
  // Provisional: listed at the Opus tier until public Fable pricing lands.
  // Better than the default (Sonnet-tier) fallback, which undercounts a
  // Mythos-class model badly.
  "claude-fable-5": {
    input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5,
    longContext: { input: 30, output: 112.5, cacheCreation: 37.5, cacheRead: 3 },
  },
  "claude-opus-4-8": {
    input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5,
    longContext: { input: 30, output: 112.5, cacheCreation: 37.5, cacheRead: 3 },
  },
  "claude-opus-4-7": {
    input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5,
    longContext: { input: 30, output: 112.5, cacheCreation: 37.5, cacheRead: 3 },
  },
  "claude-opus-4-6": {
    input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5,
    longContext: { input: 30, output: 112.5, cacheCreation: 37.5, cacheRead: 3 },
  },
  "claude-sonnet-4-6": {
    input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3,
    longContext: { input: 6, output: 22.5, cacheCreation: 7.5, cacheRead: 0.6 },
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 },
};
export const DEFAULT_PRICING: Pricing = {
  input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3,
  longContext: { input: 6, output: 22.5, cacheCreation: 7.5, cacheRead: 0.6 },
};

/** True when the model is present in both metadata maps. Anything else means
 * the registry needs an entry, and downstream context/cost numbers are
 * running on fallbacks. */
export function isKnownModel(model: string): boolean {
  return model in CONTEXT_LIMITS && model in PRICING;
}

export interface CostInputs {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  longContextInputTokens?: number;
  longContextOutputTokens?: number;
  longContextCacheCreationTokens?: number;
  longContextCacheReadTokens?: number;
  model?: string;
}

export interface CostByComponent {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Split the USD cost of a token usage record into its four components, each
 * already summing the standard tier and the long-context tier. This is the one
 * place that owns the standard-vs-long-context tiering math: estimateCost sums
 * these four numbers, and the web StackedBar maps them into colored segments,
 * so the breakdown bar always sums to the headline cost.
 */
export function costByComponent(stats: CostInputs): CostByComponent {
  const p: Pricing = (stats.model ? PRICING[stats.model] : undefined) ?? DEFAULT_PRICING;
  // Fall back to standard rates if a long-context tier is not defined
  // for this model (so bookkeeping never drops tokens silently).
  const lc = p.longContext ?? p;

  const lcInput = stats.longContextInputTokens ?? 0;
  const lcOutput = stats.longContextOutputTokens ?? 0;
  const lcCacheCreation = stats.longContextCacheCreationTokens ?? 0;
  const lcCacheRead = stats.longContextCacheReadTokens ?? 0;

  const stdInput = Math.max(0, stats.inputTokens - lcInput);
  const stdOutput = Math.max(0, stats.outputTokens - lcOutput);
  const stdCacheCreation = Math.max(0, stats.cacheCreationTokens - lcCacheCreation);
  const stdCacheRead = Math.max(0, stats.cacheReadTokens - lcCacheRead);

  return {
    input: (stdInput * p.input + lcInput * lc.input) / 1_000_000,
    output: (stdOutput * p.output + lcOutput * lc.output) / 1_000_000,
    cacheRead: (stdCacheRead * p.cacheRead + lcCacheRead * lc.cacheRead) / 1_000_000,
    cacheCreation:
      (stdCacheCreation * p.cacheCreation + lcCacheCreation * lc.cacheCreation) /
      1_000_000,
  };
}

export function estimateCost(stats: CostInputs): number {
  const c = costByComponent(stats);
  return c.input + c.output + c.cacheRead + c.cacheCreation;
}
