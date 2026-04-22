import type {
  ContinueWatchingEntry,
  FavoriteEntry,
  PlaybackProgress,
  RecentEntry,
  SavedPlaylist,
} from "../types/models";
import type { AppSettings } from "../types/player";

const STORAGE_KEY = "iptv-player-state-v1";

export interface PersistedState {
  playlists: SavedPlaylist[];
  activePlaylistId: string | null;
  favorites: FavoriteEntry[];
  recents: RecentEntry[];
  progress: PlaybackProgress[];
  continueWatching: ContinueWatchingEntry[];
  settings: AppSettings;
  lastPlayedId: string | null;
  section: string;
}

const defaultState: PersistedState = {
  playlists: [],
  activePlaylistId: null,
  favorites: [],
  recents: [],
  progress: [],
  continueWatching: [],
  settings: {
    autoplay: true,
    defaultVolume: 0.8,
    rememberedVolume: 0.8,
    volumePercentMode: false,
    theme: "dark",
    sidebarCollapsed: false,
  },
  lastPlayedId: null,
  section: "live",
};

const hasWindow = (): boolean => typeof window !== "undefined";

const trimText = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

const compactPlaylist = (playlist: SavedPlaylist): SavedPlaylist => ({
  ...playlist,
  name: trimText(playlist.name, 160),
  importErrors: playlist.importErrors.slice(0, 8),
  itemCount: playlist.itemCount ?? playlist.items.length,
  items: [],
});

const compactState = (state: PersistedState): PersistedState => ({
  ...state,
  playlists: state.playlists.map((playlist) => compactPlaylist(playlist)),
  favorites: state.favorites.slice(0, 500),
  recents: state.recents.slice(0, 500),
  progress: state.progress.slice(0, 500),
  continueWatching: state.continueWatching.slice(0, 500),
});

const persistJson = (state: PersistedState): boolean => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

export const storage = {
  load(): PersistedState {
    if (!hasWindow()) return defaultState;
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) return defaultState;
    try {
      const parsed = JSON.parse(value) as Partial<PersistedState>;
      return {
        ...defaultState,
        ...parsed,
        playlists: (parsed.playlists ?? []).map((playlist) => ({
          ...playlist,
          itemCount: playlist.itemCount ?? playlist.items?.length ?? 0,
          items: Array.isArray(playlist.items) ? playlist.items : [],
        })),
        settings: {
          ...defaultState.settings,
          ...(parsed.settings ?? {}),
          rememberedVolume: (() => {
            const s = (parsed.settings ?? {}) as Partial<AppSettings>;
            if (typeof s.rememberedVolume === "number" && Number.isFinite(s.rememberedVolume)) {
              return Math.min(1, Math.max(0, s.rememberedVolume));
            }
            if (typeof s.defaultVolume === "number" && Number.isFinite(s.defaultVolume)) {
              return Math.min(1, Math.max(0, s.defaultVolume));
            }
            return defaultState.settings.rememberedVolume;
          })(),
          volumePercentMode:
            typeof parsed.settings?.volumePercentMode === "boolean"
              ? parsed.settings.volumePercentMode
              : defaultState.settings.volumePercentMode,
        },
      };
    } catch {
      return defaultState;
    }
  },
  save(state: PersistedState): { ok: boolean; degraded: boolean } {
    if (!hasWindow()) return { ok: true, degraded: false };
    const compact = compactState(state);
    if (persistJson(compact)) return { ok: true, degraded: false };

    return { ok: false, degraded: false };
  },
  clear(): void {
    if (!hasWindow()) return;
    window.localStorage.removeItem(STORAGE_KEY);
  },
};

export const makeItemKey = (playlistId: string, itemId: string): string => `${playlistId}::${itemId}`;
