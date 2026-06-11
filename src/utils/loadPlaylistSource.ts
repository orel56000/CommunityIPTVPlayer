import type { ImportResult, PlaylistSource } from "../types/models";
import { parseM3u, parseM3uChunked } from "./parseM3u";
import { toProxyUrl } from "./proxyUrl";
import { importXtreamPlaylist, xtreamSourceFromUrl } from "./xtream";

interface LoadPlaylistSourceOptions {
  onProgress?: (value: number) => void;
  onStatus?: (label: string) => void;
  chunkSize?: number;
}

export interface LoadPlaylistSourceResult extends ImportResult {
  normalizedSource?: PlaylistSource;
  sourceContent: string;
}

const fetchPlaylistText = async (url: string): Promise<string> => {
  const response = await fetch(toProxyUrl(url), {
    headers: { accept: "application/x-mpegURL, application/vnd.apple.mpegurl, text/plain;q=0.9, */*;q=0.8" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch playlist (${response.status})`);
  }
  return response.text();
};

export const loadPlaylistSource = async (
  playlistId: string,
  source: PlaylistSource,
  fallbackText = "",
  options: LoadPlaylistSourceOptions = {},
): Promise<LoadPlaylistSourceResult> => {
  const { onProgress, onStatus, chunkSize } = options;
  const detectedXtream = source.type === "url" ? xtreamSourceFromUrl(source.value) : null;
  const xtreamConfig =
    source.type === "xtream" ? source.xtream ?? xtreamSourceFromUrl(source.value) : detectedXtream;
  if (source.type === "xtream" && !xtreamConfig) {
    throw new Error("Saved Xtream source is missing host or credentials.");
  }

  if (xtreamConfig) {
    const normalizedSource: PlaylistSource =
      source.type === "xtream"
        ? source
        : {
            type: "xtream",
            value: xtreamConfig.host,
            originalName: source.originalName,
            xtream: xtreamConfig,
          };
    const result = await importXtreamPlaylist(playlistId, xtreamConfig, { onProgress, onStatus });
    return {
      ...result,
      normalizedSource,
      sourceContent: JSON.stringify({ type: "xtream", host: xtreamConfig.host }),
    };
  }

  let text = fallbackText ?? "";
  if (source.type === "url") {
    onStatus?.("Downloading playlist...");
    onProgress?.(10);
    text = await fetchPlaylistText(source.value);
  }

  onStatus?.("Parsing playlist...");
  const parsed =
    text.length > 1_000_000
      ? await parseM3uChunked(playlistId, text, {
          chunkSize: chunkSize ?? (source.type === "file" ? 2500 : 4000),
          onProgress,
        })
      : parseM3u(playlistId, text);

  onProgress?.(100);
  return {
    ...parsed,
    sourceContent: text,
  };
};
