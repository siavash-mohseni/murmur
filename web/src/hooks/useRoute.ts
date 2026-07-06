import { useCallback, useEffect, useState } from "react";

// Minimal path router: two surfaces (fleet home, /s/<key> drill-down) do not
// justify a router dependency. pushState keeps the hub origin stable so a
// drill-down is one history entry, and back returns to the fleet.
export interface RouteState {
  path: string;
  navigate(to: string): void;
}

export function useRoute(): RouteState {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);

  return { path, navigate };
}
