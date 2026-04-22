import { useMemo } from "react";
import type { PlaylistItem } from "../../types/models";
import { ContentCard } from "./ContentCard";
import { useInfiniteList } from "../../hooks/useInfiniteList";

interface ContentGridProps {
  items: PlaylistItem[];
  activeItemId?: string;
  favoriteSet: Set<string>;
  onPlay: (item: PlaylistItem) => void;
  onToggleFavorite: (item: PlaylistItem) => void;
}

export const ContentGrid = ({ items, favoriteSet, activeItemId, onPlay, onToggleFavorite }: ContentGridProps) => {
  const { visibleCount, hasMore, sentinelRef } = useInfiniteList(items.length, { initialCount: 60, step: 60 });
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visibleItems.map((item) => (
      <ContentCard
        key={item.id}
        item={item}
        isActive={item.id === activeItemId}
        isFavorite={favoriteSet.has(item.id)}
        onPlay={() => onPlay(item)}
        onToggleFavorite={() => onToggleFavorite(item)}
      />
        ))}
      </div>
      {hasMore ? (
        <div ref={sentinelRef} className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-center text-xs text-slate-400">
          Loading more results...
        </div>
      ) : null}
    </div>
  );
};
