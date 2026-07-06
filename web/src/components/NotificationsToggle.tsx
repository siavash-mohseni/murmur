import { useRef, useState } from "react";
import { Bell, BellOff, Monitor, Radio, Apple } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import type { useNotifications } from "@/hooks/useNotifications";

type Props = ReturnType<typeof useNotifications>;

export function ChannelRow({
  icon,
  label,
  hint,
  on,
  disabled,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition ${
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-white/[0.06]"
      }`}
      role="switch"
      aria-checked={on}
    >
      <span className="text-zinc-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200">{label}</div>
        <div className="text-[11px] text-zinc-500">{hint}</div>
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition ${
          on ? "bg-emerald-500/70" : "bg-white/15"
        }`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            on ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

export function NotificationsToggle({
  permission,
  supported,
  enabled,
  channels,
  nativeSupported,
  setBrowser,
  setPush,
  setNative,
}: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  // Nothing to choose if the browser has no Notification API and native isn't
  // available either.
  if (!supported && !nativeSupported) return null;

  const blocked = permission === "denied";
  const on = enabled;
  const toneClass = on
    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30 hover:bg-emerald-500/20"
    : "text-zinc-400";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`icon-pill ${toneClass}`}
        title="Choose alert channels"
        aria-label="Alert channels"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {on ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 min-w-[16rem] overflow-hidden rounded-md border border-white/10 bg-zinc-900 shadow-lg ring-1 ring-black/30"
        >
          <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Alert channels
          </div>
          {blocked && supported && (
            <div className="px-3 pb-2 text-[11px] text-amber-300">
              Browser notifications are blocked. Enable them in site settings to
              use the in-tab and background channels.
            </div>
          )}
          <ChannelRow
            icon={<Monitor className="h-4 w-4" />}
            label="In this tab"
            hint="Toast while Murmur is focused"
            on={channels.browser && permission === "granted"}
            disabled={!supported || blocked}
            onToggle={() => void setBrowser(!channels.browser)}
          />
          <ChannelRow
            icon={<Radio className="h-4 w-4" />}
            label="Background push"
            hint="Fires even when the tab is hidden"
            on={channels.push && permission === "granted"}
            disabled={!supported || blocked}
            onToggle={() => void setPush(!channels.push)}
          />
          {nativeSupported && (
            <ChannelRow
              icon={<Apple className="h-4 w-4" />}
              label="Native macOS"
              hint="System modal with sound"
              on={channels.native}
              onToggle={() => void setNative(!channels.native)}
            />
          )}
        </div>
      )}
    </div>
  );
}
