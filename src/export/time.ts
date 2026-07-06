// Wall-clock formatting shared by the HTML builders and the dashboard UI
// (web/src/lib/format.ts re-exports this). Dependency-free and value-pure.

export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Unparseable timestamp: lift out an HH:MM:SS if the string contains one,
    // otherwise show a neutral placeholder. (The old `iso.slice(11,19)` assumed
    // a fixed ISO layout and emitted a meaningless mid-string fragment for any
    // non-ISO value.)
    const m = iso.match(/\d{2}:\d{2}:\d{2}/);
    return m ? m[0] : "--:--:--";
  }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
