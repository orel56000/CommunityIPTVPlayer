import { useState } from "react";
import { parseM3uChunked } from "../utils/parseM3u";
import type { PlaylistSource, SavedPlaylist } from "../types/models";
import { now } from "../utils/time";

const createPlaylistId = (): string => `pl-${Math.random().toString(36).slice(2, 10)}`;

export interface PlaylistImportPayload {
  playlist: SavedPlaylist;
  sourceContent: string;
}

export const usePlaylistImport = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  const importFromSource = async (
    name: string,
    source: PlaylistSource,
    fallbackText?: string,
  ): Promise<PlaylistImportPayload | null> => {
    setLoading(true);
    setError(null);
    setProgress(0);
    setProgressLabel("Preparing import...");
    try {
      const playlistId = createPlaylistId();
      let text = fallbackText ?? "";
      if (source.type === "url") {
        setProgressLabel("Downloading playlist...");
        const response = await fetch(source.value);
        if (!response.ok) {
          throw new Error(`Failed to fetch playlist (${response.status})`);
        }
        text = await response.text();
      }
      setProgressLabel("Parsing playlist...");
      const parsed = await parseM3uChunked(playlistId, text, {
        chunkSize: source.type === "file" ? 2500 : 4000,
        onProgress: setProgress,
      });
      return {
        playlist: {
          id: playlistId,
          name,
          source,
          lastUpdatedAt: now(),
          importErrors: parsed.errors,
          itemCount: parsed.items.length,
          items: parsed.items,
        },
        sourceContent: text,
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import playlist.");
      return null;
    } finally {
      setProgress(100);
      setProgressLabel(null);
      setLoading(false);
    }
  };

  return { importFromSource, loading, error, setError, progress, progressLabel };
};
