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

const compareEpisodes = (a: EpisodeItem, b: EpisodeItem): number => {
  const seasonA = a.season ?? 0;
  const seasonB = b.season ?? 0;
  if (seasonA !== seasonB) return seasonA - seasonB;
  const episodeA = a.episode ?? 0;
  const episodeB = b.episode ?? 0;
  if (episodeA !== episodeB) return episodeA - episodeB;
  return a.title.localeCompare(b.title);
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
