// Turns a captured Claude reply (the `outline` field, see messageOutline in
// src/assistant-text.ts) into a semantic structure the owner timeline can
// render visually: a lead line, then groups of items where each group and each
// item carry a kind (a change, a decision, a verification result, a warning, or
// a plain note). The point is to let an owner SEE the shape of what Claude did
// and decided, instead of reading a wall of text.
//
// Pure and framework-free so the heuristics are testable without React.

import type { OwnerTone } from "@/lib/owner-language";

export type SegmentKind = "change" | "decision" | "verification" | "warning" | "note";

export interface MessageItem {
  kind: SegmentKind;
  // A short leading word or label pulled to the front as a chip ("Removed",
  // "Kept", "compliance.ts"), when the item starts with a recognizable verb or
  // a "label: value" shape. Undefined when there is nothing worth lifting.
  chip?: string;
  // The remaining item text after the chip is lifted (the full text when there
  // is no chip).
  text: string;
}

export interface MessageGroup {
  kind: SegmentKind;
  // The section heading when the outline had one ("Two deliberate decisions",
  // "Verification"), otherwise a derived label ("Changes", "Decisions").
  heading: string;
  items: MessageItem[];
}

export interface ParsedMessage {
  // The opening sentence/paragraph, shown above the groups.
  lead?: string;
  groups: MessageGroup[];
  // A short closing status line when the reply ended on one ("Nothing pushed.",
  // "All checks passed.").
  outcome?: string;
  // True when there is enough structure (a group with 2+ items, or 2+ groups)
  // to justify the rich rendering. When false the caller shows the plain bubble.
  structured: boolean;
}

// ---- Tone + label per segment kind (owner palette, no new colors) ----

export function segmentTone(kind: SegmentKind): OwnerTone {
  if (kind === "change") return "blue";
  if (kind === "decision") return "amber";
  if (kind === "verification") return "emerald";
  if (kind === "warning") return "rose";
  return "zinc";
}

export function segmentGroupLabel(kind: SegmentKind): string {
  if (kind === "change") return "What changed";
  if (kind === "decision") return "Decisions";
  if (kind === "verification") return "Checks";
  if (kind === "warning") return "Watch outs";
  return "Notes";
}

// ---- Classification vocabularies ----

// Past-tense action verbs that open a "what changed" bullet. Matched on the
// first word, case-insensitively.
const ACTION_VERBS = new Set([
  "added",
  "removed",
  "deleted",
  "cut",
  "dropped",
  "turned",
  "reframed",
  "edited",
  "created",
  "built",
  "fixed",
  "updated",
  "merged",
  "moved",
  "replaced",
  "renamed",
  "split",
  "extracted",
  "wired",
  "wrapped",
  "switched",
  "changed",
  "introduced",
  "refactored",
  "rewrote",
  "stripped",
  "trimmed",
  "adjusted",
  "applied",
  "implemented",
]);

// Verbs that signal a deliberate choice rather than a mechanical change.
const DECISION_VERBS = new Set([
  "kept",
  "left",
  "chose",
  "decided",
  "opted",
  "went",
  "skipped",
  "avoided",
  "preferred",
  "stayed",
  "deferred",
  "ignored",
]);

const VERIFICATION_HINTS = [
  "passed",
  "pass",
  "0 errors",
  "no errors",
  "verified",
  "verification",
  "green",
  "all checks",
  "tests",
  "test ",
  "typecheck",
  "lint",
  "built in",
  "✓",
  "exit 0",
];

const WARNING_HINTS = [
  "warning",
  "failed",
  "couldn't",
  "can't",
  "cannot",
  "broke",
  "regress",
  "issue",
  "problem",
  "still flag",
];

function headingKind(heading: string): SegmentKind | undefined {
  const h = heading.toLowerCase();
  if (/(decision|deliberate|trade-?off|chose|choice)/.test(h)) return "decision";
  if (/(verif|test|check|result|confirm)/.test(h)) return "verification";
  if (/(warn|caveat|risk|known issue|gotcha)/.test(h)) return "warning";
  if (/(change|did|done|what|step|fix|update)/.test(h)) return "change";
  return undefined;
}

function itemKind(text: string): SegmentKind {
  const lower = text.toLowerCase();
  const firstWord = (lower.match(/^[a-z]+/) ?? [""])[0];
  if (DECISION_VERBS.has(firstWord)) return "decision";
  if (ACTION_VERBS.has(firstWord)) return "change";
  if (WARNING_HINTS.some((h) => lower.includes(h))) return "warning";
  if (VERIFICATION_HINTS.some((h) => lower.includes(h))) return "verification";
  return "note";
}

// ---- Line classification ----

interface Line {
  raw: string;
  // The marker-stripped content.
  content: string;
  type: "heading" | "bullet" | "numbered" | "text";
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;

function stripInlineMarks(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .trim();
}

function classifyLine(raw: string): Line {
  const bullet = raw.match(BULLET_RE);
  if (bullet) return { raw, content: stripInlineMarks(bullet[1]), type: "bullet" };
  const numbered = raw.match(NUMBERED_RE);
  if (numbered) return { raw, content: stripInlineMarks(numbered[1]), type: "numbered" };
  const trimmed = stripInlineMarks(raw.trim());
  // A short line ending in a colon is a section heading ("Two deliberate
  // decisions:", "Verification, all fresh:"). Cap the length so a normal
  // sentence that happens to contain a colon is not mistaken for a heading.
  if (/:\s*$/.test(trimmed) && trimmed.length <= 60) {
    return { raw, content: trimmed.replace(/:\s*$/, ""), type: "heading" };
  }
  return { raw, content: trimmed, type: "text" };
}

// ---- Item building ----

// Lift a leading chip from an item: a recognized opening verb, or a short
// "label: value" prefix. Returns the chip plus the remaining text.
function liftChip(text: string): { chip?: string; text: string } {
  const firstWordMatch = text.match(/^([A-Za-z]+)\b/);
  const firstWord = firstWordMatch?.[1]?.toLowerCase() ?? "";
  if (ACTION_VERBS.has(firstWord) || DECISION_VERBS.has(firstWord)) {
    const rest = text.slice(firstWordMatch![1].length).replace(/^\s+/, "");
    if (rest.length > 0) return { chip: capitalize(firstWord), text: rest };
  }
  // "label: value" where the label is short and value is substantial.
  const colon = text.match(/^([^:]{2,28}):\s+(\S.*)$/);
  if (colon && !/\s{2,}/.test(colon[1])) {
    return { chip: colon[1].trim(), text: colon[2].trim() };
  }
  return { text };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function buildItem(content: string, forcedKind?: SegmentKind): MessageItem {
  const { chip, text } = liftChip(content);
  const kind = forcedKind ?? itemKind(content);
  return { kind, chip, text };
}

// A group's kind is its heading's kind when the heading implies one, else the
// most common item kind (ties resolved by a fixed priority).
function groupKind(headingHint: SegmentKind | undefined, items: MessageItem[]): SegmentKind {
  if (headingHint) return headingHint;
  const counts = new Map<SegmentKind, number>();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const priority: SegmentKind[] = ["decision", "warning", "change", "verification", "note"];
  let best: SegmentKind = "note";
  let bestCount = -1;
  for (const k of priority) {
    const c = counts.get(k) ?? 0;
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

// A closing single line that reads as a status conclusion, not a section.
function isOutcomeLine(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length > 90) return false;
  return /(nothing pushed|nothing committed|all (checks|tests).*(pass|green)|ready (to|for)|done\.?$|no changes pushed|not pushed)/.test(
    t
  );
}

export function parseMessageStructure(outline: string): ParsedMessage {
  const rawLines = outline.split("\n");
  const lines = rawLines.map(classifyLine).filter((l) => l.content.length > 0);

  let lead: string | undefined;
  let outcome: string | undefined;
  const groups: MessageGroup[] = [];

  // Open group accumulator.
  let heading: string | undefined;
  let headingHint: SegmentKind | undefined;
  let items: MessageItem[] = [];
  // A heading's items inherit its kind so a list under "Decisions" all read as
  // decisions even when an individual line lacks a decision verb.
  let forcedKind: SegmentKind | undefined;

  function flush(): void {
    if (items.length === 0) {
      // A heading with no items is dropped (it carried no list).
      heading = undefined;
      headingHint = undefined;
      forcedKind = undefined;
      return;
    }
    const kind = groupKind(headingHint, items);
    groups.push({
      kind,
      heading: heading ?? segmentGroupLabel(kind),
      items,
    });
    heading = undefined;
    headingHint = undefined;
    forcedKind = undefined;
    items = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === "heading") {
      flush();
      heading = line.content;
      headingHint = headingKind(line.content);
      forcedKind = headingHint;
      continue;
    }
    if (line.type === "bullet" || line.type === "numbered") {
      items.push(buildItem(line.content, forcedKind));
      continue;
    }
    // Plain text line. Before any group/items it is the lead. A trailing plain
    // line after items may be an outcome line; otherwise it closes the current
    // group and stands alone as a note-less paragraph we fold into the lead or
    // outcome.
    if (items.length === 0 && groups.length === 0 && !heading) {
      lead = lead ? `${lead} ${line.content}` : line.content;
      continue;
    }
    if (isOutcomeLine(line.content)) {
      flush();
      outcome = line.content;
      continue;
    }
    // A non-heading paragraph between sections: treat as a one-item note group
    // only when it is reasonably long, else ignore (it is usually connective
    // tissue like "Two things:" without a colon).
    if (line.content.length >= 40) {
      flush();
      items.push(buildItem(line.content));
      flush();
    }
  }
  flush();

  const structured =
    groups.some((g) => g.items.length >= 2) || groups.length >= 2;

  return { lead, groups, outcome, structured };
}

// ---- Narration beats (single-line "Now the X: do Y" status lines) ----
//
// Between tool calls Claude narrates the next step ("Now the test file: remove
// the knob and rewrite the AC3 test"). These are single-line, so they never
// reach parseMessageStructure (no sections) and read as a wall of near-identical
// sentences. parseNarration lifts the work area into a chip and strips the "Now
// the ..." framing so each beat shows the area and the direction at a glance.

export interface NarrationBeat {
  // The work area lifted from "Now the <scope>:" framing, shown as a chip.
  // Undefined when the line had no clear area (a bare "Now applying ...").
  scope?: string;
  // The action, with the "Now [the] <scope>:" and any leading completion
  // clause stripped, so it reads as a direct step.
  text: string;
  kind: SegmentKind;
}

// Present-tense / imperative verbs that open a narration line. ACTION_VERBS and
// friends above are past tense (the recap voice); narration is the live voice,
// so it needs its own vocabulary.
const PRESENT_CHANGE = new Set([
  "add", "adding", "remove", "removing", "delete", "deleting", "cut", "cutting",
  "drop", "dropping", "update", "updating", "replace", "replacing", "rewrite",
  "rewriting", "edit", "editing", "fix", "fixing", "move", "moving", "rename",
  "renaming", "split", "splitting", "extract", "extracting", "wire", "wiring",
  "wrap", "wrapping", "switch", "switching", "change", "changing", "introduce",
  "introducing", "refactor", "refactoring", "strip", "stripping", "trim",
  "trimming", "adjust", "adjusting", "apply", "applying", "implement",
  "implementing", "derive", "deriving", "create", "creating", "build",
  "building", "set", "setting", "write", "writing", "pull", "pulling",
]);

const PRESENT_VERIFY = new Set([
  "validate", "validating", "verify", "verifying", "run", "running", "test",
  "testing", "check", "checking", "analyze", "analyzing", "analyse",
  "analysing", "confirm", "confirming", "fetch", "fetching", "ensure",
  "ensuring",
]);

function narrationKind(action: string): SegmentKind {
  const firstWord = (action.toLowerCase().match(/^[a-z]+/) ?? [""])[0];
  if (PRESENT_VERIFY.has(firstWord)) return "verification";
  if (PRESENT_CHANGE.has(firstWord)) return "change";
  return itemKind(action);
}

// "Now the <scope>: <action>" or "Now the <scope>. <action>". The scope is at
// most four words and is captured non-greedily up to the first colon or period.
const NARRATION_SCOPE_RE =
  /^now,?\s+(?:the\s+)?([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,3}?)\s*[:.]\s+(.+)$/i;
// A bare "Now <action>" pivot, optionally after a completion clause ("All files
// read. Now applying ...").
const NARRATION_PIVOT_RE = /(?:^|\.\s+)now\b\s+(.+)$/i;
// A linking verb or modal in the captured scope means it is the start of a
// sentence, not a work-area label, so the scoped shape is rejected.
const SCOPE_REJECT_RE = /\b(is|are|was|were|be|will|would|has|have|had|can|could|should|do|does)\b/i;

function trimTrailingPeriod(s: string): string {
  return s.replace(/\s*\.\s*$/, "");
}

export function parseNarration(raw: string): NarrationBeat | null {
  const s = stripInlineMarks(raw).replace(/`/g, "").trim();
  if (!s) return null;
  // Only reshape lines that pivot on "Now" (the narration signature). Anything
  // else stays a plain bubble.
  if (!/^now\b|\.\s+now\b/i.test(s)) return null;

  const scoped = s.match(NARRATION_SCOPE_RE);
  if (scoped) {
    const scope = scoped[1].trim();
    const action = scoped[2].trim();
    if (scope.length <= 32 && action.length > 0 && !SCOPE_REJECT_RE.test(scope)) {
      return { scope, text: trimTrailingPeriod(action), kind: narrationKind(action) };
    }
  }

  const pivot = s.match(NARRATION_PIVOT_RE);
  if (pivot) {
    let action = pivot[1].trim();
    const firstWord = (action.toLowerCase().match(/^[a-z]+/) ?? [""])[0];
    // Accept only a gerund ("applying") or "let me/us <verb>" so a non-narration
    // sentence that merely contains "now" is not mangled.
    if (firstWord.endsWith("ing") || firstWord === "let") {
      if (firstWord === "let") action = action.replace(/^let\s+(?:me|us)\s+/i, "");
      if (action.length > 0) return { text: trimTrailingPeriod(action), kind: narrationKind(action) };
    }
  }

  return null;
}

// ---- Whole-beat classification (for the owner timeline's chat bubbles) ----
//
// classifyBeat looks at one single-line Claude message and decides what KIND of
// beat it is, so the bubble can carry a matching icon and a colored accent and
// the timeline reads as more than a column of identical gray bubbles.
// parseNarration handles the "Now the X:" chip case, classifyBeat is the broad
// net over everything else ("Let me read ...", "Phase 2 complete ... ✓",
// observations, problems).

export type BeatKind = "action" | "finding" | "check" | "decision" | "warning" | "plain";

export interface Beat {
  kind: BeatKind;
  // A work-area chip lifted from "Now the <scope>:" framing, when present.
  scope?: string;
  // The message with live-voice framing ("Let me", "Now") stripped.
  text: string;
}

export function beatTone(kind: BeatKind): OwnerTone {
  if (kind === "action") return "blue";
  if (kind === "check") return "emerald";
  if (kind === "decision") return "amber";
  if (kind === "warning") return "rose";
  return "zinc"; // finding + plain
}

// Live-voice openers that announce the next step. Stripped so the bubble reads
// as the action itself ("Inspect the Widgetbook structure") rather than the
// announcement ("Let me inspect the Widgetbook structure").
const ACTION_OPENERS: RegExp[] = [
  /^let me\s+/i,
  /^let'?s\s+/i,
  /^i'?ll\s+/i,
  /^i will\s+/i,
  /^i'?m going to\s+/i,
  /^i am going to\s+/i,
  /^going to\s+/i,
  /^time to\s+/i,
  /^next,?\s+(?:i'?ll\s+|let me\s+)?/i,
  /^then,?\s+(?:i'?ll\s+|let me\s+)?/i,
];

const CHECK_RE =
  /[✓✔]|\b(complete|completed|passes|passed|all clean|all green|exit 0|no errors|0 errors|tests? pass(?:ed|ing)?|verified)\b/i;
const FINDING_RE = /\b(is|are|uses?|has|have|had|found|turns out|there'?s|there is|there are|already|exists?|contains?)\b/i;
const DECISION_RE = /\b(decided to|chose to|going with|opted to|keeping|will keep|leaving)\b/i;

function capFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// True when a captured message is mostly a markdown table (the progress
// dashboard re-emit). Flattened to one line it reads as "| Status | Phase | ...
// |---|---| | done | ...", which is noise in the owner timeline and duplicates
// the run rows already shown. The caller drops these as beats.
export function isTableDump(text: string | undefined): boolean {
  if (!text) return false;
  const pipes = (text.match(/\|/g) ?? []).length;
  const hasSeparator = /\|\s*:?-{3,}|-{3,}:?\s*\||-{5,}/.test(text);
  return pipes >= 6 && hasSeparator;
}

export function classifyBeat(raw: string): Beat {
  const s = stripInlineMarks(raw).replace(/`/g, "").trim();
  if (!s) return { kind: "plain", text: raw.trim() };

  // A problem wins over everything.
  if (WARNING_HINTS.some((h) => s.toLowerCase().includes(h))) {
    return { kind: "warning", text: trimTrailingPeriod(s) };
  }

  // Live action: "Now the X: ..." (with a work-area chip) or a "Let me / I'll /
  // Next ..." opener.
  const narration = parseNarration(s);
  if (narration) {
    const text = narration.scope ? narration.text : capFirst(narration.text);
    return { kind: "action", scope: narration.scope, text };
  }
  for (const re of ACTION_OPENERS) {
    if (re.test(s)) {
      const text = trimTrailingPeriod(s.replace(re, "").trim());
      if (text) return { kind: "action", text: capFirst(text) };
    }
  }

  // Completion / verification status, often carrying inline checkmarks.
  if (CHECK_RE.test(s)) return { kind: "check", text: trimTrailingPeriod(s) };

  // Deliberate choice.
  const firstWord = (s.toLowerCase().match(/^[a-z']+/) ?? [""])[0];
  if (DECISION_VERBS.has(firstWord) || DECISION_RE.test(s)) {
    return { kind: "decision", text: trimTrailingPeriod(s) };
  }

  // Observation / finding.
  if (FINDING_RE.test(s)) return { kind: "finding", text: trimTrailingPeriod(s) };

  return { kind: "plain", text: trimTrailingPeriod(s) };
}

// ---- Semantic icon for a beat (the owner timeline's spine markers) ----
//
// The kind alone (action / finding / ...) gives only a generic icon. beatIcon
// looks at WHAT the beat is about, the activity (editing, testing, building,
// git, deploying) or the subject (a database, an API, styling), and returns a
// more specific marker. It only refines action and finding beats, where the
// kind icon is generic. check, decision, and warning keep their outcome icon so
// "done", "a choice", and "caution" stay unambiguous at a glance.

export type BeatIconKey =
  | "edit"
  | "create"
  | "delete"
  | "search"
  | "read"
  | "test"
  | "build"
  | "install"
  | "git"
  | "deploy"
  | "config"
  | "data"
  | "network"
  | "docs"
  | "style"
  | "fix"
  | "bug"
  | "action"
  | "check"
  | "decision"
  | "warning"
  | "finding";

// First match wins, so the order is salience: domain activities (test, deploy,
// git) and subjects (data, network, style) ahead of generic verbs (edit, fix),
// which would otherwise swallow them ("update the tests" is testing, not a
// generic edit).
const ICON_RULES: Array<[BeatIconKey, RegExp]> = [
  ["test", /\b(tests?|testing|specs?|jest|vitest|pytest|coverage|smoke test)\b/i],
  ["deploy", /\b(deploy(?:ing|ed|s|ment)?|releas(?:e|ing|ed)|ship(?:ping|ped)?|publish(?:ing|ed)?|roll(?:ing)?\s?out)\b/i],
  ["git", /\b(git|commit(?:ting|ted|s)?|branch(?:es|ing)?|merg(?:e|ing|ed)|rebas(?:e|ing|ed)|push(?:ing|ed)?|pull request|PRs?)\b/i],
  ["install", /\b(install(?:ing|ed|s)?|dependenc(?:y|ies)|npm i\b|yarn add|bun add|node_modules)\b/i],
  ["build", /\b(build(?:ing|s)?|rebuild(?:ing)?|compil(?:e|ing|ed)|bundl(?:e|ing|ed)|tsc|webpack|vite)\b/i],
  ["data", /\b(database|db\b|sql|quer(?:y|ies)|schema|migrations?|tables?|seed(?:ing|ed)?)\b/i],
  ["network", /\b(api|endpoints?|requests?|fetch(?:ing|ed)?|https?\b|servers?|routes?|urls?|webhooks?)\b/i],
  ["style", /\b(styl(?:e|es|ing)|css|tailwind|layout|themes?|colou?rs?|spacing|padding|margins?|design)\b/i],
  ["docs", /\b(readme|docs?|documentation|comments?|changelog|write[- ]?ups?)\b/i],
  ["config", /\b(config(?:ure|ured|uration|s)?|settings?|\.env\b|env vars?|setup|options?|flags?)\b/i],
  ["delete", /\b(delet(?:e|ing|ed)|remov(?:e|ing|ed)|drop(?:ping|ped)?|clean(?:ing)?\s?up|prun(?:e|ing|ed))\b/i],
  ["search", /\b(search(?:ing|ed)?|find(?:ing)?|look(?:ing)?\s+for|grep|locat(?:e|ing|ed)|scan(?:ning|ned)?|explor(?:e|ing|ed)|trac(?:e|ing)\s+down)\b/i],
  ["read", /\b(read(?:ing)?|inspect(?:ing|ed)?|review(?:ing|ed)?|examin(?:e|ing|ed)|look(?:ing)?\s+at)\b/i],
  ["create", /\b(creat(?:e|ing|ed)|add(?:ing|ed)?|new file|scaffold(?:ing|ed)?|generat(?:e|ing|ed)|set\s?up)\b/i],
  ["fix", /\b(fix(?:ing|ed|es)?|resolv(?:e|ing|ed)|repair(?:ing|ed)?|patch(?:ing|ed)?|correct(?:ing|ed)?)\b/i],
  ["bug", /\b(bugs?|errors?|exceptions?|crash(?:ing|ed|es)?|broken|fail(?:ure|ing|ed|s)?|stack trace)\b/i],
  ["edit", /\b(edit(?:ing|ed|s)?|updat(?:e|ing|ed)|chang(?:e|ing|ed)|modif(?:y|ying|ied)|rewrit(?:e|ing)|refactor(?:ing|ed)?|replac(?:e|ing|ed)|adjust(?:ing|ed)?|tweak(?:ing|ed)?|renam(?:e|ing|ed))\b/i],
];

export function beatIcon(beat: Beat): BeatIconKey {
  if (beat.kind === "warning") return "warning";
  if (beat.kind === "decision") return "decision";
  if (beat.kind === "check") return "check";
  const hay = `${beat.scope ?? ""} ${beat.text}`;
  for (const [key, re] of ICON_RULES) {
    if (re.test(hay)) return key;
  }
  return beat.kind === "finding" ? "finding" : "action";
}
