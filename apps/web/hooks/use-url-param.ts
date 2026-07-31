"use client";

import { useEffect, useState } from "react";

/**
 * A single URL query-param backed by the History API (no Next navigation, so no
 * Suspense boundary needed). Reads the param on mount — so a reload/refresh with
 * the param set restores the value — and follows browser back/forward.
 */
export function useUrlParam(
  key: string,
): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    const read = () =>
      setValue(new URLSearchParams(window.location.search).get(key));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [key]);

  const set = (next: string | null) => {
    setValue(next);
    const params = new URLSearchParams(window.location.search);
    if (next) params.set(key, next);
    else params.delete(key);
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  };

  return [value, set];
}
