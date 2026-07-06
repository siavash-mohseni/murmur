import { useCallback } from "react";
import { Download, Sparkles } from "lucide-react";
import { buildExportHtml } from "@/lib/export-html";
import { buildSummaryHtml } from "@/lib/summary-html";
import type { ShareContext } from "@/lib/share-context";

// Open an HTML string in a new tab. Falls back to a download if the popup
// is blocked (e.g. when the click isn't a direct user gesture). Exported so
// PastSessions reuses the exact same logic instead of a second copy.
export function openHtmlInNewTab(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "noopener");
  if (!win) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Filesystem-safe timestamp used to name HTML exports.
export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function ShareButtons({ ctx }: { ctx: ShareContext }): React.JSX.Element {
  const shortId = (): string => ctx.state?.sessionId.slice(0, 8) ?? "snapshot";

  const onSummary = useCallback(() => {
    openHtmlInNewTab(buildSummaryHtml(ctx), `murmur-summary-${shortId()}-${stamp()}.html`);
  }, [ctx]);

  const onExport = useCallback(() => {
    downloadHtml(buildExportHtml(ctx), `claude-session-${shortId()}-${stamp()}.html`);
  }, [ctx]);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onSummary}
        className="icon-pill border-violet-500/30 bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-500/30 hover:bg-violet-500/20"
        title="Open a beautiful chronological recap of this session in a new tab"
        aria-label="Open session summary"
      >
        <Sparkles className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onExport}
        className="icon-pill"
        title="Download a standalone HTML snapshot of this session"
        aria-label="Export session snapshot"
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
  );
}
