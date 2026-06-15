import type { PlaylistItem, SeriesItem } from "../types/models";

export const resolveRecentItemId = (
  item: PlaylistItem,
  playlistItems: PlaylistItem[],
  groupedSeries: SeriesItem[],
): string => {
  if (item.kind === "series") return item.id;
  if (item.kind !== "series_episode" && item.section !== "series") return item.id;

  const catalog = playlistItems.find(
    (entry) =>
      entry.kind === "series" &&
      (entry.xuiId === item.parentSeriesId ||
        entry.sourceId === item.parentSeriesId ||
        entry.id === item.parentSeriesId),
  );
  if (catalog) return catalog.id;

  const show = groupedSeries.find((series) => series.episodes.some((episode) => episode.id === item.id));
  if (!show) return item.id;

  const catalogByShowId = playlistItems.find((entry) => entry.kind === "series" && entry.id === show.id);
  return catalogByShowId?.id ?? show.id;
};

const isSeriesEpisodeItem = (item: PlaylistItem): boolean =>
  item.kind === "series_episode" || (item.section === "series" && item.kind !== "series");

export const resolveRecentDisplayItem = (
  itemId: string,
  playlistId: string,
  playlistItems: PlaylistItem[],
  groupedSeries: SeriesItem[],
): PlaylistItem | null => {
  const direct = playlistItems.find((item) => item.id === itemId);
  if (direct) {
    if (!isSeriesEpisodeItem(direct)) return direct;
    const seriesId = resolveRecentItemId(direct, playlistItems, groupedSeries);
    return resolveRecentDisplayItem(seriesId, playlistId, playlistItems, groupedSeries);
  }

  const show = groupedSeries.find((series) => series.id === itemId);
  if (!show) return null;

  const catalog = playlistItems.find((entry) => entry.kind === "series" && entry.id === show.id);
  if (catalog) return catalog;

  const firstEpisode = show.episodes[0];
  if (!firstEpisode) return null;
  const episodeItem = playlistItems.find((item) => item.id === firstEpisode.id);
  if (!episodeItem) return null;

  return {
    ...episodeItem,
    id: show.id,
    kind: "series",
    section: "series",
    title: show.title,
    logo: show.logo ?? episodeItem.logo,
    backdrop: show.backdrop ?? episodeItem.backdrop,
    description: show.description ?? episodeItem.description,
    rating: show.rating ?? episodeItem.rating,
    releaseDate: show.releaseDate ?? episodeItem.releaseDate,
  };
};
