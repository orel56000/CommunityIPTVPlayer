import { useEffect, useRef, useState } from "react";

interface UseInfiniteListOptions {
  initialCount?: number;
  step?: number;
}

export const useInfiniteList = (totalCount: number, options: UseInfiniteListOptions = {}) => {
  const initialCount = Math.max(1, options.initialCount ?? 80);
  const step = Math.max(1, options.step ?? 80);
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(initialCount);
  }, [totalCount, initialCount]);

  useEffect(() => {
    if (visibleCount >= totalCount) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    if (typeof IntersectionObserver === "undefined") {
      setVisibleCount(totalCount);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount((prev) => Math.min(totalCount, prev + step));
      },
      { rootMargin: "320px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [totalCount, visibleCount, step]);

  return {
    visibleCount,
    hasMore: visibleCount < totalCount,
    sentinelRef,
  };
};
