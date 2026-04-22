import { useEffect, useState } from "react";

/**
 * Mirror `value` after `delayMs` of stability. Useful for search fields over
 * large datasets: the <input> stays immediately responsive (controlled by the
 * caller's state), while heavy filtering runs against the debounced value.
 */
export const useDebouncedValue = <T>(value: T, delayMs: number): T => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
};
