import type { PlaylistItem } from "../../types/models";
import { ContentGrid } from "../browse/ContentGrid";
import { EmptyState } from "../shared/EmptyState";

interface FavoritesViewProps {
  items: PlaylistItem[];
  activeItemId?: string;
  favoriteSet: Set<string>;
  onPlay: (item: PlaylistItem) => void;
  onToggleFavorite: (item: PlaylistItem) => void;
}

export const FavoritesView = ({ items, activeItemId, favoriteSet, onPlay, onToggleFavorite }: FavoritesViewProps) => {
  if (!items.length) {
    return (
      <EmptyState
        title="No favorites yet"
        description="Favorite channels, movies, or episodes to keep quick access in this section."
      />
    );
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
