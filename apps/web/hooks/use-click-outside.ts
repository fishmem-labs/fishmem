import { type RefObject, useEffect, useRef } from "react";

/**
 * Calls `handler` when a pointer-down happens outside `ref`. Used to dismiss
 * popovers/menus on an outside click. `enabled` lets callers only listen while
 * the menu is open. The handler is kept in a ref so passing an inline arrow
 * does not re-subscribe the listener on every render.
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  enabled = true,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const el = ref.current;
      if (!el || el.contains(event.target as Node)) return;
      handlerRef.current();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [ref, enabled]);
}
