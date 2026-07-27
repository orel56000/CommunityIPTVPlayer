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
  /** Initial playback volume for new installs / reset (0-2 = 0%-200%). */
  defaultVolume: number;
  /** Last used playback volume (0-2 = 0%-200%), persisted between visits. */
  rememberedVolume: number;
  /** When true, player shows % and a numeric field plus a compact slider. */
  volumePercentMode: boolean;
  /** Suggest the next episode when the end credits are detected. */
  creditsDetection: boolean;
  /** With that suggestion up, auto-advance after a cancellable countdown. */
  creditsAutoNext: boolean;
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
}

export interface UIFilters {
  query: string;
  selectedGroup: string;
  favoritesOnly: boolean;
}
