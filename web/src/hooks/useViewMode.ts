import { useCallback, useEffect, useState } from "react";

// Which rendering of the session the user wants: the expert dashboard
// ("operator") or the plain-language summary ("owner"). Persisted per browser
// in localStorage, same pattern as useNotifications.

export type ViewMode = "operator" | "owner";

const KEY = "murmur.view";

function readMode(): ViewMode {
  if (typeof window === "undefined") return "operator";
  try {
    return window.localStorage.getItem(KEY) === "owner" ? "owner" : "operator";
  } catch {
    return "operator";
  }
}

function writeMode(value: ViewMode): void {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    // ignore quota / private mode
  }
}

export function useViewMode(): { view: ViewMode; setView: (v: ViewMode) => void } {
  const [view, setViewState] = useState<ViewMode>(() => readMode());

  const setView = useCallback((v: ViewMode) => {
    setViewState(v);
    writeMode(v);
  }, []);

  // Cross-tab sync: the `storage` event fires in the OTHER tabs when any tab
  // writes the pref, so adopt the new value here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) setViewState(readMode());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { view, setView };
}
