import { useEffect, useRef, useState } from "react";

// Fetches plain-language summaries for the owner timeline's Claude beats from
// POST /api/owner/summary. Summaries are generated server-side on demand, so the
// first response for a beat is usually "pending"; we retry on a timer until it
// is ready (or the server says it is unavailable, e.g. summaries are turned off
// or the input was unusable). Each id is requested once, deduped across renders.

export interface SummaryRequest {
  id: string;
  text: string;
}

const RETRY_MS = 4000;
const MAX_RETRIES = 15;
// A reported failure is shared across beats and usually fixable (an expired
// login), so keep asking on a slow cadence instead of writing the beat off.
// Without this the server's own retry is unreachable: the hook would never ask
// again, so summaries stayed dead until a reload even after the fix.
const FAILURE_RETRY_MS = 15_000;
const FAILURE_MAX_RETRIES = 40;

interface ServerResult {
  status?: "ready" | "pending" | "unavailable";
  summary?: string;
  reason?: string;
}

export interface OwnerSummaries {
  /** id to its ready summary. Ids still pending or unavailable are absent, so
   * the caller falls back to the raw text. */
  summaries: Record<string, string>;
  /** Set only when the server explains why it could not summarize, which it
   * does for a failing nested CLI but not for summaries being switched off or
   * an unusable input. Absent therefore means "nothing worth telling the
   * user", which is why the banner keys off it. */
  unavailableReason?: string;
}

/**
 * @param requests the visible beats that want a summary (id + the text to
 *   summarize). Safe to pass a fresh array each render; work is deduped by id.
 * @returns the ready summaries, plus a reason when the server reported a
 *   fixable failure (see OwnerSummaries).
 */
export function useOwnerSummaries(requests: SummaryRequest[]): OwnerSummaries {
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [unavailableReason, setUnavailableReason] = useState<string | undefined>();
  // Terminal or in-progress status per id, so the effect never re-requests an
  // id that is already done or waiting on a scheduled retry.
  const statusRef = useRef<Map<string, "pending" | "ready" | "unavailable">>(new Map());
  const retriesRef = useRef<Map<string, number>>(new Map());
  const failuresRef = useRef<Map<string, number>>(new Map());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Stable signature so the effect runs only when the set of ids changes.
  const idsKey = requests.map((r) => r.id).join(",");

  useEffect(() => {
    let cancelled = false;
    const timers = timersRef.current;

    async function fetchOne(id: string, text: string): Promise<void> {
      let data: ServerResult;
      try {
        const res = await fetch("/api/owner/summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, text }),
        });
        if (!res.ok) {
          if (!cancelled) statusRef.current.set(id, "unavailable");
          return;
        }
        data = (await res.json()) as ServerResult;
      } catch {
        if (!cancelled) statusRef.current.set(id, "unavailable");
        return;
      }
      if (cancelled) return;

      if (data.status === "ready" && data.summary) {
        statusRef.current.set(id, "ready");
        setSummaries((prev) => ({ ...prev, [id]: data.summary as string }));
        // A summary getting through means whatever was broken is working again.
        // Clear the banner and the failure counts so the other beats, which
        // failed for the same shared cause, get a fresh run of attempts.
        setUnavailableReason(undefined);
        failuresRef.current.clear();
        return;
      }
      if (data.status === "pending") {
        statusRef.current.set(id, "pending");
        const tries = (retriesRef.current.get(id) ?? 0) + 1;
        retriesRef.current.set(id, tries);
        if (tries > MAX_RETRIES) {
          statusRef.current.set(id, "unavailable");
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!cancelled) void fetchOne(id, text);
        }, RETRY_MS);
        timers.add(timer);
        return;
      }
      statusRef.current.set(id, "unavailable");
      // No reason means summaries are off or the input was unusable, which is
      // terminal. A reason means something broke that may come back.
      if (!data.reason) return;
      setUnavailableReason(data.reason);
      const failures = (failuresRef.current.get(id) ?? 0) + 1;
      failuresRef.current.set(id, failures);
      if (failures > FAILURE_MAX_RETRIES) return;
      const retry = setTimeout(() => {
        timers.delete(retry);
        if (!cancelled) void fetchOne(id, text);
      }, FAILURE_RETRY_MS);
      timers.add(retry);
    }

    for (const r of requests) {
      if (statusRef.current.has(r.id)) continue;
      statusRef.current.set(r.id, "pending");
      void fetchOne(r.id, r.text);
    }

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      // Any id still "pending" had its in-flight fetch (or scheduled retry)
      // abandoned above, and the guarded status writes will now no-op. Drop
      // those entries so the next effect run re-requests them — otherwise the
      // `statusRef.has(id)` guard would skip them forever and the beat would be
      // stuck showing raw text. Terminal statuses (ready/unavailable) are kept.
      for (const [id, st] of statusRef.current) {
        if (st === "pending") statusRef.current.delete(id);
      }
    };
    // requests is intentionally excluded: idsKey captures the only change we act
    // on, and the per-id statusRef guard dedupes everything else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return { summaries, unavailableReason };
}
