#!/usr/bin/env node
// murmur-export: session receipts and replays straight from the state dir,
// no server required. A deliberately separate entry point from the MCP
// server: importing state.ts would adopt a session identity at import time,
// and a CLI must never do that.
//
//   murmur-export                          list exportable sessions
//   murmur-export <key|prefix>             write the narrative summary HTML
//   murmur-export <key> --data             write the dense data dump instead
//   murmur-export <key> --out <path>       choose the output path
//   murmur-export <key> --receipt          secret gist + receipt link on the
//                                          current branch's PR (gh required)
//   murmur-export <key> --receipt --pr <n> target a specific PR number
//   murmur-export <key> --no-redact        keep emails, keys, usernames, and
//                                          other PII the export scrubs by default
//
// Everything the document needs (styles, icons, transcript images) is inlined,
// so the file can be attached, gisted, or opened years later as-is.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listAllSessions, type PastSessionSummary } from "./discovery.js";
import { renderSessionHtml, type ExportKind } from "./export/render.js";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--pr", "--out"]);
const flags = new Set<string>();
const flagValues = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (VALUE_FLAGS.has(a)) {
    const v = args[++i];
    if (!v) fail(`${a} needs a value`);
    flagValues.set(a, v);
  } else if (a.startsWith("--")) {
    flags.add(a);
  } else {
    positional.push(a);
  }
}
const kind: ExportKind = flags.has("--data") ? "data" : "summary";

const prFlagValue = (): string | undefined => flagValues.get("--pr");
const outFlagValue = (): string | undefined => flagValues.get("--out");

function fail(message: string): never {
  console.error(`murmur-export: ${message}`);
  process.exit(1);
}

function gh(ghArgs: string[], input?: string): string {
  try {
    return execFileSync("gh", ghArgs, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      fail("the receipt flow needs the GitHub CLI (gh) on your PATH");
    }
    fail(`gh ${ghArgs[0]} failed: ${(e.stderr ?? e.message ?? "").trim()}`);
  }
}

async function listSessions(): Promise<void> {
  const sessions = await listAllSessions();
  if (sessions.length === 0) {
    console.log("No sessions on disk. Run a Claude Code session with Murmur active first.");
    return;
  }
  console.log(`${sessions.length} session(s):\n`);
  for (const s of sessions) {
    const label = s.title ?? s.cwdBasename ?? "";
    const started = s.startedAt ? s.startedAt.slice(0, 16).replace("T", " ") : "";
    console.log(
      `  ${s.key.slice(0, 8)}  ${started.padEnd(17)} ${String(s.activityCount).padStart(5)} events  ${label}`
    );
  }
  console.log("\nExport one with: murmur-export <key prefix>");
}

async function resolveKey(prefix: string): Promise<PastSessionSummary> {
  const sessions = await listAllSessions();
  const matches = sessions.filter((s) => s.key.startsWith(prefix));
  if (matches.length === 0) fail(`no session starts with "${prefix}"`);
  if (matches.length > 1) {
    fail(
      `"${prefix}" is ambiguous (${matches.length} matches): ${matches
        .map((m) => m.key.slice(0, 12))
        .join(", ")}`
    );
  }
  return matches[0]!;
}

function renderOrDie(key: string): string {
  const html = renderSessionHtml(key, kind, { redact: !flags.has("--no-redact") });
  if (html === null) fail(`could not read state for session ${key}`);
  return html;
}

async function exportToFile(prefix: string): Promise<void> {
  const session = await resolveKey(prefix);
  const html = renderOrDie(session.key);
  const out = resolve(
    outFlagValue() ?? `murmur-${session.key.slice(0, 8)}-${kind}.html`
  );
  writeFileSync(out, html);
  console.log(out);
}

// The receipt flow: a self-contained summary in a secret gist (visible to
// whoever has the link, which is exactly who can see the PR), plus a
// marker-guarded receipt line appended to the PR body. Re-running replaces
// the previous receipt block instead of stacking duplicates.
const RECEIPT_MARKER = "<!-- murmur:receipt -->";

async function receipt(prefix: string): Promise<void> {
  const session = await resolveKey(prefix);
  const html = renderOrDie(session.key);
  const tmp = mkdtempSync(join(tmpdir(), "murmur-receipt-"));
  const file = join(tmp, `murmur-receipt-${session.key.slice(0, 8)}.html`);
  writeFileSync(file, html);

  const label = session.title ?? session.cwdBasename ?? session.key.slice(0, 8);
  const gistUrl = gh(["gist", "create", file, "--desc", `Murmur receipt: ${label}`]);
  if (!gistUrl.startsWith("https://gist.github.com/")) {
    fail(`unexpected gh gist output: ${gistUrl}`);
  }
  // /raw redirects to the newest revision of the single file; htmlpreview
  // renders it in-browser so the receipt is one click away from readable.
  const previewUrl = `https://htmlpreview.github.io/?${gistUrl}/raw`;
  console.log(`receipt gist: ${gistUrl}`);
  console.log(`preview:      ${previewUrl}`);

  const prNumber = prFlagValue();
  if (flags.has("--no-pr")) return;
  let prJson: string;
  try {
    prJson = execFileSync(
      "gh",
      ["pr", "view", ...(prNumber ? [prNumber] : []), "--json", "number,body,url"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch {
    console.log(
      prNumber
        ? `PR ${prNumber} not found from this directory; receipt not attached.`
        : "No PR found for the current branch; receipt not attached (use --pr <n> or run from the PR's repo)."
    );
    return;
  }
  const pr = JSON.parse(prJson) as { number: number; body: string; url: string };
  const withoutOld = pr.body.includes(RECEIPT_MARKER)
    ? pr.body.slice(0, pr.body.indexOf(RECEIPT_MARKER)).trimEnd()
    : pr.body.trimEnd();
  const receiptBlock = `${RECEIPT_MARKER}\n---\n📟 [Murmur receipt](${gistUrl}) · [preview](${previewUrl}) — the full agent session behind this PR: every tool call, question, and permission decision.`;
  const newBody = `${withoutOld}\n\n${receiptBlock}\n`;
  gh(["pr", "edit", String(pr.number), "--body-file", "-"], newBody);
  console.log(`receipt appended to ${pr.url}`);
}

async function main(): Promise<void> {
  const target = positional[0];
  if (!target || flags.has("--list")) {
    await listSessions();
    return;
  }
  if (flags.has("--receipt")) {
    await receipt(target);
    return;
  }
  await exportToFile(target);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
