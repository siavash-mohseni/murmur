import { useCallback, useEffect, useState } from "react";
import { Folder, Shield } from "lucide-react";
import { Countdown } from "@/components/Countdown";
import { permissionIntent } from "@/lib/event-intent";
import type {
  PendingPermission,
  PermClassification,
  PermissionDecision,
} from "@/hooks/useDashboardState";

// Outline-pill accent per risk level, mirroring the native card's Palette.
const RISK_ACCENT: Record<
  PermClassification["risk"],
  { text: string; ring: string; dot: string }
> = {
  low: { text: "text-emerald-400", ring: "ring-emerald-400/50", dot: "bg-emerald-400" },
  medium: { text: "text-amber-300", ring: "ring-amber-300/50", dot: "bg-amber-300" },
  high: { text: "text-orange-400", ring: "ring-orange-400/50", dot: "bg-orange-400" },
  critical: { text: "text-rose-400", ring: "ring-rose-400/50", dot: "bg-rose-400" },
};

// The three actions, in the same order and with the same default focus as the
// native card: Allow once is the highlighted default, Deny is destructive.
const ACTIONS: {
  label: string;
  decision: PermissionDecision;
  accent: "emerald" | "rose";
}[] = [
  { label: "Allow once", decision: "allow", accent: "emerald" },
  { label: "Always allow", decision: "always", accent: "emerald" },
  { label: "Deny", decision: "deny", accent: "rose" },
];

function RiskBadge({
  classification,
}: {
  classification: PermClassification;
}): React.JSX.Element {
  const a = RISK_ACCENT[classification.risk];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset ${a.ring}`}
    >
      <span className={`h-2 w-2 rounded-full ${a.dot}`} />
      <span className={`text-[11px] font-bold uppercase tracking-wider ${a.text}`}>
        {classification.riskLabel} risk
      </span>
    </span>
  );
}

// Kind + scope chips (the risk shows as the badge top-right, matching native).
export function PermissionClassificationBanner({
  classification,
}: {
  classification: PermClassification;
}): React.JSX.Element {
  const chip = (icon: string, label: string): React.JSX.Element => (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1 text-[13px] font-medium text-zinc-200 ring-1 ring-inset ring-white/10">
      <span className="text-sm leading-none">{icon}</span>
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chip(classification.kindIcon, classification.kindLabel)}
      {chip(classification.scopeIcon, classification.scopeLabel)}
    </div>
  );
}

// Outline pill: the focused action gets the accent ring/fill/text; the rest stay
// neutral until hovered, like the native card's OutlinePillButtonStyle. Focus
// follows the keyboard (← →) and the mouse, so Enter always selects the
// highlighted button — exactly the native interaction.
function PillButton({
  accent,
  focused,
  disabled,
  onClick,
  onHover,
  children,
}: {
  accent: "emerald" | "rose";
  focused: boolean;
  disabled?: boolean;
  onClick: () => void;
  onHover: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const focusedTone =
    accent === "rose"
      ? "text-rose-300 bg-rose-400/10 ring-rose-400/65"
      : "text-emerald-300 bg-emerald-400/10 ring-emerald-400/65";
  const neutralTone = "text-zinc-200 bg-white/[0.03] ring-white/15";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onHover}
      className={`inline-flex items-center justify-center rounded-full px-5 py-2 text-[13px] font-semibold ring-1 ring-inset transition focus:outline-none disabled:opacity-50 ${
        focused ? focusedTone : neutralTone
      }`}
    >
      {children}
    </button>
  );
}

export function PermissionModal({
  permission,
  session,
  onDecide,
}: {
  permission: PendingPermission | null;
  /** Optional session/project crumb, e.g. "acme-app" (shown uppercased). */
  session?: string;
  onDecide: (id: string, decision: PermissionDecision) => Promise<boolean>;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  // Which action is highlighted. 0 = Allow once, matching the native default.
  const [focusedIndex, setFocusedIndex] = useState(0);

  const pick = useCallback(
    async (decision: PermissionDecision): Promise<void> => {
      if (!permission) return;
      setBusy(true);
      await onDecide(permission.permissionId, decision);
      setBusy(false);
    },
    [permission, onDecide]
  );

  // Reset focus to the default action whenever a new permission appears.
  useEffect(() => {
    setFocusedIndex(0);
  }, [permission?.permissionId]);

  useEffect(() => {
    if (!permission) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Keyboard model, identical to the native card:
    //   ← / →  → move focus between the actions
    //   Enter  → select the focused action
    //   Escape → Deny
    const onKey = (e: KeyboardEvent): void => {
      if (busy) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(ACTIONS.length - 1, i + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        void pick(ACTIONS[focusedIndex]!.decision);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void pick("deny");
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [permission, busy, pick, focusedIndex]);

  if (!permission) return null;

  const headline = permissionIntent(permission.tool, permission.command).headline;
  const crumb = session?.trim() ? session.trim().replace(/[-_]+/g, " ").toUpperCase() : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-sm"
    >
      <div className="w-full max-w-xl space-y-4 rounded-xl bg-zinc-950/90 p-6 shadow-2xl ring-1 ring-rose-500/30 backdrop-blur-2xl">
        {/* Header: session crumb + PERMISSION · TOOL label + intent headline,
            risk badge top-right. */}
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-[12px] font-bold uppercase tracking-wider">
              {crumb && <span className="text-zinc-400">{crumb}</span>}
              <span className="flex items-center gap-1.5 text-rose-300">
                <Shield className="h-3.5 w-3.5" />
                Permission · {permission.tool}
              </span>
            </div>
            <div className="text-xl font-semibold leading-snug text-zinc-50 line-clamp-2">
              {headline}
            </div>
          </div>
          {permission.classification && (
            <RiskBadge classification={permission.classification} />
          )}
        </div>

        {/* Kind + scope chips. */}
        {permission.classification && (
          <PermissionClassificationBanner classification={permission.classification} />
        )}

        {/* The command / target. */}
        {permission.command && (
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white/[0.05] p-3.5 font-mono text-sm leading-relaxed text-zinc-200 ring-1 ring-inset ring-white/10">
            {permission.command}
          </pre>
        )}

        {/* cwd. */}
        {permission.cwd && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{permission.cwd}</span>
          </div>
        )}

        {/* Actions — order and focus model match the native card. */}
        <div className="flex flex-wrap gap-2.5 pt-0.5">
          {ACTIONS.map((action, i) => (
            <PillButton
              key={action.decision}
              accent={action.accent}
              focused={focusedIndex === i}
              disabled={busy}
              onHover={() => setFocusedIndex(i)}
              onClick={() => void pick(action.decision)}
            >
              {action.label}
            </PillButton>
          ))}
        </div>

        {/* Footer hints, muted and matching the native card's wording, plus
            the live countdown to the silent CLI fallback. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
          <span>← → navigate</span>
          <span>⏎ select</span>
          <span>Esc Deny</span>
          <span className="ml-auto">
            <Countdown expiresAt={permission.expiresAt} />
          </span>
        </div>
      </div>
    </div>
  );
}
