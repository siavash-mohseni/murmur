#!/usr/bin/env bun
// pricing-smoke.ts: asserts the cost math against the published per-MTok list
// prices. Every expected value here is read off
// platform.claude.com/docs/en/about-claude/pricing, so a rate that drifts from
// the price list fails a check rather than quietly changing every dashboard.
//
// Run: bun scripts/pricing-smoke.ts

import {
  CONTEXT_LIMITS,
  PRICING,
  costByComponent,
  estimateCost,
  isKnownModel,
  pricingFor,
} from "../src/model-caps.js";

let pass = 0;
let fail = 0;
const check = (label: string, want: unknown, got: unknown): void => {
  if (String(want) === String(got)) {
    console.log(`OK  ${label}`);
    pass++;
  } else {
    console.log(`!!  ${label} (want=${want} got=${got})`);
    fail++;
  }
};

const MTOK = 1_000_000;
const AT = Date.parse("2026-08-04T00:00:00Z"); // inside Sonnet 5's intro window

// --- base rates, one million tokens of each kind ------------------------------

// The published table, as (model, input, output, 5m write, 1h write, read).
const LIST: [string, number, number, number, number, number][] = [
  ["claude-fable-5", 10, 50, 12.5, 20, 1],
  ["claude-mythos-5", 10, 50, 12.5, 20, 1],
  ["claude-opus-5", 5, 25, 6.25, 10, 0.5],
  ["claude-opus-4-8", 5, 25, 6.25, 10, 0.5],
  ["claude-opus-4-7", 5, 25, 6.25, 10, 0.5],
  ["claude-opus-4-6", 5, 25, 6.25, 10, 0.5],
  ["claude-sonnet-4-6", 3, 15, 3.75, 6, 0.3],
  ["claude-haiku-4-5", 1, 5, 1.25, 2, 0.1],
];

for (const [model, input, output, write5m, write1h, read] of LIST) {
  check(`${model} input`, input, estimateCost({ inputTokens: MTOK, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, model, atMs: AT }));
  check(`${model} output`, output, estimateCost({ inputTokens: 0, outputTokens: MTOK, cacheCreationTokens: 0, cacheReadTokens: 0, model, atMs: AT }));
  check(`${model} 5m cache write`, write5m, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: MTOK, cacheReadTokens: 0, model, atMs: AT }));
  check(`${model} 1h cache write`, write1h, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: MTOK, cacheCreation1hTokens: MTOK, cacheReadTokens: 0, model, atMs: AT }));
  check(`${model} cache read`, read, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: MTOK, model, atMs: AT }));
}

// --- Sonnet 5 introductory pricing expires ------------------------------------

const BEFORE = Date.parse("2026-08-31T23:59:59Z");
const AFTER = Date.parse("2026-09-01T00:00:01Z");
check("sonnet-5 intro input", 2, pricingFor("claude-sonnet-5", BEFORE).input);
check("sonnet-5 intro output", 10, pricingFor("claude-sonnet-5", BEFORE).output);
check("sonnet-5 standard input", 3, pricingFor("claude-sonnet-5", AFTER).input);
check("sonnet-5 standard output", 15, pricingFor("claude-sonnet-5", AFTER).output);
// Cache rates ride the base rate, so they move with it.
check("sonnet-5 intro 1h write", 4, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: MTOK, cacheCreation1hTokens: MTOK, cacheReadTokens: 0, model: "claude-sonnet-5", atMs: BEFORE }));
check("sonnet-5 standard 1h write", 6, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: MTOK, cacheCreation1hTokens: MTOK, cacheReadTokens: 0, model: "claude-sonnet-5", atMs: AFTER }));

// --- the full window bills at standard rates ---------------------------------
// Claude 4.6 and later carry the 1M window with no long-context premium, so a
// 900K-token turn costs exactly 100x a 9K one.
const small = estimateCost({ inputTokens: 9_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, model: "claude-opus-5", atMs: AT });
const large = estimateCost({ inputTokens: 900_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, model: "claude-opus-5", atMs: AT });
check("900K input is exactly 100x 9K (no long-context premium)", true, Math.abs(large - small * 100) < 1e-9);

// --- mixed TTL splits, and the components sum to the headline -----------------

const mixed = {
  inputTokens: 100_000,
  outputTokens: 50_000,
  cacheCreationTokens: 200_000,
  cacheCreation1hTokens: 150_000,
  cacheReadTokens: 3_000_000,
  model: "claude-opus-5",
  atMs: AT,
};
// input 0.5 + output 1.25 + writes (50K*6.25 + 150K*10)/1e6 = 1.8125 + reads 1.5
check("mixed usage totals", 5.0625, estimateCost(mixed));
const parts = costByComponent(mixed);
check("components sum to headline", true, Math.abs(parts.input + parts.output + parts.cacheRead + parts.cacheCreation - estimateCost(mixed)) < 1e-12);
check("1h portion is capped at the total written", 10, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: MTOK, cacheCreation1hTokens: 5 * MTOK, cacheReadTokens: 0, model: "claude-opus-5", atMs: AT }));
check("missing TTL split prices as a 5m write", 6.25, estimateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: MTOK, cacheReadTokens: 0, model: "claude-opus-5", atMs: AT }));

// --- registry completeness ---------------------------------------------------

for (const model of Object.keys(PRICING)) {
  check(`${model} is in both registry maps`, true, isKnownModel(model));
}
check("every priced model has a context limit", true, Object.keys(PRICING).every((m) => m in CONTEXT_LIMITS));
// An unknown model must not throw. It falls back to the Sonnet tier.
check("unknown model falls back", 3, estimateCost({ inputTokens: MTOK, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, model: "claude-does-not-exist", atMs: AT }));

console.log("");
if (fail === 0) {
  console.log(`pricing smoke: all ${pass} checks pass.`);
  process.exit(0);
} else {
  console.log(`pricing smoke: ${fail} check(s) failed.`);
  process.exit(1);
}
