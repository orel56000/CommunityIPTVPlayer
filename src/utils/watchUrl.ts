/**
 * Shareable episode URLs: `/watch/<encodeURIComponent(playlistName)>/<encodeURIComponent(shareId)>`.
 * Playlist is matched by exact display name; episode by `shareId` (stable for the same stream URL).
 */

import type { PlaylistItem, SavedPlaylist } from "../types/models";
import { itemMatchesShareId } from "./shareId";

export const WATCH_PATH_PREFIX = "/watch";

export const buildWatchPath = (playlistName: string, shareId: string): string =>
  `${WATCH_PATH_PREFIX}/${encodeURIComponent(playlistName)}/${encodeURIComponent(shareId)}`;

export const buildEpisodeUrl = (playlistName: string, shareId: string): string => {
  if (typeof window === "undefined") return buildWatchPath(playlistName, shareId);
  return new URL(buildWatchPath(playlistName, shareId), window.location.origin).href;
};

export const parseWatchPath = (pathname: string): { playlistName: string; shareId: string } | null => {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (!path.startsWith(`${WATCH_PATH_PREFIX}/`)) return null;
  const rest = path.slice(WATCH_PATH_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const encPl = rest.slice(0, slash);
  const encShare = rest.slice(slash + 1);
  if (!encPl || !encShare || encShare.includes("/")) return null;
  try {
    return {
      playlistName: decodeURIComponent(encPl),
      shareId: decodeURIComponent(encShare),
    };
  } catch {
    return null;
  }
};

export interface WatchDeepLinkHints {
  itemId?: string | null;
}

export type WatchDeepLinkResolution =
  | { status: "pending" }
  | { status: "found"; item: PlaylistItem; playlist: SavedPlaylist }
  | { status: "not_found"; playlist: SavedPlaylist | null };

const isPlaylistHydrating = (playlist: SavedPlaylist): boolean =>
  (playlist.itemCount ?? 0) > 0 && playlist.items.length === 0;

const anyPlaylistHydrating = (playlists: SavedPlaylist[]): boolean => playlists.some(isPlaylistHydrating);

const findInItems = (items: PlaylistItem[], shareId: string, hintedItemId?: string | null): PlaylistItem | undefined => {
  const byShare = items.find((item) => itemMatchesShareId(item, shareId));
  if (byShare) return byShare;
  if (!hintedItemId) return undefined;
  return items.find((item) => item.id === hintedItemId);
};

export const resolveWatchDeepLink = (
  playlists: SavedPlaylist[],
  target: { playlistName: string; shareId: string },
  hints: WatchDeepLinkHints = {},
): WatchDeepLinkResolution => {
  const playlist = playlists.find((p) => p.name === target.playlistName) ?? null;

  if (!playlist) {
    if (anyPlaylistHydrating(playlists)) return { status: "pending" };
    return { status: "not_found", playlist: null };
  }

  if (isPlaylistHydrating(playlist)) return { status: "pending" };

  let item = findInItems(playlist.items, target.shareId, hints.itemId);
  if (item) return { status: "found", item, playlist };

  for (const candidate of playlists) {
    if (candidate.id === playlist.id || isPlaylistHydrating(candidate)) continue;
    item = findInItems(candidate.items, target.shareId, hints.itemId);
    if (item) {
      const hosting = playlists.find((p) => p.id === item!.playlistId) ?? playlist;
      return { status: "found", item, playlist: hosting };
    }
  }

  if (anyPlaylistHydrating(playlists)) return { status: "pending" };

  return { status: "not_found", playlist };
};
