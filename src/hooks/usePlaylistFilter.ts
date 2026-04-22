import { useMemo } from "react";
import { filterItems } from "../utils/search";
import type { PlaylistItem } from "../types/models";
import type { UIFilters } from "../types/player";

export const usePlaylistFilter = (
  items: PlaylistItem[],
  filters: UIFilters,
  favoriteSet: Set<string>,
): PlaylistItem[] =>
  useMemo(
    () =>
      filterItems(items, {
        query: filters.query,
        group: filters.selectedGroup,
        favoritesOnly: filters.favoritesOnly,
        favoriteItemIds: favoriteSet,
      }),
    [items, filters.query, filters.selectedGroup, filters.favoritesOnly, favoriteSet],
  );
