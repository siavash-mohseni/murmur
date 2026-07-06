// Standalone preview: fetches live Murmur state from a running instance,
// renders the Summary HTML via the real lib, writes the result to
// /tmp/murmur-summary-preview.html.
//
// Each Murmur session binds its own port (5173, 5174, 5175, ...). By default
// this script probes 5173-5180 and uses the first one that responds. To pick
// a specific instance:
//
//   bun run scripts/summary-preview.ts              # auto-discover
//   bun run scripts/summary-preview.ts 5174         # specific port
//   bun run scripts/summary-preview.ts --all        # render one preview per live instance
//   MURMUR_PORT=5175 bun run scripts/summary-preview.ts

import { writeFileSync } from "node:fs";
import { buildSummaryHtml, groupActivitiesIntoRounds } from "../src/lib/summary-html";

const DEFAULT_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180];

interface SessionMeta {
  port: number;
  url: string;
  sessionId: string;
  title?: string;
  cwdBasename?: string;
}

async function probe(port: number, timeoutMs = 500): Promise<SessionMeta | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/state`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const state = await res.json() as { sessionId?: string; sessionInfo?: { cwdBasename?: string } };
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      sessionId: state.sessionId ?? "?",
      cwdBasename: state.sessionInfo?.cwdBasename,
    };
  } catch {
    return null;
  }
}

async function discoverAll(): Promise<SessionMeta[]> {
  const results = await Promise.all(DEFAULT_PORTS.map((p) => probe(p)));
  return results.filter((x): x is SessionMeta => x !== null);
}

async function renderOne(meta: SessionMeta, outPath: string): Promise<void> {
  const [stateRes, sessionsRes] = await Promise.all([
    fetch(`${meta.url}/state`),
    fetch(`${meta.url}/sessions`),
  ]);
  const state = (await stateRes.json()) as Parameters<typeof buildSummaryHtml>[0]["state"];
  const sessions = (await sessionsRes.json()) as Parameters<typeof buildSummaryHtml>[0]["sessions"];
  const html = buildSummaryHtml({ state, sessions });
  writeFileSync(outPath, html);
  const rounds = state ? groupActivitiesIntoRounds(state.activities) : [];
  const label = meta.cwdBasename ? ` [${meta.cwdBasename}]` : "";
  console.log(`OK  :${meta.port}${label}  -> ${outPath}  (${html.length.toLocaleString()} bytes, ${rounds.length} rounds, ${state?.activities.length ?? 0} activities)`);
}

const args = process.argv.slice(2);
const wantAll = args.includes("--all");
const explicitPort = args.find((a) => /^\d{2,5}$/.test(a));
const envPort = process.env["MURMUR_PORT"];
const targetPort = explicitPort ?? envPort;

if (wantAll) {
  const all = await discoverAll();
  if (all.length === 0) {
    console.error("No live Murmur instances found on ports 5173-5180.");
    process.exit(1);
  }
  console.log(`Found ${all.length} live instance${all.length === 1 ? "" : "s"}:`);
  for (const meta of all) {
    const safeSlug = meta.cwdBasename?.replace(/[^A-Za-z0-9_-]/g, "_") ?? `port${meta.port}`;
    await renderOne(meta, `/tmp/murmur-summary-${safeSlug}.html`);
  }
} else if (targetPort) {
  const meta = await probe(Number(targetPort));
  if (!meta) {
    console.error(`No Murmur instance responding on port ${targetPort}.`);
    process.exit(1);
  }
  await renderOne(meta, "/tmp/murmur-summary-preview.html");
} else {
  // No explicit port: auto-discover, prefer the first live one.
  const all = await discoverAll();
  if (all.length === 0) {
    console.error("No live Murmur instances found on ports 5173-5180. Pass a port explicitly or start `bun run dev` in the murmur repo.");
    process.exit(1);
  }
  if (all.length > 1) {
    console.log(`Found ${all.length} live instances:`);
    for (const m of all) console.log(`  :${m.port}  ${m.cwdBasename ?? ""}  (${m.sessionId.slice(0, 8)})`);
    console.log(`Using :${all[0]!.port}. Pass an explicit port, MURMUR_PORT=, or --all to render them all.\n`);
  }
  await renderOne(all[0]!, "/tmp/murmur-summary-preview.html");
}
