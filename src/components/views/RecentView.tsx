import type { PlaylistItem } from "../../types/models";
import { ContentGrid } from "../browse/ContentGrid";
import { EmptyState } from "../shared/EmptyState";

interface RecentViewProps {
  items: PlaylistItem[];
  favoriteSet: Set<string>;
  activeItemId?: string;
  onPlay: (item: PlaylistItem) => void;
  onToggleFavorite: (item: PlaylistItem) => void;
}

export const RecentView = ({ items, favoriteSet, activeItemId, onPlay, onToggleFavorite }: RecentViewProps) => {
  if (!items.length) {
    return <EmptyState title="No recently played items" description="Start playing content and it will appear here." />;
  }
  return (
    <ContentGrid
      items={items}
      activeItemId={activeItemId}
      favoriteSet={favoriteSet}
      onPlay={onPlay}
      onToggleFavorite={onToggleFavorite}
    />
  );
};
