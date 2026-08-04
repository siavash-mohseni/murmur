import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bot,
  Bug,
  CheckCircle2,
  Database,
  FilePlus2,
  FileText,
  GitBranch,
  GitFork,
  Globe,
  Hammer,
  Info,
  Package,
  Palette,
  Pencil,
  Rocket,
  Search,
  Settings,
  TestTube2,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import { Panel } from "@/components/Panel";
import { StatusIcon } from "@/components/atoms";
import { ActivityImages } from "@/components/ActivityImages";
import { ClaudeWorkCard, parseForCard } from "@/components/owner/ClaudeWorkCard";
import { ExpandableText } from "@/components/owner/ExpandableText";
import {
  beatIcon,
  beatTone,
  classifyBeat,
  isTableDump,
  type Beat,
  type BeatIconKey,
} from "@/lib/message-structure";
import type { Activity, ActivityImage, Row, RowStatus } from "@/hooks/useDashboardState";
import { useOwnerSummaries } from "@/hooks/useOwnerSummaries";
import { SummariesUnavailableBanner } from "@/components/owner/SummariesUnavailableBanner";
import { relativeTime } from "@/lib/format";
import { ownerRowStatusWord, statusTone, toneClasses } from "@/lib/owner-language";
import { ACTIVE_WINDOW_MS } from "@/lib/owner-status";
import { groupRows } from "@/lib/run-groups";
import {
  groupActivitiesIntoRounds,
  isSyntheticUserPrompt,
  roundNarrative,
} from "@/lib/summary-html";

const VISIBLE_CAP = 30;

// The milestone list scrolls inside its own fixed-height box, so following the
// newest bubble never moves the whole page.
const LIST_MAX_HEIGHT = "max-h-[26rem]";
// A reader within this many pixels of the list bottom is "stuck to bottom" and
// gets auto-scrolled when a new item lands. Scroll up past it and the auto
// scroll stops, so reading history is never interrupted.
const STICK_THRESHOLD = 80;
// A deliberately unhurried glide. The container's native smooth scroll is quick
// and uncontrollable, so we drive scrollTop ourselves.
const SCROLL_DURATION_MS = 700;

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

let activeScrollRaf: number | null = null;

// easeInOutCubic: slow start, slow finish, so the glide feels gentle.
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Animate a scroll container's scrollTop to a target over durationMs, clamped to
// the scrollable range. Reduced motion jumps instantly.
function slowScrollElementTo(el: HTMLElement, targetTop: number, durationMs: number): void {
  const startTop = el.scrollTop;
  const target = Math.max(0, Math.min(targetTop, el.scrollHeight - el.clientHeight));
  const delta = target - startTop;
  if (Math.abs(delta) < 2) return;
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    el.scrollTop = target;
    return;
  }
  if (activeScrollRaf !== null) cancelAnimationFrame(activeScrollRaf);
  let startTs: number | null = null;
  const step = (ts: number): void => {
    if (startTs === null) startTs = ts;
    const t = Math.min(1, (ts - startTs) / durationMs);
    el.scrollTop = startTop + delta * ease(t);
    if (t < 1) {
      activeScrollRaf = requestAnimationFrame(step);
    } else {
      activeScrollRaf = null;
    }
  };
  activeScrollRaf = requestAnimationFrame(step);
}

interface TimelineItem {
  id: string;
  // Sort key in ms. Items without a timestamp inherit a key from their run so
  // run groups stay contiguous.
  key: number;
  kind: "run" | "step" | "you" | "claude";
  label: string;
  detail?: string;
  status?: RowStatus;
  iso?: string;
  // Run headers only: completed and total step counts for the progress bar.
  done?: number;
  total?: number;
  // Claude beats only: the full reply capture, parsed into semantic groups when
  // it has structure.
  outline?: string;
  // Conversation beats only: images the user attached, or a tool captured for
  // Claude. Rendered as a thumbnail strip inside the bubble.
  images?: ActivityImage[];
}

// Goal-language milestones merged with conversation beats. Never tool rows,
// that altitude belongs to the operator view.
export function OwnerTimeline({
  rows,
  activities,
  now,
  autoScrollNew,
}: {
  rows: Row[];
  activities: Activity[];
  now: number;
  // When true, a newly appended item smooth-scrolls into view. The caller turns
  // this off while something needs the reader, so the inbox keeps priority.
  autoScrollNew: boolean;
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);

  const items = useMemo<TimelineItem[]>(() => {
    if (rows.length > 0) return milestonesFromRows(rows, activities);
    // No TaskCreate run: show the conversation itself as summarized bubbles
    // rather than a few coarse, unsummarized rounds. Fall back to rounds only
    // when there is no conversation to show.
    const chat = chatBeatsFromActivities(activities);
    if (chat.length > 0) return chat.sort((a, b) => a.key - b.key);
    return milestonesFromRounds(activities, now);
  }, [rows, activities, now]);

  const hidden = showAll ? 0 : Math.max(0, items.length - VISIBLE_CAP);
  const visible = hidden > 0 ? items.slice(hidden) : items;

  // The milestone list scrolls inside scrollRef. A ResizeObserver watches the
  // content (contentRef): whenever it grows (a new milestone, or a summary
  // expanding a bubble) we keep the box pinned to the bottom, but only while the
  // reader is stuck there (stickRef, updated on every manual scroll) and nothing
  // needs them (autoScrollNew). Scroll up inside the box and following stops
  // until you return to the bottom. Driving this off content size, not React
  // render timing, makes it fire reliably regardless of why the list grew.
  const hasItems = items.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const autoScrollRef = useRef(autoScrollNew);
  autoScrollRef.current = autoScrollNew;

  const onListScroll = (): void => {
    const el = scrollRef.current;
    if (el) stickRef.current = distanceFromBottom(el) <= STICK_THRESHOLD;
  };

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    // Start pinned to the newest milestone.
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    const ro = new ResizeObserver(() => {
      if (!autoScrollRef.current || !stickRef.current) return;
      if (distanceFromBottom(el) < 2) return;
      slowScrollElementTo(el, el.scrollHeight, SCROLL_DURATION_MS);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [hasItems]);

  // Ask the server for a plain-language summary of each visible conversation
  // beat (yours and Claude's) that is long enough to need one (short beats are
  // already glanceable). The server short-circuits very short text, so the >70
  // guard avoids a round trip.
  const summaryRequests = useMemo(
    () =>
      visible
        .filter((it) => it.kind === "claude" || it.kind === "you")
        .map((it) => ({ id: it.id, text: it.outline || it.label }))
        .filter((r) => r.text.length > 70),
    [visible]
  );
  const { summaries, unavailableReason } = useOwnerSummaries(summaryRequests);

  return (
    <Panel
      title="Milestones"
      subtitle={items.length === 0 ? undefined : `${items.length} so far`}
      empty="No milestones yet"
    >
      {items.length === 0 ? undefined : (
        <div className="px-5 py-4">
          {unavailableReason && <SummariesUnavailableBanner reason={unavailableReason} />}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mb-3 text-xs text-zinc-500 transition hover:text-zinc-300"
            >
              Show earlier ({hidden} more)
            </button>
          )}
          {/* Fixed-height scroll box so following the newest milestone scrolls
              here, never the whole page. */}
          <div
            ref={scrollRef}
            onScroll={onListScroll}
            className={`${LIST_MAX_HEIGHT} overflow-y-auto overflow-x-hidden pl-2 pr-1`}
          >
            <div ref={contentRef} className="relative">
              {/* The spine: a vertical line behind the node column. */}
              <div aria-hidden className="absolute bottom-3 left-[13px] top-3 w-px bg-white/[0.07]" />
              <div className="flex flex-col gap-3">
                {visible.map((item, idx) => {
                  // Run headers beyond the first get extra top gap (this used to
                  // live on RunHeader as first:mt-0, moved here so wrapping items
                  // does not make every header a first child).
                  const cls = item.kind === "run" && idx !== 0 ? "mt-3" : undefined;
                  return (
                    <div key={item.id} className={cls}>
                      <TimelineRow item={item} now={now} summary={summaries[item.id]} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function TimelineRow({
  item,
  now,
  summary,
}: {
  item: TimelineItem;
  now: number;
  summary?: string;
}): React.JSX.Element {
  if (item.kind === "run") return <RunHeader item={item} />;
  if (item.kind === "you" || item.kind === "claude")
    return <ChatBeat item={item} now={now} summary={summary} />;
  return <StepRow item={item} now={now} />;
}

// Section header on the spine: a tone-ringed node, bold title, status pill,
// and a mini progress bar once the run has more than one step.
function RunHeader({ item }: { item: TimelineItem }): React.JSX.Element {
  const status = item.status ?? "pending";
  const tone = toneClasses(statusTone(status));
  const total = item.total ?? 0;
  const done = item.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-start gap-3">
      <span
        className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 ring-1 ${tone.ring}`}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${tone.dot} ${
            status === "in_progress" ? "animate-pulse" : ""
          }`}
        />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">{item.label}</span>
          <span
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tone.pill}`}
          >
            {ownerRowStatusWord(status)}
          </span>
        </div>
        {total > 1 && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 w-32 overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className={`h-full rounded-full ${tone.dot} transition-[width] duration-500`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-zinc-500">
              {done} of {total} steps done
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Conversation beat as a chat bubble with a solid avatar, the same pink and
// violet identities the activity feed uses for user and assistant prompts. A
// structured Claude reply renders as semantic groups instead of a text wall.
function ChatBeat({
  item,
  now,
  summary,
}: {
  item: TimelineItem;
  now: number;
  summary?: string;
}): React.JSX.Element {
  const isYou = item.kind === "you";
  const card = isYou ? null : parseForCard(item.outline);
  // Non-card Claude beats get a semantic kind (action, finding, check,
  // decision, warning). Instead of a faint inline glyph beside the text, the
  // kind drives the whole bubble: the spine node becomes a solid color-coded
  // marker carrying the kind icon, and the bubble is washed in the matching
  // tone. Scanning the spine then reads as a color story, green is done, blue
  // is working, amber is a choice, rose is caution, instead of a column of
  // identical gray bubbles.
  const beat = !isYou && !card ? classifyBeat(item.label) : null;
  const classified = beat && beat.kind !== "plain" ? beat : null;
  const tone = classified ? toneClasses(beatTone(classified.kind)) : null;
  const node = isYou
    ? "bg-pink-500 text-white ring-pink-400"
    : tone
      ? tone.solid
      : "bg-violet-500 text-white ring-violet-400";
  const label = isYou ? "text-pink-300" : tone ? tone.text : "text-violet-300";
  return (
    <div className="flex items-start gap-3">
      <span
        className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ${node}`}
      >
        {isYou ? (
          <User className="h-3.5 w-3.5" />
        ) : classified ? (
          <BeatIcon iconKey={beatIcon(classified)} className="h-3.5 w-3.5" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )}
      </span>
      <div
        className={`min-w-0 flex-1 rounded-lg border px-3 py-2 ${
          tone ? tone.tint : "border-white/5 bg-white/[0.03]"
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${label}`}>
            {isYou ? "You" : "Claude"}
          </span>
          {item.iso && (
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">
              {relativeTime(item.iso, now)}
            </span>
          )}
        </div>
        <div className="mt-1">
          {card ? (
            <ClaudeWorkCard parsed={card} fallbackLead={item.label} />
          ) : beat ? (
            <BeatBody beat={beat} summary={summary} />
          ) : summary ? (
            <SummaryHeadline summary={summary} original={item.label} />
          ) : (
            <div className="text-sm text-zinc-300">
              <ExpandableText text={item.label} />
            </div>
          )}
          {item.images && item.images.length > 0 && (
            <ActivityImages images={item.images} className="mt-2" />
          )}
        </div>
      </div>
    </div>
  );
}

// The icon that anchors a classified Claude beat. beatIcon picks the key from
// what the beat is about (edit, test, build, git, ...), so the spine marker
// names the activity, not just its broad kind.
const BEAT_ICONS: Record<BeatIconKey, React.ComponentType<{ className?: string }>> = {
  edit: Pencil,
  create: FilePlus2,
  delete: Trash2,
  search: Search,
  read: BookOpen,
  test: TestTube2,
  build: Hammer,
  install: Package,
  git: GitBranch,
  deploy: Rocket,
  config: Settings,
  data: Database,
  network: Globe,
  docs: FileText,
  style: Palette,
  fix: Wrench,
  bug: Bug,
  action: ArrowRight,
  check: CheckCircle2,
  decision: GitFork,
  warning: AlertTriangle,
  finding: Info,
};

function BeatIcon({ iconKey, className }: { iconKey: BeatIconKey; className?: string }): React.JSX.Element {
  const Icon = BEAT_ICONS[iconKey];
  return <Icon className={className} />;
}

// The body of a classified Claude beat. The kind icon and color now live on the
// spine node and the bubble wash, so the body stays text-only. Once the
// plain-language summary lands it is the bold headline (what the owner reads at
// a glance), with the original wording kept underneath, muted, for anyone who
// wants the detail. Until then we show the original with its work-area chip.
function BeatBody({ beat, summary }: { beat: Beat; summary?: string }): React.JSX.Element {
  const tone = toneClasses(beatTone(beat.kind));

  if (summary) return <SummaryHeadline summary={summary} original={beat.text} />;

  return (
    <div className="text-sm leading-snug text-zinc-300">
      {beat.scope && (
        <span
          className={`mr-1.5 inline-block rounded px-1.5 py-0.5 align-baseline text-[10px] font-semibold ring-1 ring-inset ${tone.pill}`}
        >
          {beat.scope}
        </span>
      )}
      <ExpandableText text={beat.text} />
    </div>
  );
}

// A landed plain-language summary as the bold headline (what the owner reads at
// a glance), with the original wording kept underneath, muted, for anyone who
// wants the detail. Shared by Claude beats and your own prompts. The original is
// dropped when the summary is just a restatement of it.
function SummaryHeadline({
  summary,
  original,
}: {
  summary: string;
  original: string;
}): React.JSX.Element {
  const showOriginal = normForCompare(summary) !== normForCompare(original);
  return (
    <div className="min-w-0">
      <div className="text-[15px] font-semibold leading-snug text-zinc-100">{summary}</div>
      {showOriginal && (
        <div className="mt-1 text-xs leading-snug text-zinc-500">
          <ExpandableText text={original} />
        </div>
      )}
    </div>
  );
}

// Loose equality for "is the summary just the original restated?": ignore case,
// punctuation, and spacing so a verbatim short-circuit does not render twice.
function normForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function StepRow({ item, now }: { item: TimelineItem; now: number }): React.JSX.Element {
  const status = item.status ?? "pending";
  const tone = toneClasses(statusTone(status));
  return (
    <div className="flex items-start gap-3">
      <span className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 ring-1 ring-white/10">
        <StatusIcon status={status} />
      </span>
      <div className="min-w-0 flex-1 pt-1 text-sm">
        <ExpandableText text={item.label} className="text-zinc-200" />
        <span className={`ml-2 text-xs ${tone.text}`}>{ownerRowStatusWord(status)}</span>
        {item.detail && (
          <div className="mt-0.5 text-xs text-zinc-500">
            <ExpandableText text={item.detail} />
          </div>
        )}
      </div>
      {item.iso && (
        <span className="shrink-0 pt-1.5 text-xs tabular-nums text-zinc-600">
          {relativeTime(item.iso, now)}
        </span>
      )}
    </div>
  );
}

function rollupStatus(rows: Row[]): RowStatus {
  if (rows.some((r) => r.status === "failed")) return "failed";
  if (rows.some((r) => r.status === "in_progress")) return "in_progress";
  if (rows.length > 0 && rows.every((r) => r.status === "completed")) return "completed";
  return "pending";
}

function milestonesFromRows(rows: Row[], activities: Activity[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  // Cursor keeps un-timestamped rows anchored to their run instead of sorting
  // to the front.
  let cursor = 0;

  for (const g of groupRows(rows)) {
    const startMs = g.rows
      .map((r) => (r.startedAt ? Date.parse(r.startedAt) : Number.NaN))
      .find((ms) => Number.isFinite(ms));
    const runKey = startMs ?? cursor + 1;
    items.push({
      id: `run-${g.key}`,
      key: runKey,
      kind: "run",
      label: g.title,
      status: rollupStatus(g.rows),
      done: g.rows.filter((r) => r.status === "completed").length,
      total: g.rows.length,
    });
    g.rows.forEach((r, i) => {
      const ms = r.startedAt ? Date.parse(r.startedAt) : Number.NaN;
      const key = Number.isFinite(ms) ? ms : runKey + (i + 1) * 0.001;
      cursor = Math.max(cursor, key);
      // Owner altitude: a queued step is the future plan, not progress. The run
      // header's progress bar already carries the total, so render only steps
      // that have started, finished, or failed. This keeps a many-step
      // dashboard run from flooding the timeline with "queued" rows (and from
      // sorting that future plan above the work actually happening now).
      if (r.status === "pending") return;
      items.push({
        id: `step-${r.id}`,
        key,
        kind: "step",
        label: r.label,
        status: r.status,
        detail: r.detail,
        iso: r.endedAt ?? r.startedAt,
      });
    });
    cursor = Math.max(cursor, runKey);
  }

  items.push(...chatBeatsFromActivities(activities));

  return items.sort((a, b) => a.key - b.key);
}

// The conversation as timeline bubbles: your prompts and Claude's replies, in
// time order. Synthetic (hook-injected) prompts and progress-dashboard table
// re-emits are dropped. Used by both the task-session timeline and, on its own,
// the conversation-only fallback below.
function chatBeatsFromActivities(activities: Activity[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const a of activities) {
    if (a.kind !== "prompt") continue;
    const ms = Date.parse(a.timestamp);
    if (!Number.isFinite(ms)) continue;
    const images = a.images && a.images.length > 0 ? a.images : undefined;
    if (a.source === "user" && !isSyntheticUserPrompt(a.question)) {
      items.push({
        id: `you-${a.id}`,
        key: ms,
        kind: "you",
        label: a.question,
        iso: a.timestamp,
        ...(images ? { images } : {}),
      });
    } else if (a.source === "assistant") {
      // A tool capture (no outline, count-only label) still belongs on the
      // timeline because it carries images, even though a wordless reply would
      // normally be dropped.
      if (!images && isTableDump(a.outline ?? a.question)) continue;
      items.push({
        id: `claude-${a.id}`,
        key: ms,
        kind: "claude",
        label: a.question,
        iso: a.timestamp,
        outline: a.outline,
        ...(images ? { images } : {}),
      });
    }
  }
  return items;
}

// Sessions that never used TaskCreate still get a timeline: one milestone per
// conversation round, narrated from its event mix.
function milestonesFromRounds(activities: Activity[], now: number): TimelineItem[] {
  const rounds = groupActivitiesIntoRounds(activities);
  const lastEnded = rounds.length > 0 ? Date.parse(rounds[rounds.length - 1].endedAt) : Number.NaN;
  const lastIsLive = Number.isFinite(lastEnded) && now - lastEnded < ACTIVE_WINDOW_MS;

  return rounds.map((r, i) => {
    const isLast = i === rounds.length - 1;
    return {
      id: `round-${r.index}`,
      key: Date.parse(r.startedAt) || i,
      kind: "step" as const,
      label: r.userPrompt ? r.userPrompt.question : "Setup",
      detail: roundNarrative(r) || undefined,
      status: (isLast && lastIsLive ? "in_progress" : "completed") as RowStatus,
      iso: r.endedAt,
    };
  });
}
