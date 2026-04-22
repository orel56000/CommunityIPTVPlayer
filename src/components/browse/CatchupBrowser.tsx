import { useMemo } from "react";
import type { PlaylistItem } from "../../types/models";
import { useInfiniteList } from "../../hooks/useInfiniteList";

interface CatchupBrowserProps {
  items: PlaylistItem[];
  onPlay: (item: PlaylistItem) => void;
}

export const CatchupBrowser = ({ items, onPlay }: CatchupBrowserProps) => {
  const { visibleCount, hasMore, sentinelRef } = useInfiniteList(items.length, { initialCount: 80, step: 80 });
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);

  return (
    <div className="space-y-2">
      {visibleItems.map((item) => (
      <div key={item.id} className="panel flex items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="line-clamp-1 text-sm font-semibold">{item.title}</p>
          <p className="line-clamp-1 text-xs text-slate-400">
            {item.groupTitle ?? "Ungrouped"} - Catch-up {item.catchupDays ? `${item.catchupDays} days` : "metadata detected"}
          </p>
        </div>
        <button className="btn" type="button" onClick={() => onPlay(item)}>
          Play
        </button>
      </div>
      ))}
      {hasMore ? (
        <div ref={sentinelRef} className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-center text-xs text-slate-400">
          Loading more catch-up entries...
        </div>
      ) : null}
    {!items.length ? (
      <div className="panel p-4 text-sm text-slate-400">
        No catch-up capable entries detected. Availability depends on provider metadata and stream support.
      </div>
    ) : null}
    </div>
  );
};
