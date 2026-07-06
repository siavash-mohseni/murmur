import { useEffect } from "react";
import type { PendingPermission, PendingQuestion } from "./useDashboardState";

const BASE_TITLE = "Murmur";

/**
 * When the Murmur tab is in the background AND a pending question or
 * permission exists, flash the document title between two states so the
 * tab bar shows something is waiting. As soon as the tab regains focus or
 * the prompt is answered, the title resets.
 *
 * This is the best a webapp can do for "bring me back" — browsers do not
 * permit JS to focus a tab without a user gesture. The desktop
 * notification's click handler is what actually pulls focus.
 */
export function useTitleAlert(
  pendingQuestion: PendingQuestion | null,
  pendingPermission: PendingPermission | null
): void {
  // The SSE state push replaces pendingQuestion/pendingPermission with fresh
  // object references on every snapshot, even when the prompt is unchanged.
  // The flash only depends on (a) whether something is pending and (b) which
  // kind it is, so key the effect on those primitives to avoid tearing down
  // and re-creating the interval and visibilitychange listener on every push.
  const hasPending = !!(pendingQuestion || pendingPermission);
  const kind = pendingPermission ? "Permission needed" : "Answer needed";

  useEffect(() => {
    const reset = (): void => {
      document.title = BASE_TITLE;
    };

    if (!hasPending) {
      reset();
      return;
    }

    let flipped = false;
    const apply = (): void => {
      if (document.visibilityState === "visible") {
        reset();
        return;
      }
      flipped = !flipped;
      document.title = flipped ? `🔔 ${kind} · Murmur` : `· · · ${kind}`;
    };

    apply();
    const id = window.setInterval(apply, 1000);

    const onVis = (): void => {
      if (document.visibilityState === "visible") reset();
      else apply();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      reset();
    };
  }, [hasPending, kind]);
}
