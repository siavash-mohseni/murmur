import type { Activity } from "../shared-types.js";
import { escapeHtml, formatCount } from "../event-intent.js";
import { formatLocalTime } from "./time.js";
import type { ShareContext } from "./context.js";

// Dense, data-first HTML dump of the full session state. Pairs with the
// "Export" button and is the maintenance counterpart of buildSummaryHtml,
// which renders the same data but in a warm narrative layout.
export function buildExportHtml({ state, resolveImage }: ShareContext): string {
  if (!state) return "<!doctype html><html><body>no data</body></html>";
  const safe = escapeHtml;
  const fmtNum = formatCount;
  const si = state.sessionInfo;
  const ts = state.tokenStats;

  // Pre-split the activity feed by kind once, so the section bodies and their
  // header counts read from the same arrays instead of re-scanning the full
  // list per section.
  const agentActs = state.activities.filter(
    (a): a is Extract<Activity, { kind: "agent" }> => a.kind === "agent"
  );
  const hookActs = state.activities.filter(
    (a): a is Extract<Activity, { kind: "hook" }> => a.kind === "hook"
  );
  const promptActs = state.activities.filter(
    (a): a is Extract<Activity, { kind: "prompt" }> => a.kind === "prompt"
  );

  // ---- Session meta block ----
  const metaRows: [string, string][] = [
    ["Session", state.sessionId],
    ["Started", state.startedAt],
    ["Repo", si.cwdBasename ?? ""],
    ["Branch", si.branch ?? ""],
    ["cwd", si.cwd ?? ""],
    ["User", si.userName ?? ""],
    ["Model", si.model ?? ""],
    ["Modified files", si.modifiedFiles != null ? String(si.modifiedFiles) : ""],
  ];
  const metaHtml = metaRows
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `<tr><th>${safe(k)}</th><td>${safe(v)}</td></tr>`)
    .join("");

  // ---- Token stats ----
  const tokensHtml = ts
    ? `<table>
      <tr><th>Total tokens</th><td>${fmtNum(ts.totalTokens)}</td></tr>
      <tr><th>Input</th><td>${fmtNum(ts.inputTokens)}</td></tr>
      <tr><th>Output</th><td>${fmtNum(ts.outputTokens)}</td></tr>
      <tr><th>Cache read</th><td>${fmtNum(ts.cacheReadTokens)}</td></tr>
      <tr><th>Cache creation</th><td>${fmtNum(ts.cacheCreationTokens)}</td></tr>
      <tr><th>Context</th><td>${fmtNum(ts.lastContextTokens)} / ${fmtNum(ts.contextLimit)}</td></tr>
      <tr><th>Turns</th><td>${ts.messageCount}</td></tr>
    </table>`
    : `<p class="muted">No token stats recorded.</p>`;

  // ---- Progress rows ----
  const rowsHtml = state.rows
    .map(
      (r) =>
        `<tr><td>${safe(r.status)}</td><td>${safe(r.label)}</td><td>${safe(r.detail ?? "")}</td></tr>`
    )
    .join("");

  // ---- Activities (all, not last 200) ----
  const actsHtml = state.activities
    .map((a) => {
      const time = safe(formatLocalTime(a.timestamp));
      const kind = safe(a.kind);
      const detail = a.kind === "tool"
        ? `${safe(a.tool)} ${safe(a.target ?? "")}`
        : a.kind === "agent"
          ? `${safe(a.subagentType ?? "")} ${safe(a.description)}`
          : a.kind === "prompt"
            ? `${safe(a.source)} ${safe(a.question)}${a.answer ? " → " + safe(a.answer) : ""}`
            : a.kind === "hook"
              ? `${safe(a.hook)} ${safe(a.detail ?? a.event ?? "")}`
              : a.kind === "log"
                ? safe(a.message)
                : a.kind === "warn"
                  ? safe(a.message)
                  : "";
      return `<tr><td>${time}</td><td>${kind}</td><td>${detail}</td></tr>`;
    })
    .join("");

  // ---- Memory entries ----
  const memHtml = state.memoryEntries
    .map(
      (m) =>
        `<tr><td>${safe(m.name)}</td><td>${safe(m.type ?? "")}</td><td>${safe(m.description ?? "")}</td><td>${m.thisSession ? "this session" : ""}</td><td>${safe(formatLocalTime(m.modifiedAt))}</td></tr>`
    )
    .join("");

  // ---- Tool breakdown ----
  const toolCounts = new Map<string, number>();
  state.activities.forEach((a) => {
    if (a.kind === "tool") {
      toolCounts.set(a.tool, (toolCounts.get(a.tool) ?? 0) + 1);
    }
  });
  const toolBreakdownHtml = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<tr><td>${safe(t)}</td><td>${n}</td></tr>`)
    .join("");

  // ---- Files touched (Edit/Write/MultiEdit targets) ----
  const fileEdits = new Map<string, number>();
  state.activities.forEach((a) => {
    if (a.kind === "tool" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(a.tool) && a.target) {
      fileEdits.set(a.target, (fileEdits.get(a.target) ?? 0) + 1);
    }
  });
  const filesHtml = Array.from(fileEdits.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `<tr><td>${safe(p)}</td><td>${n}</td></tr>`)
    .join("");

  // ---- Sub-agents (Agent / Task) ----
  const agentsHtml = agentActs
    .map(
      (a) =>
        `<tr><td>${safe(formatLocalTime(a.timestamp))}</td><td>${safe(a.subagentType ?? "")}</td><td>${safe(a.description)}</td><td>${a.durationMs != null ? a.durationMs + "ms" : ""}</td></tr>`
    )
    .join("");

  // ---- Hooks fired ----
  const hooksHtml = hookActs
    .map(
      (a) =>
        `<tr><td>${safe(formatLocalTime(a.timestamp))}</td><td>${safe(a.hook)}</td><td>${safe(a.event ?? "")}</td><td>${safe(a.detail ?? "")}</td></tr>`
    )
    .join("");

  // ---- Transcript images (inlined as data URIs when a resolver is given,
  // i.e. by the server route and the CLI; the browser Share button has no
  // filesystem access and skips them) ----
  const imageCards = resolveImage
    ? promptActs.flatMap((a) =>
        (a.images ?? []).flatMap((img) => {
          const src = resolveImage(img);
          if (!src) return [];
          return [
            `<figure class="img-card"><img src="${src}" alt="${safe(img.alt ?? "transcript image")}" loading="lazy" /><figcaption>${safe(formatLocalTime(a.timestamp))} · ${safe(img.source)}</figcaption></figure>`,
          ];
        })
      )
    : [];
  const imagesSection = imageCards.length
    ? `<h2>Images (${imageCards.length})</h2>\n<div class="imgs">${imageCards.join("")}</div>\n`
    : "";

  // ---- Prompts answered ----
  const promptsHtml = promptActs
    .map(
      (a) =>
        `<tr><td>${safe(formatLocalTime(a.timestamp))}</td><td>${safe(a.source)}</td><td>${safe(a.question)}</td><td>${safe(a.answer ?? "")}</td><td>${a.ok === false ? "denied" : a.ok === true ? "ok" : ""}</td></tr>`
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Murmur session ${safe(state.sessionId.slice(0, 8))}</title><style>
body{font:14px/1.5 system-ui;background:#09090b;color:#fafafa;margin:0;padding:2rem;max-width:80rem;margin-inline:auto}
h1,h2{font-weight:600}
h1{font-size:1.5rem;border-bottom:1px solid #27272a;padding-bottom:.5rem}
h2{margin-top:2rem;font-size:1.1rem;border-bottom:1px solid #27272a;padding-bottom:.3rem}
table{width:100%;border-collapse:collapse;font-size:.85em;margin-top:.5rem}
th,td{padding:.4rem .6rem;text-align:left;border-bottom:1px solid #27272a;vertical-align:top}
th{color:#a1a1aa;font-weight:500;text-transform:uppercase;font-size:11px}
.meta{color:#a1a1aa;font-size:.85em}
.muted{color:#71717a;font-style:italic}
code,pre{background:#18181b;padding:.1em .3em;border-radius:.2em;font-size:.85em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{padding:.6rem .8rem;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word;margin:.4rem 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:50rem){.grid{grid-template-columns:1fr}}
.imgs{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:.5rem}
.img-card{margin:0}
.img-card img{max-width:320px;max-height:240px;border:1px solid #27272a;border-radius:.4rem;object-fit:contain;background:#18181b}
.img-card figcaption{color:#71717a;font-size:11px;margin-top:.25rem}
</style></head><body>
<h1>Murmur session ${safe(state.sessionId.slice(0, 8))}</h1>
<p class="meta">${safe(si.branch ?? "")} · ${safe(si.cwdBasename ?? "")} · started ${safe(state.startedAt)}</p>

<h2>Session</h2>
<table>${metaHtml}</table>

<h2>Tokens</h2>
${tokensHtml}

<h2>Progress (${state.rows.length})</h2>
<table><thead><tr><th>Status</th><th>Phase / Gate</th><th>Detail</th></tr></thead><tbody>${rowsHtml || `<tr><td colspan=3 class=muted>No rows.</td></tr>`}</tbody></table>

<div class="grid">
  <div>
    <h2>Tool breakdown</h2>
    <table><thead><tr><th>Tool</th><th>Count</th></tr></thead><tbody>${toolBreakdownHtml || `<tr><td colspan=2 class=muted>No tool calls.</td></tr>`}</tbody></table>
  </div>
  <div>
    <h2>Files touched (${fileEdits.size})</h2>
    <table><thead><tr><th>Path</th><th>Edits</th></tr></thead><tbody>${filesHtml || `<tr><td colspan=2 class=muted>No file edits.</td></tr>`}</tbody></table>
  </div>
</div>

<h2>Sub-agents (${agentActs.length})</h2>
<table><thead><tr><th>Time</th><th>Type</th><th>Description</th><th>Duration</th></tr></thead><tbody>${agentsHtml || `<tr><td colspan=4 class=muted>No sub-agents.</td></tr>`}</tbody></table>

<h2>Prompts answered (${promptActs.length})</h2>
<table><thead><tr><th>Time</th><th>Source</th><th>Question</th><th>Answer</th><th>Status</th></tr></thead><tbody>${promptsHtml || `<tr><td colspan=5 class=muted>No prompts.</td></tr>`}</tbody></table>

${imagesSection}<h2>Hooks (${hookActs.length})</h2>
<table><thead><tr><th>Time</th><th>Hook</th><th>Event</th><th>Detail</th></tr></thead><tbody>${hooksHtml || `<tr><td colspan=4 class=muted>No hooks fired.</td></tr>`}</tbody></table>

<h2>Memory (${state.memoryEntries.length})</h2>
<table><thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Origin</th><th>Modified</th></tr></thead><tbody>${memHtml || `<tr><td colspan=5 class=muted>No memory entries.</td></tr>`}</tbody></table>

<h2>Activity feed (${state.activities.length})</h2>
<table><thead><tr><th>Time</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${actsHtml || `<tr><td colspan=3 class=muted>No activity.</td></tr>`}</tbody></table>
</body></html>`;
}
