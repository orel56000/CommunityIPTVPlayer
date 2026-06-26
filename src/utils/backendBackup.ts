/**
 * Durable playlist backup via the local helper relay.
 *
 * The browser keeps playlists in localStorage (metadata) + IndexedDB (items).
 * Both live in the WebView storage profile, which can be wiped by a reinstall or
 * a profile change. To make playlists survive that, the relay also persists a
 * copy to a plain file on disk (`/api/backup`); we push to it after changes and
 * pull from it on startup when local storage comes up empty.
 *
 * Only active when the local relay is available (bundled app, or the web app
 * with the helper running). Pure web with no helper is unaffected.
 */

import { playlistDb } from "./indexedDb";
import { STORAGE_KEY } from "./storage";
import { getRelayBase } from "./secureUrl";
import { getRelayStatus } from "./relayDiscovery";
import type { PlaylistItem, SavedPlaylist } from "../types/models";

const backupUrl = (): string => `${getRelayBase()}/api/backup`;

interface PlaylistBackup {
  id: string;
  items: PlaylistItem[];
  source: string | null;
}

interface BackupBlob {
  v: 1;
  savedAt: number;
  /** Raw localStorage value (playlist metadata, settings, favorites, progress…). */
  stateRaw: string;
  /** Per-playlist items + original source, mirrored from IndexedDB. */
  playlists: PlaylistBackup[];
}

const readPlaylistMeta = (): SavedPlaylist[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { playlists?: SavedPlaylist[] };
    return Array.isArray(parsed.playlists) ? parsed.playlists : [];
  } catch {
    return [];
  }
};

let lastPushedJson = "";

/** Push the current playlists to the relay's on-disk backup (best effort). */
export const backupToBackend = async (): Promise<void> => {
  if (getRelayStatus() !== "available") return;
  const stateRaw = localStorage.getItem(STORAGE_KEY);
  if (!stateRaw) return;
  const meta = readPlaylistMeta();
  // Don't overwrite a good backup with an empty one (e.g. transient empty state).
  if (meta.length === 0) return;

  try {
    const playlists: PlaylistBackup[] = [];
    for (const pl of meta) {
      const [items, source] = await Promise.all([
        playlistDb.loadPlaylistItems(pl.id).catch(() => [] as PlaylistItem[]),
        playlistDb.loadPlaylistSourceContent(pl.id).catch(() => null),
      ]);
      playlists.push({ id: pl.id, items, source });
    }
    const blob: BackupBlob = { v: 1, savedAt: Date.now(), stateRaw, playlists };
    const json = JSON.stringify(blob);
    if (json === lastPushedJson) return; // nothing changed since last push
    await fetch(backupUrl(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json,
      cache: "no-store",
    });
    lastPushedJson = json;
  } catch {
    /* best effort — never block the UI on backup */
  }
};

/**
 * If local storage has no playlists but the relay has a backup, restore it
 * (writes localStorage + IndexedDB). Returns true when something was restored —
 * the caller should reload so React reads the restored state.
 */
export const restoreFromBackendIfEmpty = async (): Promise<boolean> => {
  if (getRelayStatus() !== "available") return false;
  if (readPlaylistMeta().length > 0) return false; // already have playlists

  try {
    const res = await fetch(backupUrl(), { cache: "no-store" });
    if (res.status !== 200) return false;
    const blob = (await res.json()) as BackupBlob;
    if (!blob?.stateRaw || !Array.isArray(blob.playlists)) return false;

    for (const pl of blob.playlists) {
      try {
        await playlistDb.savePlaylistItems(pl.id, pl.items ?? []);
        if (pl.source) await playlistDb.savePlaylistSourceContent(pl.id, pl.source);
      } catch {
        /* keep restoring the rest */
      }
    }
    localStorage.setItem(STORAGE_KEY, blob.stateRaw);
    return true;
  } catch {
    return false;
  }
};
