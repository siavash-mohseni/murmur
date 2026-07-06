// The owner view's vocabulary, kept in one file so the plain-language wording
// stays consistent and reviewable in one place. The operator view renders raw
// harness statuses, the owner view renders these words instead.

import type { PermRisk, RowStatus, WorkflowRunStatus } from "@/hooks/useDashboardState";

export type OwnerTone = "emerald" | "amber" | "rose" | "blue" | "zinc";

export function ownerRowStatusWord(status: RowStatus): string {
  if (status === "pending") return "queued";
  if (status === "in_progress") return "in progress";
  if (status === "completed") return "done";
  return "needs attention";
}

export function ownerRunStatusWord(status: WorkflowRunStatus): string {
  if (status === "running") return "in progress";
  if (status === "completed") return "done";
  if (status === "failed") return "needs attention";
  if (status === "stopped") return "stopped";
  return "stalled";
}

// Tone for any row or workflow status string. Mirrors toneForStatus in
// atoms.tsx so an owner pill and an operator pill always agree on color.
export function statusTone(status: string): OwnerTone {
  if (status === "completed") return "emerald";
  if (status === "in_progress" || status === "running") return "blue";
  if (status === "failed") return "rose";
  if (status === "stale") return "amber";
  return "zinc";
}

export function ownerRiskWord(risk: PermRisk): { label: string; tone: OwnerTone } {
  if (risk === "low") return { label: "Looks routine", tone: "emerald" };
  if (risk === "medium") return { label: "Worth a look", tone: "amber" };
  if (risk === "high") return { label: "Be careful", tone: "rose" };
  return { label: "Stop and check", tone: "rose" };
}

// Pill values verbatim from toneForStatus in atoms.tsx, dot/text values from
// the StatusIcon palette, so the owner view introduces no new colors. The ring
// value is the pill's ring color at a slightly higher opacity, used to outline
// timeline nodes against the dark panel. The accent value is a left-border
// color, used as a vertical accent bar on the side of a chat bubble. The solid
// value is a saturated fill for a timeline node that carries an icon (matching
// the pink and violet avatars), so the node itself reads as a color-coded
// milestone marker. The tint value washes a whole chat bubble in the tone, a
// border plus a faint surface, so the bubble's kind is legible at a glance.
export function toneClasses(tone: OwnerTone): {
  pill: string;
  dot: string;
  text: string;
  ring: string;
  accent: string;
  solid: string;
  tint: string;
} {
  switch (tone) {
    case "emerald":
      return {
        pill: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
        dot: "bg-emerald-400",
        text: "text-emerald-300",
        ring: "ring-emerald-500/40",
        accent: "border-l-emerald-500/50",
        solid: "bg-emerald-500 text-white ring-emerald-400",
        tint: "border-emerald-500/25 bg-emerald-500/[0.06]",
      };
    case "amber":
      return {
        pill: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
        dot: "bg-amber-400",
        text: "text-amber-300",
        ring: "ring-amber-500/40",
        accent: "border-l-amber-500/50",
        solid: "bg-amber-500 text-white ring-amber-400",
        tint: "border-amber-500/25 bg-amber-500/[0.06]",
      };
    case "rose":
      return {
        pill: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
        dot: "bg-rose-400",
        text: "text-rose-300",
        ring: "ring-rose-500/40",
        accent: "border-l-rose-500/50",
        solid: "bg-rose-500 text-white ring-rose-400",
        tint: "border-rose-500/25 bg-rose-500/[0.06]",
      };
    case "blue":
      return {
        pill: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
        dot: "bg-blue-400",
        text: "text-blue-300",
        ring: "ring-blue-500/40",
        accent: "border-l-blue-500/50",
        solid: "bg-blue-500 text-white ring-blue-400",
        tint: "border-blue-500/25 bg-blue-500/[0.06]",
      };
    case "zinc":
      return {
        pill: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
        dot: "bg-zinc-500",
        text: "text-zinc-400",
        ring: "ring-zinc-500/40",
        accent: "border-l-zinc-500/50",
        solid: "bg-zinc-600 text-white ring-zinc-500",
        tint: "border-zinc-500/25 bg-zinc-500/[0.06]",
      };
  }
}

export function countNoun(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
