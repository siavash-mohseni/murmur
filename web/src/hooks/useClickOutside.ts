import { useEffect } from "react";

/**
 * Calls `onClose` when a mousedown lands outside the referenced element OR when
 * Escape is pressed. Skips when `enabled` is false (default true), so dropdowns
 * can attach the listeners only while open. The handler reads `ref.current`
 * lazily, so it stays correct even if the node mounts after the effect runs.
 * Uses "mousedown" plus "keydown"/Escape to match the dropdowns' previous
 * close behavior exactly (each previously had both an outside-click and an
 * Escape handler).
 */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T>,
  onClose: () => void,
  enabled: boolean = true
): void {
  useEffect(() => {
    if (!enabled) return;
    const onDocClick = (e: MouseEvent): void => {
      const node = ref.current;
      if (node && !node.contains(e.target as Node)) {
        onClose();
      }
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ref, onClose, enabled]);
}
