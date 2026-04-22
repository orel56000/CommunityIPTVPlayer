import { useEffect, useState } from "react";

export const useLocalStorageState = <T,>(key: string, initialValue: T) => {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    const raw = window.localStorage.getItem(key);
    if (!raw) return initialValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
};
