import { useEffect, useState } from "react";
import { useNow } from "@/hooks/useNow";
import type { FleetSnapshot, FleetSessionSummary } from "../../../src/shared-types";

export type { FleetSnapshot, FleetSessionSummary };

const HEARTBEAT_STALE_MS = 10_000;

export interface UseFleetResult {
  fleet: FleetSnapshot | null;
  isStale: boolean;
}

// Live fleet feed from the hub's own SSE stream. Only mounted on the hub
// origin (the session servers never emit `fleet` events).
export function useFleet(): UseFleetResult {
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(() => Date.now());
  const now = useNow(1_000);

  useEffect(() => {
    const source = new EventSource("/events");
    source.addEventListener("fleet", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as { fleet: FleetSnapshot };
        setFleet(event.fleet);
        setLastHeartbeat(Date.now());
      } catch {
        // drop malformed frame, keep last good fleet
      }
    });
    source.addEventListener("heartbeat", () => setLastHeartbeat(Date.now()));
    return () => source.close();
  }, []);

  return { fleet, isStale: now - lastHeartbeat > HEARTBEAT_STALE_MS };
}
