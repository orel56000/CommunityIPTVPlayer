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

/**
 * How the video maps onto its box, mirroring the fit modes common players
 * expose (VLC, Kodi, ...) instead of guessing at it automatically:
 * - contain: show the whole picture, may letterbox/pillarbox (default).
 * - cover: crop to fill the box completely, no bars, aspect preserved.
 * - fill: stretch to fill the box exactly, distorting the image if needed.
 * - none: native pixel size, no scaling.
 */
export type VideoFitMode = "contain" | "cover" | "fill" | "none";

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
  /** How the video fits its box; persisted so it's a set-once preference. */
  videoFitMode: VideoFitMode;
  /** Logs every fetch (frontend + relay) and pops a live log window (native only). */
  debugMode: boolean;
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
}

export interface UIFilters {
  query: string;
  selectedGroup: string;
  favoritesOnly: boolean;
}
