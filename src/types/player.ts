import type { PlaylistItem } from "./models";

export interface PlayerState {
  currentItem: PlaylistItem | null;
  loading: boolean;
  error: string | null;
  muted: boolean;
  volume: number;
  isPlaying: boolean;
  canPip: boolean;
}

export interface AppSettings {
  autoplay: boolean;
  /** Initial volume for new installs / reset. */
  defaultVolume: number;
  /** Last used playback volume (0–1), persisted between visits. */
  rememberedVolume: number;
  /** When true, player shows % and a numeric field plus a compact slider. */
  volumePercentMode: boolean;
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
}

export interface UIFilters {
  query: string;
  selectedGroup: string;
  favoritesOnly: boolean;
}
