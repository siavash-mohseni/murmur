/**
 * Mac-alert presenter. Owns the KIND_SYMBOL / SCOPE_SYMBOL chip tables and the
 * construction of the structured SwiftUI-card payloads (plus the AppleScript
 * fallback message for permissions). Extracted out of state.ts so the Store no
 * longer mixes alert-presentation concerns with its state/persistence logic.
 *
 * These are pure builders: the Store resolves the session label / window title
 * (which depend on its own state) and passes them in, then hands the returned
 * MacAlertOptions straight to spawnMacAlert. Behavior is unchanged.
 */
import type { MacAlertOptions, MacAlertStructured } from "./mac-alert.js";
import type { PendingQuestion, PermClassification } from "./shared-types.js";
import type { PermKind, PermScope } from "./permission-classifier.js";
import { permissionIntent } from "./intent.js";

// SF Symbol names for the kind/scope chips on the SwiftUI permission card.
// Chosen to match the dashboard shield's vector-icon vibe. The Swift binary's
// GlyphIcon auto-detects emoji vs SF Symbol, so passing names here renders
// proper iconography instead of the classifier's emoji fallback.
const KIND_SYMBOL: Record<PermKind, string> = {
  read: "eye",
  write: "square.and.pencil",
  execute: "terminal",
  delete: "trash",
  network: "network",
  remote: "antenna.radiowaves.left.and.right",
};
const SCOPE_SYMBOL: Record<PermScope, string> = {
  project: "folder.fill",
  machine: "desktopcomputer",
  web: "globe",
  remote: "link",
};

/**
 * Build the MacAlertOptions for a pending question. `title` is the already
 * resolved window title (Store.macAlertTitle), `session` the optional session
 * crumb (Store.macAlertSession).
 */
export function buildQuestionAlert(
  question: PendingQuestion,
  title: string,
  session: string | undefined
): MacAlertOptions {
  const labels = question.options.map((o) => o.label);
  return {
    title,
    message: question.question,
    // AppleScript fallback can only show up to 3 buttons. Slice
    // here so the fallback doesn't error. The Swift backend
    // ignores `buttons` (it consumes `structured` instead).
    buttons: labels.slice(0, 3),
    defaultButton: labels[0],
    style: "info",
    structured: {
      mode: "question",
      session,
      header: question.header,
      question: question.question,
      options: labels,
      allowCustomInput: true,
      customInputPlaceholder: "Or type a custom answer",
    },
  };
}

/**
 * Build the MacAlertOptions for a permission prompt. `command` is the
 * normalized command string, `classification` the heuristic labels, `title`
 * the resolved window title and `session` the optional session crumb.
 */
export function buildPermissionAlert(
  req: { tool: string; command: string; cwd?: string },
  command: string,
  classification: PermClassification,
  title: string,
  session: string | undefined
): MacAlertOptions {
  // Text fallback for the AppleScript path. Mirrors the SwiftUI card's
  // information order without duplication.
  const chips = `${classification.riskIcon} ${classification.riskLabel} risk · ${classification.kindIcon} ${classification.kindLabel} · ${classification.scopeIcon} ${classification.scopeLabel}`;
  const cwdLine = req.cwd ? `\n\ncwd: ${req.cwd}` : "";
  const message = `${chips}${cwdLine}${command ? `\n\n${command}` : ""}`;
  // Structured spec for the SwiftUI backend. Used when the compiled
  // helper is present, otherwise mac-alert.ts falls back to `message`.
  // Headline = the present-tense intent for any tool ("Read state.ts",
  // "Edit App.tsx", "Search for foo"), matching the activity-feed prose.
  const headline = permissionIntent(req.tool, command).headline;
  const structured: MacAlertStructured = {
    mode: "permission",
    session,
    tool: req.tool.toUpperCase(),
    headline,
    risk: classification.risk,
    riskLabel: classification.riskLabel,
    riskIcon: classification.riskIcon,
    chips: [
      { symbol: KIND_SYMBOL[classification.kind], label: classification.kindLabel },
      { symbol: SCOPE_SYMBOL[classification.scope], label: classification.scopeLabel },
    ],
    cwd: req.cwd,
    command,
    buttons: [
      { label: "Allow once", kind: "primary", value: "Allow" },
      { label: "Always allow", kind: "secondary", value: "Always" },
      { label: "Deny", kind: "destructive", value: "Deny" },
    ],
    default: "Allow",
  };
  return {
    title,
    message,
    buttons: ["Deny", "Always", "Allow"],
    defaultButton: "Allow",
    style: "critical",
    structured,
  };
}
