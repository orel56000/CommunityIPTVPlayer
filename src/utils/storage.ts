import type {
  ContinueWatchingEntry,
  FavoriteEntry,
  PlaybackProgress,
  RecentEntry,
  SavedPlaylist,
} from "../types/models";
import type { AppSettings } from "../types/player";

const STORAGE_KEY = "iptv-player-state-v1";
const clampVolume = (value: number): number => Math.min(2, Math.max(0, value));

export interface LastPlayedWatch {
  playlistName: string;
  shareId: string;
  itemId?: string;
}

export interface PersistedState {
  playlists: SavedPlaylist[];
  activePlaylistId: string | null;
  favorites: FavoriteEntry[];
  recents: RecentEntry[];
  progress: PlaybackProgress[];
  continueWatching: ContinueWatchingEntry[];
  settings: AppSettings;
  lastPlayedId: string | null;
  lastPlayedWatch: LastPlayedWatch | null;
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
    rightPanelOpen: true,
  },
  lastPlayedId: null,
  lastPlayedWatch: null,
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
          defaultVolume: (() => {
            const s = (parsed.settings ?? {}) as Partial<AppSettings>;
            if (typeof s.defaultVolume === "number" && Number.isFinite(s.defaultVolume)) {
              return clampVolume(s.defaultVolume);
            }
            return defaultState.settings.defaultVolume;
          })(),
          rememberedVolume: (() => {
            const s = (parsed.settings ?? {}) as Partial<AppSettings>;
            if (typeof s.rememberedVolume === "number" && Number.isFinite(s.rememberedVolume)) {
              return clampVolume(s.rememberedVolume);
            }
            if (typeof s.defaultVolume === "number" && Number.isFinite(s.defaultVolume)) {
              return clampVolume(s.defaultVolume);
            }
            return defaultState.settings.rememberedVolume;
          })(),
          volumePercentMode:
            typeof parsed.settings?.volumePercentMode === "boolean"
              ? parsed.settings.volumePercentMode
              : defaultState.settings.volumePercentMode,
        },
        lastPlayedWatch:
          parsed.lastPlayedWatch &&
          typeof parsed.lastPlayedWatch.playlistName === "string" &&
          typeof parsed.lastPlayedWatch.shareId === "string"
            ? {
                playlistName: parsed.lastPlayedWatch.playlistName,
                shareId: parsed.lastPlayedWatch.shareId,
                itemId:
                  typeof parsed.lastPlayedWatch.itemId === "string" ? parsed.lastPlayedWatch.itemId : undefined,
              }
            : defaultState.lastPlayedWatch,
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
