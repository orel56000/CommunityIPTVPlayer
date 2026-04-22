import { useMemo } from "react";
import type { SavedPlaylist } from "../types/models";

export const useActivePlaylist = (playlists: SavedPlaylist[], activeId: string | null): SavedPlaylist | null =>
  useMemo(() => playlists.find((playlist) => playlist.id === activeId) ?? null, [playlists, activeId]);
