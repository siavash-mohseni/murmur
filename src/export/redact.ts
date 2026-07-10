// PII redaction for session content that leaves the machine: server and CLI
// exports, gist receipts, hosted replays, and the browser Share buttons.
// Browser-safe (no node imports) so the web bundle applies the identical
// rules through a shim, like model-caps.ts.
//
// The rules are deliberately conservative. Export content is mostly code,
// diffs, and tool output, where aggressive detectors (entropy scans, phone
// patterns, bare-word heuristics) would corrupt legitimate text: a diff line
// starting with "+" followed by digits looks exactly like a phone number,
// and a git SHA looks exactly like a high-entropy secret. Only shapes that
// are near-certain PII or credentials are rewritten. Screenshots inlined as
// data URIs are not scrubbed: redaction covers text only.

import type { DashboardState, SessionSummary } from "../shared-types.js";
import type { ShareContext } from "./context.js";

// Vendor-specific credential shapes, each unambiguous enough to rewrite on
// sight. JWT runs first so its three-segment form is tagged as a JWT rather
// than swallowed by the generic Bearer rule.
const TOKEN_RULES: { re: RegExp; sub: string }[] = [
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, sub: "[redacted-jwt]" },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, sub: "[redacted-key]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, sub: "[redacted-key]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, sub: "[redacted-key]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, sub: "[redacted-key]" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, sub: "[redacted-key]" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, sub: "[redacted-key]" },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, sub: "$1[redacted-token]" },
];

// key: value / key=value assignments for secret-named keys. The value must
// contain a digit and must not end at a word character or "(", so code like
// `password: hashPassword(input)` survives while literal credentials do not.
const ASSIGNED_SECRET_RE =
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd)["']?\s*[:=]+\s*["']?)(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{8,}(?![\w(])/gi;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const HOME_DIR_RULES: { re: RegExp; sub: string }[] = [
  { re: /(\/(?:Users|home)\/)([A-Za-z0-9._-]+)/g, sub: "$1USER" },
  { re: /([A-Za-z]:\\Users\\)([^\\/:*?"<>|\s]+)/g, sub: "$1USER" },
];

// Word-char and dot lookarounds keep version-like strings (v1.2.3.4) and
// longer dotted runs out. Loopback and {0,255}-only addresses (0.0.0.0,
// netmasks, broadcast) stay: they appear constantly in Murmur's own logs
// and identify nothing.
const IPV4_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g;

// Candidate card numbers: 13 to 19 digits, optionally grouped by spaces or
// dashes, not embedded in a longer word/dash run (so UUID segments and hex
// hashes never match). Confirmed only by Luhn plus a real-network first
// digit, which keeps epoch timestamps (leading 1) and random IDs intact.
const CARD_RE = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactIps(text: string): string {
  return text.replace(IPV4_RE, (match, a: string, b: string, c: string, d: string) => {
    const octets = [a, b, c, d].map(Number);
    if (octets.some((o) => o > 255)) return match;
    if (octets[0] === 127) return match;
    if (octets.every((o) => o === 0 || o === 255)) return match;
    return "[redacted-ip]";
  });
}

function redactCards(text: string): string {
  return text.replace(CARD_RE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (digits[0]! < "2" || digits[0]! > "6") return match;
    return luhnValid(digits) ? "[redacted-card]" : match;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apply every redaction rule to one string. extraNames are literal
 * identifiers (machine usernames and their slug forms) replaced with USER
 * wherever they appear outside a longer alphanumeric run. */
export function redactText(text: string, extraNames: string[] = []): string {
  let out = text;
  for (const rule of TOKEN_RULES) out = out.replace(rule.re, rule.sub);
  out = out.replace(ASSIGNED_SECRET_RE, "$1[redacted-secret]");
  out = out.replace(EMAIL_RE, "[redacted-email]");
  for (const rule of HOME_DIR_RULES) out = out.replace(rule.re, rule.sub);
  for (const name of extraNames) {
    if (name.length < 3) continue;
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, "gi"),
      "USER"
    );
  }
  out = redactIps(out);
  out = redactCards(out);
  return out;
}

/** Machine usernames worth scrubbing as literals, pulled from the session
 * cwds. Includes the dot-to-dash slug form because Claude Code project slugs
 * (~/.claude/projects/-Users-jane-doe-...) carry the username with its dots
 * rewritten, where the path rule cannot see it, plus each name segment of 4+
 * characters so a bare first or last name (in a grep argument, a regex
 * alternation, a git author) is caught on its own. Longest first, so the
 * full name is replaced as one unit before its segments are tried. */
export function deriveNameTokens(
  state: DashboardState | null,
  sessions: SessionSummary[] = []
): string[] {
  const out = new Set<string>();
  const cwds = [state?.sessionInfo?.cwd, ...sessions.map((s) => s.cwd)];
  for (const cwd of cwds) {
    const m = /^\/(?:Users|home)\/([A-Za-z0-9._-]+)/.exec(cwd ?? "");
    const name = m?.[1];
    if (!name || name.length < 3) continue;
    out.add(name);
    const slug = name.replace(/\./g, "-");
    if (slug !== name) out.add(slug);
    for (const seg of name.split(/[._-]+/)) {
      if (seg.length >= 4) out.add(seg);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function deepRedact(value: unknown, names: string[]): unknown {
  if (typeof value === "string") return redactText(value, names);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, names));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, names);
    return out;
  }
  return value;
}

/** Redact a full ShareContext before it reaches the HTML builders: every
 * string in the state snapshot and session summaries, with name tokens
 * derived from the original (pre-redaction) cwds. resolveImage passes
 * through untouched, its data URIs are content, not text. */
export function redactShareContext(ctx: ShareContext): ShareContext {
  const names = deriveNameTokens(ctx.state, ctx.sessions);
  const out: ShareContext = {
    state: ctx.state ? (deepRedact(ctx.state, names) as DashboardState) : null,
    sessions: deepRedact(ctx.sessions, names) as SessionSummary[],
  };
  if (ctx.resolveImage) out.resolveImage = ctx.resolveImage;
  return out;
}
