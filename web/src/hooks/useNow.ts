import { useEffect, useState } from "react";

/**
 * A shared wall-clock signal. Returns a `Date.now()` value that re-renders the
 * consumer every `intervalMs` milliseconds. Replaces the ad-hoc setInterval
 * tickers that App and several panels each spun up, so one tick source drives
 * all time-derived UI. Callers needing 1s precision (SessionMeta, ProgressPanel)
 * pass 1000.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
