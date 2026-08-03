import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Radio } from "lucide-react";
import { ChannelRow } from "@/components/NotificationsToggle";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  readBackgroundPushPref,
  writeBackgroundPushPref,
  syncPushPrefToSW,
} from "@/hooks/useNotifications";

/** Fleet-header bell: the background alert channel, the service worker
 * watching the fleet stream (needs a Murmur tab somewhere). */
export function FleetAlerts(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [bgPush, setBgPush] = useState(() => readBackgroundPushPref());
  const rootRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(rootRef, () => setOpen(false), open);

  // Re-assert the SW pref on mount: the fleet page is often the only page
  // open on the hub origin, so it owns priming the worker there.
  useEffect(() => {
    syncPushPrefToSW(readBackgroundPushPref());
  }, []);

  const supported = typeof window !== "undefined" && "Notification" in window;
  const granted = supported && Notification.permission === "granted";
  const anyOn = bgPush && granted;

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
        </div>
      )}
    </div>
  );
}
