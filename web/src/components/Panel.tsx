import type React from "react";

// The shared card shell used by every dashboard panel. Derived verbatim from the
// hand-rolled `.panel` / `.panel-header` markup the panels already use (see
// FilesTouchedPanel, MemoryPanel, SkillsLoadedPanel for the plain header and
// WorkflowsPanel for the icon header), so rendered output is byte-for-byte
// identical when a panel adopts it.
//
// headerIcon: when present, the title block sits inside a `flex items-center
//   gap-2` row next to the icon (the WorkflowsPanel layout).
// headerRight: optional content rendered after the title block inside the header
//   (the ActivityPanel filter-pill row).
// empty: when there are no children, this string is shown as the empty state.
export function Panel({
  title,
  subtitle,
  headerRight,
  headerIcon,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  headerRight?: React.ReactNode;
  headerIcon?: React.ReactNode;
  empty?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const titleBlock = (
    <div>
      <div className="text-base font-semibold text-zinc-50">{title}</div>
      {subtitle !== undefined && <div className="text-xs text-zinc-500">{subtitle}</div>}
    </div>
  );
  return (
    <div className="panel">
      <div className="panel-header">
        {headerIcon ? (
          <div className="flex items-center gap-2">
            {headerIcon}
            {titleBlock}
          </div>
        ) : (
          titleBlock
        )}
        {headerRight}
      </div>
      {children != null ? (
        children
      ) : (
        <div className="px-5 py-6 text-sm text-zinc-500">{empty}</div>
      )}
    </div>
  );
}

// The amber warning-banner shell shared by AgentWaitingBanner, StuckBanner, and
// the `warn` arm of ContextTierBanner. Markup is copied verbatim from those
// banners so output is identical: a rounded amber card whose title row is an
// icon plus a bold heading, with the body underneath.
export function WarnBanner({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <div className="flex items-center gap-2 text-amber-300">
        {icon}
        <span className="font-medium">{title}</span>
      </div>
      {children}
    </div>
  );
}

// The rose danger-banner shell, used by the `cliff` arm of ContextTierBanner.
// Markup copied verbatim from ContextTierBanner's cliff arm.
export function DangerBanner({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
      <div className="flex items-center gap-2 text-rose-300">
        {icon}
        <span className="font-medium">{title}</span>
      </div>
      {children}
    </div>
  );
}

// The inline `/compact`-style code chip. Markup copied verbatim from the
// ContextTierBanner arms (bg-white/[0.06]).
export function CodeChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px]">{children}</code>
  );
}
