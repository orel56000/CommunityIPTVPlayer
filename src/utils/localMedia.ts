/**
 * Playing a video file the user dropped on the player, with no playlist behind
 * it.
 *
 * The file becomes a synthetic PlaylistItem backed by a blob: URL so it flows
 * through the normal player pipeline (title, details panel, subtitles) without
 * any special-casing downstream. It deliberately lives in its own playlist id:
 * everything that persists — recents, progress, last-played — keys off the
 * playlist, and a blob URL is dead the moment the app reloads, so those paths
 * must skip it rather than store a link to nothing.
 */

import type { PlaylistItem } from "../types/models";

/** Playlist id that marks an item as a local drop rather than library content. */
export const LOCAL_PLAYLIST_ID = "__local__";

export const isLocalItem = (item: Pick<PlaylistItem, "playlistId"> | null | undefined): boolean =>
  item?.playlistId === LOCAL_PLAYLIST_ID;

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "webm", "mkv", "avi", "ts", "m2ts", "mts",
  "mpg", "mpeg", "wmv", "flv", "ogv", "3gp",
]);

const SUBTITLE_EXTENSIONS = new Set(["srt", "vtt", "ass", "ssa"]);

/** Extensions the browser has no chance with, mapped for a clearer warning. */
const EXTENSION_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  mts: "video/mp2t",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  "3gp": "video/3gpp",
};

export const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

export const isSubtitleFile = (file: Pick<File, "name" | "type">): boolean =>
  SUBTITLE_EXTENSIONS.has(fileExtension(file.name)) || file.type === "text/vtt";

export const isVideoFile = (file: Pick<File, "name" | "type">): boolean =>
  // Extension first: a dropped .mkv often arrives with an empty or wrong type,
  // and "video/..." alone would miss it.
  VIDEO_EXTENSIONS.has(fileExtension(file.name)) || file.type.startsWith("video/");

/** Best-guess MIME for canPlayType, since dropped files often carry none. */
export const guessVideoMime = (file: Pick<File, "name" | "type">): string =>
  file.type.startsWith("video/") ? file.type : (EXTENSION_MIME[fileExtension(file.name)] ?? "");

export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

/** Drop the extension for the on-screen title, keeping the full name in metadata. */
export const titleFromFileName = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.trim() || name;
};

export interface LocalVideoFile {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

/**
 * Build the synthetic item for a dropped video. `objectUrl` must be revoked by
 * the caller when it is replaced — this module never owns it.
 */
export const buildLocalVideoItem = (file: LocalVideoFile, objectUrl: string): PlaylistItem => ({
  id: `local::${file.name}::${file.size}::${file.lastModified}`,
  playlistId: LOCAL_PLAYLIST_ID,
  sourceId: "local",
  title: titleFromFileName(file.name),
  displayName: titleFromFileName(file.name),
  tvgName: titleFromFileName(file.name),
  groupTitle: "Local file",
  url: objectUrl,
  streamUrl: objectUrl,
  kind: "movie",
  section: "movies",
  duration: null,
  rawAttributes: {},
  metadata: {
    file: file.name,
    size: formatFileSize(file.size),
    ...(guessVideoMime(file) ? { format: guessVideoMime(file) } : {}),
  },
});
