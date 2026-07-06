import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, Copy, Radio, Smartphone, X } from "lucide-react";
import { renderSVG } from "uqr";
import { ChannelRow } from "@/components/NotificationsToggle";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  readBackgroundPushPref,
  writeBackgroundPushPref,
  syncPushPrefToSW,
} from "@/hooks/useNotifications";
import { usePush } from "@/hooks/usePush";

interface PairInfo {
  ok: boolean;
  lan: boolean;
  tls: boolean;
  relay: string | null;
  port: number;
  token: string;
  urls: string[];
}

type PairState =
  | { phase: "loading" }
  | { phase: "forbidden" }
  | { phase: "error" }
  | { phase: "ready"; info: PairInfo };

// The command shown when LAN mode is off. The hub only rereads MURMUR_LAN at
// boot, so enabling it means restarting the hub process.
const LAN_SNIPPET =
  "pkill -f 'murmur/dist/hub.js'; MURMUR_LAN=1 nohup node ~/.claude/mcp-servers/murmur/dist/hub.js >/dev/null 2>&1 &";

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-pill shrink-0 text-zinc-400"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

/** "Pair phone" header button plus its modal: QR code carrying the hub URL
 * and machine token, or instructions to open the LAN bind when it is off. */
export function PairPhoneButton(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PairState>({ phase: "loading" });
  const [urlIdx, setUrlIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    setState({ phase: "loading" });
    setUrlIdx(0);
    let cancelled = false;
    void fetch("/api/pair")
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          setState({ phase: "forbidden" });
          return;
        }
        if (!res.ok) {
          setState({ phase: "error" });
          return;
        }
        setState({ phase: "ready", info: (await res.json()) as PairInfo });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const url = state.phase === "ready" ? state.info.urls[urlIdx] : undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="period-pill inline-flex items-center gap-1.5"
        title="Pair your phone"
      >
        <Smartphone className="h-4 w-4 text-zinc-400" />
        <span className="hidden sm:inline">Pair phone</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Pair your phone"
            className="w-full max-w-md space-y-4 rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-50">Pair your phone</h2>
              <button
                type="button"
                className="icon-pill text-zinc-400"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {state.phase === "loading" && (
              <div className="py-8 text-center text-sm text-zinc-500">Fetching pairing info…</div>
            )}
            {state.phase === "forbidden" && (
              <p className="text-sm text-zinc-400">
                Pairing info is only served to the Mac itself. Open the fleet
                view on that machine to show the QR code.
              </p>
            )}
            {state.phase === "error" && (
              <p className="text-sm text-rose-300">Could not fetch pairing info from the hub.</p>
            )}

            {state.phase === "ready" && !url && !state.info.lan && (
              <div className="space-y-3 text-sm text-zinc-400">
                <p>
                  The hub is listening on loopback only, so your phone cannot
                  reach it yet. Restart it in LAN mode:
                </p>
                <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-3 py-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-zinc-300">
                    {LAN_SNIPPET}
                  </code>
                  <CopyButton text={LAN_SNIPPET} />
                </div>
                <p className="text-xs text-zinc-500">
                  Add <code className="font-mono text-zinc-400">MURMUR_LAN=1</code> to your shell
                  profile to make it permanent, then reopen this dialog. For
                  pairing that works away from home, point{" "}
                  <code className="font-mono text-zinc-400">MURMUR_RELAY</code> at a Murmur relay
                  instead.
                </p>
              </div>
            )}

            {state.phase === "ready" && url && (
              <div className="space-y-3">
                <div className="flex justify-center">
                  {/* QR codes need a light quiet zone to scan reliably on a dark page. */}
                  <div
                    className="w-56 rounded-lg bg-white p-3 [&>svg]:h-auto [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: renderSVG(url, { border: 1 }) }}
                  />
                </div>
                {state.info.urls.length > 1 && (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {state.info.urls.map((u, i) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setUrlIdx(i)}
                        className={`rounded px-2 py-0.5 font-mono text-[11px] transition ${
                          i === urlIdx
                            ? "bg-blue-500/20 text-blue-200 ring-1 ring-inset ring-blue-400/40"
                            : "bg-white/[0.06] text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {new URL(u).host}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-3 py-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-zinc-300">
                    {url}
                  </code>
                  <CopyButton text={url} />
                </div>
                <p className="text-xs text-amber-300/90">
                  This QR carries the machine token: anyone who scans it can
                  watch and steer your sessions. Treat it like a password.
                </p>
                <p className="text-xs text-zinc-500">
                  {url.startsWith("https:")
                    ? url === `${state.info.relay}/#t=${state.info.token}`
                      ? "This is the relay origin: it works from anywhere, and lock-screen push works on it."
                      : "HTTPS origin: lock-screen push works on this address."
                    : " For lock-screen push with the browser closed, use an HTTPS origin (a relay, or MURMUR_TLS_CERT/MURMUR_TLS_KEY on the hub)."}
                </p>
              </div>
            )}

            {state.phase === "ready" && !url && state.info.lan && (
              <p className="text-sm text-zinc-400">
                LAN mode is on, but no non-loopback interface was found. Join a
                network and reopen this dialog.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Fleet-header bell: the two alert channels that matter on the pager
 * surface. "Background alerts" is the service worker watching the fleet
 * stream (needs a Murmur tab somewhere); "Push to this device" is real Web
 * Push through the hub (works with the browser closed, Allow/Deny on the
 * lock screen). */
export function FleetAlerts(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [bgPush, setBgPush] = useState(() => readBackgroundPushPref());
  const push = usePush();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(rootRef, () => setOpen(false), open);

  // Re-assert the SW pref on mount: the fleet page is often the only page
  // open on the hub origin, so it owns priming the worker there.
  useEffect(() => {
    syncPushPrefToSW(readBackgroundPushPref());
  }, []);

  const supported = typeof window !== "undefined" && "Notification" in window;
  const granted = supported && Notification.permission === "granted";
  const anyOn = (bgPush && granted) || push.subscribed;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`icon-pill ${
          anyOn
            ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30 hover:bg-emerald-500/20"
            : "text-zinc-400"
        }`}
        title="Fleet alert channels"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {anyOn ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 min-w-[18rem] overflow-hidden rounded-md border border-white/10 bg-zinc-900 shadow-lg ring-1 ring-black/30"
        >
          <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Fleet alerts
          </div>
          <ChannelRow
            icon={<Radio className="h-4 w-4" />}
            label="Background alerts"
            hint="While a Murmur tab is open, even hidden"
            on={bgPush && granted}
            disabled={!supported}
            onToggle={() => {
              const next = !bgPush;
              if (next && supported && Notification.permission === "default") {
                void Notification.requestPermission().then((p) => {
                  if (p !== "granted") return;
                  setBgPush(true);
                  writeBackgroundPushPref(true);
                });
                return;
              }
              setBgPush(next);
              writeBackgroundPushPref(next);
            }}
          />
          <ChannelRow
            icon={<Smartphone className="h-4 w-4" />}
            label="Push to this device"
            hint={
              push.supported
                ? "Even with the browser closed. Allow/Deny from the lock screen."
                : "Needs a secure context (localhost or an HTTPS hub)"
            }
            on={push.subscribed}
            disabled={!push.supported || push.busy}
            onToggle={() => {
              if (push.subscribed) void push.disable();
              else void push.enable();
            }}
          />
        </div>
      )}
    </div>
  );
}
