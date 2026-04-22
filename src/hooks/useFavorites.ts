import { useMemo } from "react";
import type { FavoriteEntry } from "../types/models";
import { now } from "../utils/time";

export const useFavorites = (favorites: FavoriteEntry[], setFavorites: (next: FavoriteEntry[]) => void) => {
  const favoriteSet = useMemo(() => new Set(favorites.map((entry) => entry.itemId)), [favorites]);

  const toggleFavorite = (playlistId: string, itemId: string) => {
    if (favoriteSet.has(itemId)) {
      setFavorites(favorites.filter((entry) => entry.itemId !== itemId));
      return;
    }
    setFavorites([{ playlistId, itemId, addedAt: now() }, ...favorites]);
  };

  const clearFavorites = () => setFavorites([]);

  return { favoriteSet, toggleFavorite, clearFavorites };
};
