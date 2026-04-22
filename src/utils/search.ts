import type { PlaylistItem } from "../types/models";
import { getShareId } from "./shareId";

export interface FilterInput {
  query: string;
  group: string;
  favoritesOnly: boolean;
  favoriteItemIds: Set<string>;
}

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Per-item cache for the concatenated, lowercased search text.
 * WeakMap keyed on the item object so:
 *   - cost is paid once per item (not per keystroke),
 *   - memory is released automatically when the playlist is swapped out.
 */
const searchTextCache = new WeakMap<PlaylistItem, string>();

const buildSearchText = (item: PlaylistItem): string => {
  const cached = searchTextCache.get(item);
  if (cached !== undefined) return cached;
  const text = normalize(
    `${item.title} ${item.groupTitle ?? ""} ${item.tvgName ?? ""} ${item.seriesTitle ?? ""} ${item.episodeTitle ?? ""} ${item.tvgId ?? ""} ${item.xuiId ?? ""} ${getShareId(item)}`,
  );
  searchTextCache.set(item, text);
  return text;
};

export const filterItems = (items: PlaylistItem[], input: FilterInput): PlaylistItem[] => {
  const normalized = normalize(input.query);
  const group = normalize(input.group);
  const groupFilterActive = group !== "" && group !== "all";
  const favoritesActive = input.favoritesOnly;
  const favoriteIds = input.favoriteItemIds;
  const out: PlaylistItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (groupFilterActive && normalize(item.groupTitle ?? "") !== group) continue;
    if (favoritesActive && !favoriteIds.has(item.id)) continue;
    if (normalized && !buildSearchText(item).includes(normalized)) continue;
    out.push(item);
  }
  return out;
};

export const filterByQuery = (items: PlaylistItem[], query: string): PlaylistItem[] => {
  const normalized = normalize(query);
  if (!normalized) return items;
  const out: PlaylistItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (buildSearchText(item).includes(normalized)) out.push(item);
  }
  return out;
};
