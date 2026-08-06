import type { EpisodeItem, PlaylistItem, SeriesItem } from "../types/models";

/**
 * Return distinct group titles in the order they first appear in `items`,
 * so the filter dropdown mirrors the order of the source playlist.
 */
export const getGroups = (items: PlaylistItem[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const group = item.groupTitle;
    if (!group) continue;
    if (seen.has(group)) continue;
    seen.add(group);
    out.push(group);
  }
  return out;
};

export const compareEpisodes = (a: EpisodeItem, b: EpisodeItem): number => {
  const seasonA = a.season ?? 0;
  const seasonB = b.season ?? 0;
  if (seasonA !== seasonB) return seasonA - seasonB;
  const episodeA = a.episode ?? 0;
  const episodeB = b.episode ?? 0;
  if (episodeA !== episodeB) return episodeA - episodeB;
  return a.title.localeCompare(b.title);
};

export const buildSeriesFromCatalog = (allItems: PlaylistItem[], catalogItems: PlaylistItem[]): SeriesItem[] => {
  const episodes = allItems.filter((item): item is EpisodeItem => item.kind === "series_episode");
  return catalogItems
    .filter((item) => item.kind === "series")
    .map((item) => ({
      id: item.id,
      title: item.title,
      groupTitle: item.groupTitle,
      logo: item.logo,
      backdrop: item.backdrop,
      description: item.description,
      rating: item.rating,
      releaseDate: item.releaseDate,
      episodes: episodes
        .filter((episode) => episode.parentSeriesId && episode.parentSeriesId === (item.xuiId ?? item.sourceId))
        .sort(compareEpisodes),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
};

/**
 * Find the `kind:"series"` catalog row that owns `episode`, WITHOUT relying on
 * that series' episodes already being loaded — Xtream episodes are fetched
 * lazily, so any lookup that scans `series.episodes` is circular for exactly
 * the series we still need to resolve.
 *
 * The key mirrors buildSeriesFromCatalog above: an episode's `parentSeriesId`
 * is the provider's raw series id, and the catalog row carries that same value
 * in both `sourceId` and `xuiId`.
 *
 * Returns the catalog item — callers driving a lazy load must pass its
 * COMPOSITE `.id`, not `parentSeriesId`.
 *
 * No title fallback on purpose: XUI catalogs routinely list one show under
 * several categories/qualities, so a title match can resolve the wrong series.
 * M3U episodes have no `parentSeriesId` and need no lazy load (groupSeries
 * already yields full episode lists), so null is the right answer for them.
 */
export const findSeriesCatalogItem = (
  items: PlaylistItem[],
  episode: Pick<PlaylistItem, "parentSeriesId">,
): PlaylistItem | null => {
  const parentId = episode.parentSeriesId;
  if (!parentId) return null;
  return (
    items.find(
      (item) =>
        item.kind === "series" &&
        (item.xuiId === parentId || item.sourceId === parentId || item.id === parentId),
    ) ?? null
  );
};

export const groupSeries = (items: PlaylistItem[]): SeriesItem[] => {
  const seriesItems = items.filter((item) => item.kind === "series_episode");
  const bucket = new Map<string, EpisodeItem[]>();
  for (const item of seriesItems) {
    const seriesKey = item.seriesTitle ?? item.title.replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}.*/, "");
    const value = bucket.get(seriesKey) ?? [];
    value.push(item as EpisodeItem);
    bucket.set(seriesKey, value);
  }
  return Array.from(bucket.entries())
    .map(([title, episodes]) => ({
      id: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      groupTitle: episodes[0]?.groupTitle,
      logo: episodes[0]?.logo,
      backdrop: episodes[0]?.backdrop,
      description: episodes.find((episode) => episode.description)?.description,
      rating: episodes.find((episode) => episode.rating)?.rating,
      releaseDate: episodes.find((episode) => episode.releaseDate)?.releaseDate,
      episodes: [...episodes].sort(compareEpisodes),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
};

export const getNextEpisode = (series: SeriesItem[], currentId: string): EpisodeItem | null => {
  for (const show of series) {
    const index = show.episodes.findIndex((ep) => ep.id === currentId);
    if (index >= 0 && show.episodes[index + 1]) return show.episodes[index + 1];
  }
  return null;
};
