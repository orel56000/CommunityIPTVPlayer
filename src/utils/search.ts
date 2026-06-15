import type { PlaylistItem } from "../types/models";
import { getShareId } from "./shareId";

export interface FilterInput {
  query: string;
  group: string;
  favoritesOnly: boolean;
  favoriteItemIds: Set<string>;
}

const FUZZY_MIN_SCORE = 12;

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
  const metadataText = Object.values(item.metadata ?? {}).join(" ");
  const text = normalize(
    `${item.title} ${item.groupTitle ?? ""} ${item.tvgName ?? ""} ${item.seriesTitle ?? ""} ${item.episodeTitle ?? ""} ${item.description ?? ""} ${item.tvgId ?? ""} ${item.xuiId ?? ""} ${getShareId(item)} ${metadataText}`,
  );
  searchTextCache.set(item, text);
  return text;
};

const fuzzyTokenScore = (haystack: string, needle: string): number => {
  if (!needle) return 100;
  if (haystack.includes(needle)) {
    const index = haystack.indexOf(needle);
    const prefixBonus = index === 0 ? 25 : 0;
    const lengthRatio = needle.length / Math.max(haystack.length, 1);
    return 60 + lengthRatio * 25 + prefixBonus;
  }

  const words = haystack.split(/[\s|/\-_.]+/);
  for (const word of words) {
    if (word.startsWith(needle)) {
      return 55 + (needle.length / Math.max(word.length, 1)) * 15;
    }
  }

  let cursor = 0;
  let gaps = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  for (let i = 0; i < needle.length; i += 1) {
    const found = haystack.indexOf(needle[i], cursor);
    if (found === -1) return 0;
    if (found === cursor) {
      consecutive += 1;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 1;
    }
    gaps += found - cursor;
    cursor = found + 1;
  }

  const gapPenalty = gaps / (haystack.length + 1);
  const consecutiveBonus = maxConsecutive / needle.length;
  return Math.max(5, 35 - gapPenalty * 20 + consecutiveBonus * 15);
};

const scoreItem = (item: PlaylistItem, query: string): number => {
  const normalized = normalize(query);
  if (!normalized) return 0;

  const title = normalize(item.title);
  const fullText = buildSearchText(item);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;

  let total = 0;
  for (const token of tokens) {
    const titleScore = fuzzyTokenScore(title, token);
    const textScore = fuzzyTokenScore(fullText, token);
    const best = Math.max(titleScore, textScore * 0.85);
    if (best < FUZZY_MIN_SCORE) return 0;
    total += best;
  }

  let score = total / tokens.length;
  if (title === normalized) score += 200;
  else if (title.startsWith(normalized)) score += 80;
  else if (fullText.startsWith(normalized)) score += 40;

  return score;
};

export const searchByQuery = (items: PlaylistItem[], query: string): PlaylistItem[] => {
  const normalized = normalize(query);
  if (!normalized) return items;

  const matches: Array<{ item: PlaylistItem; score: number }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const score = scoreItem(item, normalized);
    if (score >= FUZZY_MIN_SCORE) matches.push({ item, score });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.map((match) => match.item);
};

export const filterByQuery = searchByQuery;

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
    if (normalized && scoreItem(item, normalized) < FUZZY_MIN_SCORE) continue;
    out.push(item);
  }

  if (!normalized) return out;
  return searchByQuery(out, normalized);
};
