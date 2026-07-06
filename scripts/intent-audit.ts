// One-off analysis: load every persisted Murmur session, run each activity
// through the SHIPPING intent heuristic, and report where intent falls back to
// weak/generic output. Run: bun scripts/intent-audit.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type EventIntent } from "../src/intent.ts";
// Measure the SHIPPING dispatcher: import the canonical eventIntent from the
// web lib instead of re-pasting a copy here (the old inline replica had already
// drifted, so the audit was scoring code that no longer ships). Bun resolves
// this the same way the script already imports ../src/intent.ts.
import { eventIntent } from "../web/src/lib/event-intent";

const SESSIONS = join(homedir(), ".claude", "state", "murmur", "sessions");

// The persisted activity records are loosely typed here on purpose: the audit
// reads ad-hoc fields off whatever was serialized, and eventIntent narrows the
// shape internally.
type Activity = any;

// --- quality classification --------------------------------------------------
// Tag each computed headline as STRONG (names the real subject) or WEAK
// (generic fallback that only echoes the tool / runtime / verb).
function quality(a: Activity, intent: EventIntent): { tier: "weak" | "ok" | "strong"; reason: string } {
  const h = intent.headline;
  // explicit generic fallbacks we KNOW carry no subject
  if (a.kind === "tool") {
    const t = a.tool as string;
    if (t.startsWith("mcp__")) return { tier: "weak", reason: "mcp-generic" };
    if (/^\w+ · /.test(h) || h === t) return { tier: "weak", reason: "tool-catchall" };
    if (/^Ran `/.test(h)) return { tier: "weak", reason: "bash-unknown-binary" };
    if (/^Ran a shell command$/.test(h)) return { tier: "weak", reason: "bash-empty" };
    if (/^(Ran Python|Ran a Node script|Ran a Deno script|Ran a Dart command|Ran a Flutter command|Ran a Docker command|Ran a Kubernetes command|Ran a Terraform command|Ran az|Ran a build command|Ran an Azure DevOps command)$/.test(h))
      return { tier: "weak", reason: "runtime-generic" };
    if (/^Ran a \w+ snippet$/.test(h)) return { tier: "weak", reason: "inline-snippet-generic" };
    if (/^(Ran bun \w*|Ran an? .* command)$/.test(h)) return { tier: "ok", reason: "runtime-named" };
    if (t === "Task" || t === "Agent" || /agent/i.test(t)) return { tier: "ok", reason: "agent-truncated" };
    if (/^Worked with /.test(h)) return { tier: "ok", reason: "verb-vague" };
    return { tier: "strong", reason: "tool-named" };
  }
  if (a.kind === "agent") return a.subagentType ? { tier: "ok", reason: "agent-typed-only" } : { tier: "weak", reason: "agent-untyped" };
  if (a.kind === "prompt") {
    if (a.source === "assistant") return (a.question ?? "").trim() ? { tier: "strong", reason: "assistant-text" } : { tier: "weak", reason: "assistant-generic" };
    if (a.source === "user") return { tier: "ok", reason: "user-msg-notext" };
    return { tier: "strong", reason: "prompt-named" };
  }
  if (a.kind === "hook") return { tier: "ok", reason: "hook" };
  if (a.kind === "log") return { tier: "strong", reason: "log-message" };
  if (a.kind === "warn") return { tier: "ok", reason: "warn" };
  return { tier: "ok", reason: "other" };
}

// --- run ---------------------------------------------------------------------
const files = readdirSync(SESSIONS).filter((f) => f.endsWith(".json"));
let totalActs = 0;
let withActivities = 0;
const kindCounts: Record<string, number> = {};
const toolCounts: Record<string, number> = {};
const tierCounts: Record<string, number> = { weak: 0, ok: 0, strong: 0 };
const reasonCounts: Record<string, number> = {};
const weakSamples: Record<string, Set<string>> = {};
const mcpToolCounts: Record<string, number> = {};
const mcpRawTargets: Record<string, Set<string>> = {};
const agentPromptSamples: string[] = [];
const bashWeakSamples: Set<string> = new Set();
const headlineFreq: Record<string, number> = {};

function note(bucket: Record<string, Set<string>>, key: string, sample: string) {
  (bucket[key] ??= new Set()).add(sample.slice(0, 120));
}

for (const f of files) {
  let data: any;
  try {
    data = JSON.parse(readFileSync(join(SESSIONS, f), "utf8"));
  } catch {
    continue;
  }
  const acts: Activity[] = data.activities ?? [];
  if (acts.length) withActivities++;
  for (const a of acts) {
    totalActs++;
    kindCounts[a.kind] = (kindCounts[a.kind] ?? 0) + 1;
    if (a.kind === "tool") {
      toolCounts[a.tool] = (toolCounts[a.tool] ?? 0) + 1;
      if (a.tool.startsWith("mcp__")) {
        mcpToolCounts[a.tool] = (mcpToolCounts[a.tool] ?? 0) + 1;
        note(mcpRawTargets, a.tool, JSON.stringify(a.target ?? "").slice(0, 120));
      }
    }
    const intent = eventIntent(a);
    headlineFreq[intent.headline] = (headlineFreq[intent.headline] ?? 0) + 1;
    const q = quality(a, intent);
    tierCounts[q.tier]++;
    reasonCounts[q.reason] = (reasonCounts[q.reason] ?? 0) + 1;
    if (q.tier === "weak") {
      const sampleSrc = a.kind === "tool" ? (a.target ?? a.tool) : a.kind === "agent" ? a.description : a.kind === "prompt" ? a.question : a.message;
      note(weakSamples, q.reason, `${intent.headline}  ⟵  ${sampleSrc}`);
      if (q.reason.startsWith("bash")) bashWeakSamples.add((a.target ?? "").slice(0, 120));
    }
    if (a.kind === "tool" && (a.tool === "Task" || a.tool === "Agent")) {
      if (agentPromptSamples.length < 20 && a.target) agentPromptSamples.push(a.target.slice(0, 120));
    }
  }
}

const pct = (n: number) => ((100 * n) / totalActs).toFixed(1) + "%";
console.log("=".repeat(70));
console.log(`SESSIONS: ${files.length} files, ${withActivities} with activities`);
console.log(`ACTIVITIES: ${totalActs}`);
console.log("=".repeat(70));
console.log("\n## Activity kinds");
for (const [k, v] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v}  (${pct(v)})`);

console.log("\n## Intent quality tiers");
for (const [k, v] of Object.entries(tierCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(8)} ${v}  (${pct(v)})`);

console.log("\n## Weak-intent breakdown by reason");
for (const [k, v] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
  if (tierCounts.weak && ["mcp-generic","tool-catchall","bash-unknown-binary","bash-empty","runtime-generic","inline-snippet-generic","assistant-generic","agent-untyped"].includes(k))
    console.log(`  ${k.padEnd(24)} ${v}  (${pct(v)})`);
}

console.log("\n## Tool distribution");
for (const [k, v] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${k.padEnd(40)} ${v}`);

console.log("\n## MCP tool calls actually mirrored (tool startsWith mcp__)");
const mcpEntries = Object.entries(mcpToolCounts).sort((a, b) => b[1] - a[1]);
if (mcpEntries.length === 0) console.log("  (none mirrored to the feed)");
for (const [k, v] of mcpEntries) console.log(`  ${k.padEnd(50)} ${v}`);

console.log("\n## Top 40 most-frequent headlines (the actual feed text)");
for (const [k, v] of Object.entries(headlineFreq).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log("\n## Weak samples (headline ⟵ raw source)");
for (const [reason, set] of Object.entries(weakSamples)) {
  console.log(`\n  [${reason}]  (${reasonCounts[reason]})`);
  let n = 0;
  for (const s of set) { console.log(`    ${s}`); if (++n >= 12) break; }
}

console.log("\n## Agent/Task dispatch targets (truncated to 40 in feed)");
for (const s of agentPromptSamples.slice(0, 15)) console.log(`    ${s}`);
