import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MacAlertHandle {
  kill: () => void;
}

export type MacAlertStyle = "info" | "caution" | "critical";

export interface MacAlertChip {
  /** Emoji glyph OR SF Symbol name — the Swift backend auto-detects. */
  symbol: string;
  label: string;
}

export interface MacAlertButton {
  label: string;
  kind: "primary" | "secondary" | "destructive";
  value: string;
}

/**
 * Permission-prompt payload — what the SwiftUI backend renders for "may I run
 * this bash/edit/network call?" asks.
 */
export interface MacAlertStructuredPermission {
  mode: "permission";
  /** Optional session label (e.g. "Optimise") shown as a top-line crumb. */
  session?: string;
  /** Tool name (uppercase) shown in the small "PERMISSION · X" header label. */
  tool: string;
  /** Big intent line, e.g. "Read state.ts" or "Search for foo in bar". */
  headline: string;
  /** Risk level — drives the color of the risk pill. */
  risk: "low" | "medium" | "high" | "critical";
  /** Display string for the risk, e.g. "Low". */
  riskLabel: string;
  /** Emoji inside the risk pill, e.g. "🟢". */
  riskIcon: string;
  chips: MacAlertChip[];
  cwd?: string;
  command: string;
  buttons: MacAlertButton[];
  default?: string;
}

/**
 * Pending-question payload — what the SwiftUI backend renders for the
 * "Murmur is asking a question" flow (the amber-themed card from the
 * dashboard's PendingQuestionPanel).
 */
export interface MacAlertStructuredQuestion {
  mode: "question";
  /** Optional session label (e.g. "Optimise") shown as a top-line crumb. */
  session?: string;
  /** Small uppercase tag above the question (optional), e.g. "CORE WEDGE". */
  header?: string;
  /** The actual question text — wraps to multiple lines. */
  question: string;
  /** Option labels rendered as solid amber pill buttons; clicking submits. */
  options: string[];
  /** Whether to show the "Or type a custom answer" input + Send button. */
  allowCustomInput?: boolean;
  /** Placeholder for the custom input. */
  customInputPlaceholder?: string;
}

/**
 * Rich payload consumed by the SwiftUI backend (`dist/native/murmur-alert`).
 * When this is provided AND the Swift binary is present, the alert renders
 * as a polished card. When absent (or the binary isn't built),
 * `spawnMacAlert` falls back to the AppleScript path using the flat
 * `title`/`message`/`buttons` fields.
 */
export type MacAlertStructured =
  | MacAlertStructuredPermission
  | MacAlertStructuredQuestion;

export interface MacAlertOptions {
  title: string;
  message: string;
  buttons: string[];
  defaultButton?: string;
  /**
   * Visual style:
   * - "info"     → system note icon via `display dialog with icon note`.
   * - "caution"  → yellow caution icon via `display dialog with icon caution`.
   * - "critical" → warning triangle + critical sound via `display alert as critical`.
   * Default: "critical".
   */
  style?: MacAlertStyle;
  /** Structured spec for the Swift backend. Optional, ignored if no binary. */
  structured?: MacAlertStructured;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Candidate locations for the compiled Swift helper. build:native only ever
// emits to dist/native, so:
//  - In prod (node dist/index.js) moduleDir is dist/, so the first candidate
//    resolves to dist/native/murmur-alert (the real artifact). The second is a
//    path-equivalent of the first here.
//  - In dev (running src/mac-alert.ts directly via bun) moduleDir is src/, so
//    the first candidate (src/native) is never produced and the second
//    (../dist/native) is the real one. We keep both so a single list covers
//    prod and dev without branching on which mode we're in.
const SWIFT_BINARY_CANDIDATES = [
  join(moduleDir, "native", "murmur-alert"),
  join(moduleDir, "..", "dist", "native", "murmur-alert"),
];

function resolveSwiftBinary(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.MURMUR_DISABLE_SWIFT === "1") return null;
  for (const c of SWIFT_BINARY_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return null;
}

const swiftBinaryPath = resolveSwiftBinary();

/**
 * Resolve the alert sound file path. Order:
 *   1. MURMUR_MAC_MODAL_SOUND env var (full path).
 *   2. ~/Library/Sounds/codex-notification.{wav,aiff} if it exists.
 *   3. /System/Library/Sounds/Funk.aiff as the last-resort fallback.
 *
 * We play sound ourselves via `afplay` because `display alert as critical`
 * does not reliably play sound when the user's `com.apple.sound.beep.sound`
 * preference is set to a full file path or a non-AIFF file.
 */
function resolveAlertSound(): string | null {
  const override = process.env.MURMUR_MAC_MODAL_SOUND;
  if (override && existsSync(override)) return override;
  const candidates = [
    join(homedir(), "Library", "Sounds", "codex-notification.wav"),
    join(homedir(), "Library", "Sounds", "codex-notification.aiff"),
    "/System/Library/Sounds/Funk.aiff",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function playAlertSound(): void {
  const path = resolveAlertSound();
  if (!path) return;
  try {
    const child = spawn("afplay", [path], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Best-effort: silent on failure.
  }
}

const escapeApplescript = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");

/**
 * Shared child-process lifecycle for both alert backends (the SwiftUI binary
 * and the osascript fallback). Owns the stdout accumulation, the
 * exit/error handlers, and the kill closure. The two backends differ only in
 * how they spawn, whether they write stdin, and the regex that extracts the
 * chosen value, so those are passed in.
 *
 * - `spawnChild` performs the actual spawn (it may throw, in which case we
 *   return a no-op handle).
 * - `parseChoice` pulls the chosen value out of accumulated stdout, or returns
 *   null when nothing was chosen.
 * - `stdinPayload`, when provided, is written to the child's stdin and then
 *   stdin is closed.
 */
function runAlertProcess(
  spawnChild: () => ChildProcess,
  parseChoice: (stdout: string) => string | null,
  onChoice: (value: string) => void,
  opts?: { stdinPayload?: string }
): MacAlertHandle {
  let child: ChildProcess;
  try {
    child = spawnChild();
  } catch {
    return { kill: () => {} };
  }

  if (opts?.stdinPayload !== undefined) {
    try {
      child.stdin?.write(opts.stdinPayload);
      child.stdin?.end();
    } catch {
      // Swallow — if stdin closed early, the binary will still exit.
    }
  }

  let stdout = "";
  let dismissed = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.on("exit", (code) => {
    if (dismissed || code !== 0) return;
    const value = parseChoice(stdout);
    if (value !== null) onChoice(value);
  });

  child.on("error", () => {
    // Best-effort — caller still has the other backend and the browser modal.
  });

  return {
    kill: () => {
      dismissed = true;
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    },
  };
}

function spawnSwiftAlert(
  binary: string,
  spec: MacAlertStructured,
  onChoice: (value: string) => void
): MacAlertHandle {
  return runAlertProcess(
    () => spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] }),
    (stdout) => {
      // Swift binary prints: `button returned:<value>\n`
      const match = stdout.match(/button returned:(.+?)(?:\r?\n|$)/);
      return match ? match[1].trim() : null;
    },
    onChoice,
    { stdinPayload: JSON.stringify(spec) }
  );
}

export function spawnMacAlert(
  opts: MacAlertOptions,
  onChoice: (button: string) => void
): MacAlertHandle {
  // Play the alert sound regardless of which backend renders the modal.
  // We do this in TypeScript (via afplay) because the AppleScript path can't
  // reliably play custom-pathed beep sounds, and the SwiftUI binary doesn't
  // play any sound on its own.
  const style: MacAlertStyle = opts.style ?? "critical";
  if (style === "critical") {
    playAlertSound();
  }

  if (opts.structured && swiftBinaryPath) {
    return spawnSwiftAlert(swiftBinaryPath, opts.structured, onChoice);
  }

  const buttons = opts.buttons.slice(0, 3);
  if (buttons.length === 0) {
    return { kill: () => {} };
  }
  const buttonsList = buttons
    .map((b) => `"${escapeApplescript(b)}"`)
    .join(", ");
  const defaultBtn =
    opts.defaultButton && buttons.includes(opts.defaultButton)
      ? `default button "${escapeApplescript(opts.defaultButton)}"`
      : "";
  const title = escapeApplescript(opts.title);
  const message = escapeApplescript(opts.message);
  let script: string;
  if (style === "critical") {
    // display alert: warning triangle, critical sound, system "alert" treatment.
    script =
      `display alert "${title}" ` +
      `message "${message}" ` +
      `buttons {${buttonsList}} ${defaultBtn} as critical ` +
      `giving up after 0`;
  } else {
    // display dialog with a POSIX-file icon path. The keyword forms (`with icon
    // note`, `with icon caution`) fall back to the calling app's icon on modern
    // macOS, so we point at the actual .icns files instead.
    const iconPath =
      style === "info"
        ? "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/AlertNoteIcon.icns"
        : "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/AlertCautionBadgeIcon.icns";
    script =
      `display dialog "${message}" with title "${title}" ` +
      `buttons {${buttonsList}} ${defaultBtn} ` +
      `with icon (POSIX file "${iconPath}") ` +
      `giving up after 0`;
  }

  return runAlertProcess(
    () => spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] }),
    (stdout) => {
      // osascript output shape with `giving up after 0`:
      //   button returned:<label>, gave up:false
      // The <label> can contain commas, so we stop at ", gave up:" or end-of-line.
      const match = stdout.match(/button returned:(.+?)(?:, gave up:|\r?\n|$)/);
      return match ? match[1].trim() : null;
    },
    onChoice
  );
}
