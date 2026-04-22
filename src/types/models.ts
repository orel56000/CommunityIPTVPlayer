export type PlaylistSourceType = "url" | "raw" | "file";

export interface PlaylistSource {
  type: PlaylistSourceType;
  value: string;
  originalName?: string;
}

export type PlaylistSection =
  | "live"
  | "movies"
  | "series"
  | "catchup"
  | "favorites"
  | "recents"
  | "continue"
  | "settings";

export type PlaylistKind = "series_episode" | "movie" | "live" | "unknown";

export interface ParsedPlaylistItem {
  id: string;
  sourceId: string;
  tvgId?: string;
  tvgName?: string;
  displayName: string;
  logo?: string;
  groupTitle?: string;
  url: string;
  kind: PlaylistKind;
  rawAttributes: Record<string, string>;
}

export interface PlaylistItem extends ParsedPlaylistItem {
  id: string;
  playlistId: string;
  title: string;
  streamUrl: string;
  tvgChno?: string;
  catchup?: string;
  catchupDays?: string;
  catchupSource?: string;
  duration: number | null;
  section: "live" | "movies" | "series" | "catchup";
  seriesTitle?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  xuiId?: string;
  /** Short, stable, user-shareable ID (derived from stream URL). */
  shareId?: string;
  metadata: Record<string, string>;
}

export interface SavedPlaylist {
  id: string;
  name: string;
  source: PlaylistSource;
  lastUpdatedAt: number;
  importErrors: string[];
  itemCount: number;
  items: PlaylistItem[];
}

export interface FavoriteEntry {
  itemId: string;
  playlistId: string;
  addedAt: number;
}

export interface RecentEntry {
  itemId: string;
  playlistId: string;
  viewedAt: number;
}

export interface PlaybackProgress {
  itemId: string;
  playlistId: string;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  updatedAt: number;
}

export interface ContinueWatchingEntry {
  itemId: string;
  playlistId: string;
  updatedAt: number;
}

export interface LiveChannel extends PlaylistItem {
  section: "live";
}

export interface MovieItem extends PlaylistItem {
  section: "movies";
}

export interface EpisodeItem extends PlaylistItem {
  section: "series";
  seriesTitle: string;
}

export interface SeriesItem {
  id: string;
  title: string;
  groupTitle?: string;
  logo?: string;
  episodes: EpisodeItem[];
}

export interface CatchupItem extends PlaylistItem {
  section: "catchup";
}

export interface ImportResult {
  items: PlaylistItem[];
  errors: string[];
}
