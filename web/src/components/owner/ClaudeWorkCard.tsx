import { AlertTriangle, CheckCircle2, GitFork, Minus, Pencil } from "lucide-react";
import { ExpandableText } from "@/components/owner/ExpandableText";
import { toneClasses } from "@/lib/owner-language";
import {
  parseMessageStructure,
  segmentTone,
  type MessageGroup,
  type MessageItem,
  type ParsedMessage,
  type SegmentKind,
} from "@/lib/message-structure";

// Renders a Claude reply as semantic groups (what changed, decisions, checks)
// instead of a text wall, so the owner can see the shape of the work and the
// choices made. Falls back to plain text via the caller when the reply has no
// structure (parseMessageStructure(...).structured === false).

function KindIcon({ kind, className }: { kind: SegmentKind; className?: string }): React.JSX.Element {
  if (kind === "change") return <Pencil className={className} />;
  if (kind === "decision") return <GitFork className={className} />;
  if (kind === "verification") return <CheckCircle2 className={className} />;
  if (kind === "warning") return <AlertTriangle className={className} />;
  return <Minus className={className} />;
}

function ItemRow({ item }: { item: MessageItem }): React.JSX.Element {
  const tone = toneClasses(segmentTone(item.kind));
  return (
    <li className="flex items-start gap-2 text-sm leading-snug text-zinc-300">
      <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="min-w-0">
        {item.chip && (
          <span
            className={`mr-1.5 inline-block rounded px-1.5 py-0.5 align-baseline text-[10px] font-semibold ring-1 ring-inset ${tone.pill}`}
          >
            {item.chip}
          </span>
        )}
        <ExpandableText text={item.text} />
      </span>
    </li>
  );
}

function GroupBlock({ group }: { group: MessageGroup }): React.JSX.Element {
  const tone = toneClasses(segmentTone(group.kind));
  return (
    <div>
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider ${tone.text}`}>
        <KindIcon kind={group.kind} className="h-3.5 w-3.5" />
        <span>{group.heading}</span>
        <span className="text-zinc-600">{group.items.length}</span>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {group.items.map((item, i) => (
          <ItemRow key={i} item={item} />
        ))}
      </ul>
    </div>
  );
}

export function ClaudeWorkCard({
  parsed,
  fallbackLead,
}: {
  // Pre-parsed so the caller can decide structured-vs-plain once.
  parsed: ParsedMessage;
  // The first-paragraph summary, used as the lead when the outline had no
  // distinct opening line of its own.
  fallbackLead: string;
}): React.JSX.Element {
  const lead = parsed.lead ?? fallbackLead;
  // Drop the lead when it just repeats the first group's heading (common when
  // the reply opens directly on a section heading, which also becomes the
  // first-paragraph fallback).
  const firstHeading = parsed.groups[0]?.heading;
  const showLead = Boolean(lead) && (!firstHeading || norm(lead) !== norm(firstHeading));
  const outcomeTone = parsed.outcome ? toneClasses(segmentTone("verification")) : null;
  return (
    <div className="space-y-3">
      {showLead && (
        <div className="text-sm text-zinc-300">
          <ExpandableText text={lead!} />
        </div>
      )}
      {parsed.groups.map((group, i) => (
        <GroupBlock key={i} group={group} />
      ))}
      {parsed.outcome && outcomeTone && (
        <div className={`flex items-center gap-1.5 text-xs ${outcomeTone.text}`}>
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{parsed.outcome}</span>
        </div>
      )}
    </div>
  );
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[:.\s]+$/, "")
    .trim();
}

// Convenience for callers: parse once, returns null when not structured so the
// caller can render its plain bubble instead.
export function parseForCard(outline: string | undefined): ParsedMessage | null {
  if (!outline) return null;
  const parsed = parseMessageStructure(outline);
  return parsed.structured ? parsed : null;
}
