// Single source of truth for model metadata: context windows and per-token
// pricing. Shared by the server (src/transcript.ts, src/state.ts, src/http.ts)
// and the web bundle (web/src/lib/cost.ts). This module is imported by the web
// bundle, so it must stay browser-safe: pure data and pure functions, no node:*
// imports and no side effects.
//
// When a new Claude model ships, add it to BOTH maps below. The server warns
// once per session when a transcript names a model missing from either map
// (see Store.setTokenStats), so drift shows up as a dashboard warning instead
// of a silently wrong context gauge and cost estimate.
//
// Rates below are the published per-MTok list prices
// (platform.claude.com/docs/en/about-claude/pricing). They exclude modifiers
// Claude Code sessions do not currently use: the Batch API's 50% discount, the
// 1.1x data-residency multiplier for inference_geo "us", and fast mode's
// premium rates on Opus 5 and 4.8. Observed transcripts report
// speed "standard" and inference_geo "not_available", so folding those in
// would price a path no session takes.

export const CONTEXT_LIMITS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;

// --- pricing -----------------------------------------------------------------

// Prompt-cache rates are fixed multiples of a model's base input rate, uniform
// across every model in the price list, so only the two base rates are stored
// per model and the cache rates are derived. Cache writes are priced by their
// TTL: Claude Code caches at 1 hour, which bills at twice base input rather
// than the 1.25x a 5-minute write costs.
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

export interface Pricing {
  input: number; // USD per million tokens
  output: number;
}

// Claude Sonnet 5 launched on introductory rates that expire, so its price
// depends on when the tokens were spent. `until` is the first instant billed at
// the standard rate.
interface IntroPricing extends Pricing {
  until: string;
}

const INTRO_PRICING: Record<string, IntroPricing> = {
  "claude-sonnet-5": { input: 2, output: 10, until: "2026-09-01T00:00:00Z" },
};

export const PRICING: Record<string, Pricing> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// An unknown model is priced at the Sonnet tier. It understates an Opus run,
// which is why a missing model also raises a dashboard warning.
export const DEFAULT_PRICING: Pricing = { input: 3, output: 15 };

/** The rate for a model at a given time, applying any introductory pricing
 * still in effect. `atMs` is when the tokens were spent, so a session that
 * straddles the expiry of an introductory rate is priced by its own clock
 * rather than by whenever the dashboard happens to render. */
export function pricingFor(model: string | undefined, atMs: number): Pricing {
  const standard = (model ? PRICING[model] : undefined) ?? DEFAULT_PRICING;
  const intro = model ? INTRO_PRICING[model] : undefined;
  if (intro && atMs < Date.parse(intro.until)) {
    return { input: intro.input, output: intro.output };
  }
  return standard;
}

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
  /** Portion of cacheCreationTokens written at the 1-hour TTL. The remainder
   * is priced as a 5-minute write. Absent on sessions recorded before Murmur
   * read the TTL split, which prices their writes at the cheaper rate. */
  cacheCreation1hTokens?: number;
  model?: string;
  /** When the tokens were spent, for introductory-rate resolution. Defaults to
   * now, which is correct for a live session. */
  atMs?: number;
}

export interface CostByComponent {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Split the USD cost of a token usage record into its four components. This is
 * the one place that owns the rate math: estimateCost sums these four numbers,
 * and the web StackedBar maps them into colored segments, so the breakdown bar
 * always sums to the headline cost.
 */
export function costByComponent(stats: CostInputs): CostByComponent {
  const p = pricingFor(stats.model, stats.atMs ?? Date.now());

  const write1h = Math.min(stats.cacheCreation1hTokens ?? 0, stats.cacheCreationTokens);
  const write5m = Math.max(0, stats.cacheCreationTokens - write1h);

  return {
    input: (stats.inputTokens * p.input) / 1_000_000,
    output: (stats.outputTokens * p.output) / 1_000_000,
    cacheRead: (stats.cacheReadTokens * p.input * CACHE_READ_MULTIPLIER) / 1_000_000,
    cacheCreation:
      (write5m * p.input * CACHE_WRITE_5M_MULTIPLIER +
        write1h * p.input * CACHE_WRITE_1H_MULTIPLIER) /
      1_000_000,
  };
}

export function estimateCost(stats: CostInputs): number {
  const c = costByComponent(stats);
  return c.input + c.output + c.cacheRead + c.cacheCreation;
}
