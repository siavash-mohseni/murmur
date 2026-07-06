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

interface ServerResult {
  status?: "ready" | "pending" | "unavailable";
  summary?: string;
}

/**
 * @param requests the visible beats that want a summary (id + the text to
 *   summarize). Safe to pass a fresh array each render; work is deduped by id.
 * @returns a map of id to its ready summary. Ids still pending or unavailable
 *   are absent, so the caller falls back to the raw text.
 */
export function useOwnerSummaries(requests: SummaryRequest[]): Record<string, string> {
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  // Terminal or in-progress status per id, so the effect never re-requests an
  // id that is already done or waiting on a scheduled retry.
  const statusRef = useRef<Map<string, "pending" | "ready" | "unavailable">>(new Map());
  const retriesRef = useRef<Map<string, number>>(new Map());
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

  return summaries;
}
