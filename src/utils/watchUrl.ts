/**
 * Shareable episode URLs: `/watch/<encodeURIComponent(playlistName)>/<encodeURIComponent(shareId)>`.
 * Playlist is matched by exact display name; episode by `shareId` (stable for the same stream URL).
 */

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
