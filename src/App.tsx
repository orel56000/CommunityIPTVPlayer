import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AppSettings, UIFilters } from "./types/player";
import type { PlaylistItem, PlaylistSection, SavedPlaylist } from "./types/models";
import { storage } from "./utils/storage";
import { getShareId } from "./utils/shareId";
import { buildEpisodeUrl, buildWatchPath, parseWatchPath } from "./utils/watchUrl";
import { getGroups, getNextEpisode, groupSeries } from "./utils/grouping";
import { useActivePlaylist } from "./hooks/useActivePlaylist";
import { usePlaylistImport } from "./hooks/usePlaylistImport";
import { useFavorites } from "./hooks/useFavorites";
import { useRecents } from "./hooks/useRecents";
import { useContinueWatching } from "./hooks/useContinueWatching";
import { usePlaylistFilter } from "./hooks/usePlaylistFilter";
import { usePlayer } from "./hooks/usePlayer";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { PlaylistImportModal } from "./components/playlist/PlaylistImportModal";
import { VideoPlayer } from "./components/player/VideoPlayer";
import { PlaylistManager } from "./components/playlist/PlaylistManager";
import { SectionTabs } from "./components/layout/SectionTabs";
import { SearchBar } from "./components/browse/SearchBar";
import { FilterBar } from "./components/browse/FilterBar";
import { ChannelList } from "./components/browse/ChannelList";
import { ContentGrid } from "./components/browse/ContentGrid";
import { SeriesBrowser } from "./components/browse/SeriesBrowser";
import { CatchupBrowser } from "./components/browse/CatchupBrowser";
import { FavoritesView } from "./components/views/FavoritesView";
import { RecentView } from "./components/views/RecentView";
import { ContinueWatchingView } from "./components/views/ContinueWatchingView";
import { SettingsView } from "./components/views/SettingsView";
import { EmptyState } from "./components/shared/EmptyState";
import { ErrorState } from "./components/shared/ErrorState";
import { InstallAppBanner } from "./components/shared/InstallAppBanner";
import { DetailsPanel } from "./components/panels/DetailsPanel";
import { PlayerNavBar } from "./components/player/PlayerNavBar";
import { now } from "./utils/time";
import { parseM3u, parseM3uChunked } from "./utils/parseM3u";
import { playlistDb } from "./utils/indexedDb";
import { filterByQuery } from "./utils/search";

const initialFilters: UIFilters = {
  query: "",
  selectedGroup: "all",
  favoritesOnly: false,
};

const App = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const deepLink = useMemo(() => parseWatchPath(location.pathname), [location.pathname]);

  const [state, setState] = useState(storage.load);
  const [importOpen, setImportOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [filters, setFilters] = useState<UIFilters>(initialFilters);
  const debouncedQuery = useDebouncedValue(filters.query, 180);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const lastProgressRef = useRef<Record<string, number>>({});
  const syncedPlaylistIdsRef = useRef<Set<string>>(new Set());
  const restoredLastVisitRef = useRef(false);
  const appliedDeepLinkKey = useRef<string | null>(null);
  const [visitRestorePause, setVisitRestorePause] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);

  const setPlaylists = (playlists: SavedPlaylist[]) => setState((prev) => ({ ...prev, playlists }));
  const setActivePlaylistId = (activePlaylistId: string | null) => setState((prev) => ({ ...prev, activePlaylistId }));
  const setFavorites = (favorites: typeof state.favorites) => setState((prev) => ({ ...prev, favorites }));
  const setRecents = (recents: typeof state.recents) => setState((prev) => ({ ...prev, recents }));
  const setProgress = (progress: typeof state.progress) => setState((prev) => ({ ...prev, progress }));
  const setContinueWatching = (continueWatching: typeof state.continueWatching) =>
    setState((prev) => ({ ...prev, continueWatching }));
  const setSettings = (settings: AppSettings) => setState((prev) => ({ ...prev, settings }));
  const setSection = (section: PlaylistSection) => setState((prev) => ({ ...prev, section }));
  const setLastPlayedId = (lastPlayedId: string | null) => setState((prev) => ({ ...prev, lastPlayedId }));

  useEffect(() => {
    const result = storage.save(state);
    if (!result.ok) {
      setStorageError("Local storage is full. Please remove some playlists or clear app data from Settings.");
      return;
    }
    if (result.degraded) {
      setStorageError("Storage is near browser quota. Some non-critical metadata was compacted to keep your app state saved.");
      return;
    }
    setStorageError(null);
  }, [state]);

  useEffect(() => {
    const needsHydration = state.playlists.filter((playlist) => playlist.itemCount > 0 && playlist.items.length === 0);
    if (!needsHydration.length) return;

    let active = true;
    void (async () => {
      const entries = await Promise.all(
        needsHydration.map(async (playlist) => {
          try {
            const items = await playlistDb.loadPlaylistItems(playlist.id);
            if (items.length > 0) {
              return [playlist.id, items] as const;
            }
            const sourceContent = await playlistDb.loadPlaylistSourceContent(playlist.id);
            if (!sourceContent) {
              return [playlist.id, [] as PlaylistItem[]] as const;
            }
            const parsed =
              sourceContent.length > 1_000_000
                ? await parseM3uChunked(playlist.id, sourceContent)
                : parseM3u(playlist.id, sourceContent);
            if (parsed.items.length > 0) {
              await playlistDb.savePlaylistItems(playlist.id, parsed.items);
            }
            return [playlist.id, parsed.items] as const;
          } catch (err) {
            console.error("[IPTV] playlist hydrate failed", playlist.id, err);
            return [playlist.id, [] as PlaylistItem[]] as const;
          }
        }),
      );
      if (!active) return;
      const itemMap = new Map(entries);
      setState((prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) => {
          const loaded = itemMap.get(playlist.id);
          if (!loaded || playlist.items.length > 0) return playlist;
          return { ...playlist, items: loaded, itemCount: loaded.length || playlist.itemCount };
        }),
      }));
    })();

    return () => {
      active = false;
    };
  }, [state.playlists]);

  useEffect(() => {
    const candidates = state.playlists.filter((playlist) => playlist.items.length > 0 && !syncedPlaylistIdsRef.current.has(playlist.id));
    if (!candidates.length) return;
    void (async () => {
      for (const playlist of candidates) {
        try {
          await playlistDb.savePlaylistItems(playlist.id, playlist.items);
          syncedPlaylistIdsRef.current.add(playlist.id);
        } catch {
          // Keep app usable even if IndexedDB fails in restricted environments.
        }
      }
    })();
  }, [state.playlists]);

  useEffect(() => {
    if (state.settings.theme === "light") document.documentElement.classList.add("light");
    else document.documentElement.classList.remove("light");
  }, [state.settings.theme]);

  const activePlaylist = useActivePlaylist(state.playlists, state.activePlaylistId);
  const playlistItems = useMemo(() => activePlaylist?.items ?? [], [activePlaylist]);
  const groupedSeries = useMemo(() => groupSeries(playlistItems), [playlistItems]);
  const {
    importFromSource,
    loading: importing,
    error: importError,
    setError: setImportError,
    progress: importProgress,
    progressLabel: importProgressLabel,
  } = usePlaylistImport();

  const { favoriteSet, toggleFavorite, clearFavorites } = useFavorites(state.favorites, setFavorites);
  const { pushRecent, clearRecents } = useRecents(state.recents, setRecents);
  const { updateProgress, clearContinueWatching, removeContinueWatching, getResumePosition } = useContinueWatching(
    state.continueWatching,
    setContinueWatching,
    state.progress,
    setProgress,
  );

  const progressByItemId = useMemo(() => {
    const map = new Map<string, typeof state.progress[number]>();
    for (const entry of state.progress) map.set(entry.itemId, entry);
    return map;
  }, [state.progress]);

  const initialPlayerVolume = state.settings.rememberedVolume ?? state.settings.defaultVolume;
  const { playerState, setCurrentItem, setError, setPlaying, setVolume, setMuted } = usePlayer(initialPlayerVolume);

  useEffect(() => {
    if (deepLink) {
      restoredLastVisitRef.current = true;
      return;
    }
    if (restoredLastVisitRef.current) return;
    if (!state.lastPlayedId) {
      restoredLastVisitRef.current = true;
      return;
    }

    const stillHydrating = state.playlists.some((p) => (p.itemCount ?? 0) > 0 && p.items.length === 0);
    const found = state.playlists.flatMap((p) => p.items).find((i) => i.id === state.lastPlayedId);

    if (found) {
      restoredLastVisitRef.current = true;
      setVisitRestorePause(true);
      setCurrentItem(found);
      if (found.playlistId !== state.activePlaylistId) setActivePlaylistId(found.playlistId);
      setSection(found.section);
      return;
    }

    if (stillHydrating) return;
    restoredLastVisitRef.current = true;
  }, [deepLink, state.playlists, state.lastPlayedId, state.activePlaylistId, setCurrentItem, setSection, setActivePlaylistId]);

  useEffect(() => {
    if (!deepLink) {
      appliedDeepLinkKey.current = null;
      setDeepLinkError(null);
    }
  }, [deepLink]);

  useEffect(() => {
    const item = playerState.currentItem;
    if (!item) return;
    const pl = state.playlists.find((p) => p.id === item.playlistId);
    if (!pl) return;
    const target = buildWatchPath(pl.name, getShareId(item));
    if (location.pathname !== target) navigate(target, { replace: true });
  }, [playerState.currentItem, state.playlists, location.pathname, navigate]);

  const handlePlayerVolume = useCallback(
    (next: number) => {
      const clamped = Math.min(1, Math.max(0, next));
      setVolume(clamped);
      if (clamped > 0 && playerState.muted) setMuted(false);
    },
    [playerState.muted, setMuted, setVolume],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setState((prev) => {
        const v = playerState.volume;
        if (Math.abs((prev.settings.rememberedVolume ?? 0) - v) < 0.0005) return prev;
        return { ...prev, settings: { ...prev.settings, rememberedVolume: v } };
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [playerState.volume]);

  const sectionItems = useMemo(() => {
    switch (state.section) {
      case "live":
        return playlistItems.filter((item) => item.kind === "live" || item.kind === "unknown");
      case "movies":
        return playlistItems.filter((item) => item.kind === "movie");
      case "series":
        return playlistItems.filter((item) => item.kind === "series_episode");
      case "catchup":
        return playlistItems.filter((item) => item.section === "catchup");
      default:
        return playlistItems;
    }
  }, [playlistItems, state.section]);
  const groups = useMemo(() => getGroups(sectionItems), [sectionItems]);

  useEffect(() => {
    setFilters((prev) => ({ ...prev, query: "" }));
  }, [state.section]);

  useEffect(() => {
    if (filters.selectedGroup !== "all" && !groups.includes(filters.selectedGroup)) {
      setFilters((prev) => ({ ...prev, selectedGroup: "all" }));
    }
  }, [state.section, groups, filters.selectedGroup]);

  const filtersForSearch = useMemo(
    () => ({ ...filters, query: debouncedQuery }),
    [filters, debouncedQuery],
  );
  const filteredItems = usePlaylistFilter(sectionItems, filtersForSearch, favoriteSet);
  const seriesForView = useMemo(
    () => (state.section === "series" ? groupSeries(filteredItems) : []),
    [state.section, filteredItems],
  );

  useEffect(() => {
    if (!["live", "movies", "series", "catchup"].includes(state.section)) return;

    const kindCounts = playlistItems.reduce<Record<string, number>>((acc, it) => {
      const k = it.kind ?? "undefined";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

    const payload = {
      section: state.section,
      activePlaylistId: state.activePlaylistId,
      playlistItemsTotal: playlistItems.length,
      activePlaylist: activePlaylist
        ? { id: activePlaylist.id, name: activePlaylist.name, itemCount: activePlaylist.itemCount, itemsInMemory: activePlaylist.items.length }
        : null,
      kindCounts,
      filtersSnapshot: { query: filters.query, selectedGroup: filters.selectedGroup, favoritesOnly: filters.favoritesOnly },
      sectionItemsLength: sectionItems.length,
      filteredItemsLength: filteredItems.length,
      groupsLength: groups.length,
    };

    const maxFullLog = 300;
    if (sectionItems.length <= maxFullLog) {
      console.log("[IPTV browse] tab or playlist load — sectionItems + filteredItems", {
        ...payload,
        sectionItems,
        filteredItems,
      });
    } else {
      console.log("[IPTV browse] large playlist — preview only (full arrays on window.__iptv*)", {
        ...payload,
        sectionItemsPreview: sectionItems.slice(0, 40),
        filteredItemsPreview: filteredItems.slice(0, 40),
      });
      (window as unknown as { __iptvSectionItems?: PlaylistItem[]; __iptvFilteredItems?: PlaylistItem[] }).__iptvSectionItems =
        sectionItems;
      (window as unknown as { __iptvSectionItems?: PlaylistItem[]; __iptvFilteredItems?: PlaylistItem[] }).__iptvFilteredItems =
        filteredItems;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only log on tab / playlist load / active playlist change, not on every search keystroke
  }, [state.section, playlistItems.length, state.activePlaylistId]);

  const favoritesItems = useMemo(
    () =>
      state.favorites
        .map((entry) => state.playlists.flatMap((playlist) => playlist.items).find((item) => item.id === entry.itemId))
        .filter(Boolean) as PlaylistItem[],
    [state.favorites, state.playlists],
  );

  const recentsItems = useMemo(
    () =>
      state.recents
        .map((entry) => state.playlists.flatMap((playlist) => playlist.items).find((item) => item.id === entry.itemId))
        .filter(Boolean) as PlaylistItem[],
    [state.recents, state.playlists],
  );

  const continueItems = useMemo(
    () =>
      state.continueWatching
        .map((entry) => state.playlists.flatMap((playlist) => playlist.items).find((item) => item.id === entry.itemId))
        .filter(Boolean) as PlaylistItem[],
    [state.continueWatching, state.playlists],
  );
  const filteredFavoritesItems = useMemo(() => filterByQuery(favoritesItems, debouncedQuery), [favoritesItems, debouncedQuery]);
  const filteredRecentsItems = useMemo(() => filterByQuery(recentsItems, debouncedQuery), [recentsItems, debouncedQuery]);
  const filteredContinueItems = useMemo(() => filterByQuery(continueItems, debouncedQuery), [continueItems, debouncedQuery]);

  const currentResultCount = useMemo(() => {
    switch (state.section) {
      case "live":
      case "movies":
      case "series":
      case "catchup":
        return filteredItems.length;
      case "favorites":
        return filteredFavoritesItems.length;
      case "recents":
        return filteredRecentsItems.length;
      case "continue":
        return filteredContinueItems.length;
      default:
        return undefined;
    }
  }, [state.section, filteredItems.length, filteredFavoritesItems.length, filteredRecentsItems.length, filteredContinueItems.length]);

  const handlePlay = useCallback((item: PlaylistItem) => {
    setVisitRestorePause(false);
    setCurrentItem(item);
    setLastPlayedId(item.id);
    pushRecent(item.playlistId, item.id);
  }, [pushRecent, setCurrentItem, setLastPlayedId]);

  useEffect(() => {
    if (!deepLink) return;
    const { playlistName, shareId } = deepLink;

    if (playerState.currentItem && getShareId(playerState.currentItem) !== shareId) {
      return;
    }

    const stillHydrating = state.playlists.some((p) => (p.itemCount ?? 0) > 0 && p.items.length === 0);
    const playlist = state.playlists.find((p) => p.name === playlistName);

    if (!playlist) {
      if (!stillHydrating && state.playlists.length > 0) {
        setDeepLinkError(
          `No playlist named “${playlistName}”. Links use the exact playlist name — rename or import a playlist to match.`,
        );
      }
      return;
    }

    const item = playlist.items.find((it) => getShareId(it) === shareId);
    if (!item) {
      if (!stillHydrating && playlist.items.length > 0) {
        setDeepLinkError(
          `That stream is not in playlist “${playlistName}”. Both people need the same stream URL in the M3U so the episode ID matches.`,
        );
      }
      return;
    }

    const key = `${playlistName}\0${shareId}`;
    if (playerState.currentItem && getShareId(playerState.currentItem) === shareId) {
      const hosting = state.playlists.find((p) => p.id === playerState.currentItem!.playlistId);
      if (hosting?.name === playlistName) {
        appliedDeepLinkKey.current = key;
        setDeepLinkError(null);
        return;
      }
    }

    if (appliedDeepLinkKey.current === key) return;
    appliedDeepLinkKey.current = key;
    setDeepLinkError(null);

    setActivePlaylistId(playlist.id);
    setSection(item.section);
    if (item.kind === "series_episode") {
      const grouped = groupSeries(playlist.items);
      const show = grouped.find((s) => s.episodes.some((ep) => ep.id === item.id));
      if (show) {
        setFilters((prev) => ({ ...prev, query: "", selectedGroup: "all", favoritesOnly: false }));
        setSelectedSeriesId(show.id);
      }
    }
    handlePlay(item);
  }, [deepLink, handlePlay, playerState.currentItem, state.playlists, setActivePlaylistId, setSection, setFilters, setSelectedSeriesId]);

  const handleToggleFavorite = (item: PlaylistItem) => toggleFavorite(item.playlistId, item.id);

  const currentNextEpisode = useMemo(() => {
    const current = playerState.currentItem;
    if (!current || current.kind !== "series_episode") return null;
    return getNextEpisode(groupedSeries, current.id);
  }, [groupedSeries, playerState.currentItem]);

  const openSeriesForEpisode = (episode: PlaylistItem) => {
    const show = groupedSeries.find((series) => series.episodes.some((ep) => ep.id === episode.id));
    if (!show) return;
    setFilters((prev) => ({ ...prev, query: "", selectedGroup: "all", favoritesOnly: false }));
    setSelectedSeriesId(show.id);
    setSection("series");
  };

  const goToBrowseFromDetails = useCallback(
    (item: PlaylistItem) => {
      if (item.playlistId !== state.activePlaylistId) setActivePlaylistId(item.playlistId);
      setFilters((prev) => ({ ...prev, query: "", selectedGroup: "all", favoritesOnly: false }));
      if (item.kind === "series_episode") {
        const pl = state.playlists.find((p) => p.id === item.playlistId);
        if (!pl) return;
        const grouped = groupSeries(pl.items);
        const show = grouped.find((s) => s.episodes.some((ep) => ep.id === item.id));
        if (show) {
          setSelectedSeriesId(show.id);
          setSection("series");
        }
        return;
      }
      setSection(item.section as PlaylistSection);
    },
    [state.activePlaylistId, state.playlists, setActivePlaylistId, setFilters, setSelectedSeriesId, setSection],
  );

  const handleImport = async (name: string, source: { type: "url" | "raw" | "file"; value: string; originalName?: string }, text?: string) => {
    const payload = await importFromSource(name, source, text);
    if (!payload) return;
    const { playlist, sourceContent } = payload;
    try {
      await Promise.all([
        playlistDb.savePlaylistItems(playlist.id, playlist.items),
        playlistDb.savePlaylistSourceContent(playlist.id, sourceContent),
      ]);
    } catch {
      setImportError("Failed to persist playlist data locally. Please check browser storage permissions.");
      return;
    }
    const next = [playlist, ...state.playlists];
    setPlaylists(next);
    setActivePlaylistId(playlist.id);
    setImportOpen(false);
  };

  const deletePlaylist = (playlistId: string) => {
    void playlistDb.deletePlaylistItems(playlistId);
    void playlistDb.deletePlaylistSourceContent(playlistId);
    const next = state.playlists.filter((playlist) => playlist.id !== playlistId);
    setPlaylists(next);
    if (state.activePlaylistId === playlistId) setActivePlaylistId(next[0]?.id ?? null);
  };

  const renamePlaylist = (playlistId: string) => {
    const current = state.playlists.find((playlist) => playlist.id === playlistId);
    if (!current) return;
    const newName = window.prompt("Rename playlist", current.name)?.trim();
    if (!newName) return;
    setPlaylists(state.playlists.map((playlist) => (playlist.id === playlistId ? { ...playlist, name: newName } : playlist)));
  };

  const refreshPlaylist = async (playlistId: string) => {
    const playlist = state.playlists.find((value) => value.id === playlistId);
    if (!playlist || playlist.source.type !== "url") return;
    try {
      const response = await fetch(playlist.source.value);
      if (!response.ok) throw new Error(`Failed to refresh (${response.status})`);
      const text = await response.text();
      const parsed = text.length > 1_000_000 ? await parseM3uChunked(playlist.id, text) : parseM3u(playlist.id, text);
      await Promise.all([
        playlistDb.savePlaylistItems(playlist.id, parsed.items),
        playlistDb.savePlaylistSourceContent(playlist.id, text),
      ]);
      setPlaylists(
        state.playlists.map((entry) =>
          entry.id === playlist.id
            ? { ...entry, items: parsed.items, itemCount: parsed.items.length, importErrors: parsed.errors, lastUpdatedAt: now() }
            : entry,
        ),
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Playlist refresh failed.");
    }
  };

  const onPlayerProgress = (positionSec: number, durationSec: number) => {
    if (!playerState.currentItem) return;
    const id = playerState.currentItem.id;
    const lastSaved = lastProgressRef.current[id] ?? 0;
    if (Math.abs(positionSec - lastSaved) < 5 && positionSec < durationSec - 1) return;
    lastProgressRef.current[id] = positionSec;
    updateProgress(playerState.currentItem.playlistId, id, positionSec, durationSec);
  };

  const onPlayerEnded = () => {
    const current = playerState.currentItem;
    if (!current) return;
    onPlayerProgress(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (current.section === "series") {
      const nextEpisode = getNextEpisode(groupedSeries, current.id);
      if (nextEpisode) {
        handlePlay(nextEpisode);
      }
    }
  };

  const exportData = async () => {
    const playlistsWithItems = await Promise.all(
      state.playlists.map(async (playlist) => {
        if (playlist.items.length > 0) return playlist;
        try {
          const items = await playlistDb.loadPlaylistItems(playlist.id);
          return { ...playlist, items, itemCount: items.length || playlist.itemCount };
        } catch {
          return playlist;
        }
      }),
    );
    const blob = new Blob([JSON.stringify({ ...state, playlists: playlistsWithItems }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "iptv-player-data.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
      await Promise.all(
        playlists.map(async (playlist: SavedPlaylist) => {
          const items = Array.isArray(playlist.items) ? playlist.items : [];
          await playlistDb.savePlaylistItems(playlist.id, items);
        }),
      );
      storage.save({
        ...parsed,
        playlists: playlists.map((playlist: SavedPlaylist) => ({
          ...playlist,
          itemCount: playlist.itemCount ?? playlist.items?.length ?? 0,
          items: [],
        })),
      });
      setState(storage.load());
      window.alert("App data imported.");
    } catch {
      window.alert("Invalid backup file.");
    }
  };

  const currentResume = playerState.currentItem ? getResumePosition(playerState.currentItem.id) : 0;

  const currentItemPlaylist = useMemo(
    () => state.playlists.find((p) => p.id === playerState.currentItem?.playlistId) ?? null,
    [state.playlists, playerState.currentItem?.playlistId],
  );

  const episodePageUrl = useMemo(() => {
    if (!playerState.currentItem || !currentItemPlaylist) return null;
    return buildEpisodeUrl(currentItemPlaylist.name, getShareId(playerState.currentItem));
  }, [playerState.currentItem, currentItemPlaylist]);

  const renderSection = () => {
    if (!activePlaylist && !["settings", "favorites", "recents", "continue"].includes(state.section)) {
      return (
        <EmptyState
          title="No playlist selected"
          description="Add a playlist by URL, raw text, or file import to browse and play IPTV content."
          action={
            <button className="btn btn-primary" onClick={() => setImportOpen(true)} type="button">
              Import playlist
            </button>
          }
        />
      );
    }
    switch (state.section) {
      case "live":
        return (
          <ChannelList
            channels={filteredItems}
            activeItemId={playerState.currentItem?.id}
            favoriteSet={favoriteSet}
            onPlay={handlePlay}
            onToggleFavorite={handleToggleFavorite}
          />
        );
      case "movies":
        return (
          <ContentGrid
            items={filteredItems}
            activeItemId={playerState.currentItem?.id}
            favoriteSet={favoriteSet}
            onPlay={handlePlay}
            onToggleFavorite={handleToggleFavorite}
          />
        );
      case "series":
        return (
          <SeriesBrowser
            series={seriesForView}
            activeEpisodeId={playerState.currentItem?.id}
            selectedSeriesId={selectedSeriesId}
            progressByItemId={progressByItemId}
            onSelectSeries={setSelectedSeriesId}
            onPlayEpisode={handlePlay}
          />
        );
      case "catchup":
        return <CatchupBrowser items={filteredItems} onPlay={handlePlay} />;
      case "favorites":
        return (
          <FavoritesView
            items={filteredFavoritesItems}
            activeItemId={playerState.currentItem?.id}
            favoriteSet={favoriteSet}
            onPlay={handlePlay}
            onToggleFavorite={handleToggleFavorite}
          />
        );
      case "recents":
        return (
          <RecentView
            items={filteredRecentsItems}
            favoriteSet={favoriteSet}
            activeItemId={playerState.currentItem?.id}
            onPlay={handlePlay}
            onToggleFavorite={handleToggleFavorite}
          />
        );
      case "continue":
        return (
          <ContinueWatchingView
            items={filteredContinueItems}
            progress={state.progress}
            onPlay={handlePlay}
            onRemove={(item) => removeContinueWatching(item.id)}
            onOpenSeries={openSeriesForEpisode}
          />
        );
      case "settings":
        return (
          <SettingsView
            settings={state.settings}
            onUpdate={setSettings}
            onClearFavorites={clearFavorites}
            onClearRecents={clearRecents}
            onClearContinue={clearContinueWatching}
            onRemoveAllPlaylists={() => {
              void Promise.all([playlistDb.clearPlaylistItems(), playlistDb.clearPlaylistSources()]);
              setPlaylists([]);
              setActivePlaylistId(null);
            }}
            onExport={exportData}
            onImport={importData}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen text-slate-100">
      <Header currentItem={playerState.currentItem} onOpenImport={() => setImportOpen(true)} onToggleSidebar={() => setMobileSidebarOpen(true)} />
      <div className="mx-auto flex w-full max-w-[1920px]">
        <Sidebar
          playlists={state.playlists}
          activePlaylistId={state.activePlaylistId}
          activeSection={state.section as PlaylistSection}
          collapsed={state.settings.sidebarCollapsed}
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onSelectPlaylist={setActivePlaylistId}
          onSelectSection={setSection}
        />
        <main className="min-h-[calc(100vh-4rem)] flex-1 px-4 py-6 lg:px-8">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-5">
              <VideoPlayer
                item={playerState.currentItem}
                autoplay={state.settings.autoplay && !visitRestorePause}
                volume={playerState.volume}
                muted={playerState.muted}
                volumePercentMode={state.settings.volumePercentMode}
                onVolume={handlePlayerVolume}
                onMuted={setMuted}
                onError={setError}
                onPlayingState={setPlaying}
                onProgress={onPlayerProgress}
                onEnded={onPlayerEnded}
                resumeFrom={currentResume}
              />
              {playerState.currentItem ? (
                <PlayerNavBar
                  currentTitle={playerState.currentItem.title}
                  nextEpisode={currentNextEpisode}
                  onPlayNext={() => currentNextEpisode && handlePlay(currentNextEpisode)}
                />
              ) : null}
              <div className="panel space-y-4 p-4 lg:p-5">
                <SectionTabs activeSection={state.section as PlaylistSection} onChange={setSection} />
                {state.section !== "settings" ? (
                  <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                    <SearchBar
                      value={filters.query}
                      resultCount={currentResultCount}
                      placeholder={
                        state.section === "live"
                          ? "Search channels..."
                          : state.section === "movies"
                            ? "Search movies..."
                            : state.section === "series"
                              ? "Search series and episodes..."
                              : state.section === "catchup"
                                ? "Search catch-up content..."
                                : state.section === "favorites"
                                  ? "Search favorites..."
                                  : state.section === "recents"
                                    ? "Search recently played..."
                                    : "Search continue watching..."
                      }
                      onChange={(query) => setFilters((prev) => ({ ...prev, query }))}
                    />
                    {["live", "movies", "series", "catchup"].includes(state.section) ? (
                      <FilterBar
                        groups={groups}
                        selectedGroup={filters.selectedGroup}
                        favoritesOnly={filters.favoritesOnly}
                        groupLabel={state.section === "live" ? "Category" : "Group"}
                        includeAllOption
                        allOptionLabel="Everything"
                        onGroupChange={(group) => setFilters((prev) => ({ ...prev, selectedGroup: group }))}
                        onToggleFavorites={() => setFilters((prev) => ({ ...prev, favoritesOnly: !prev.favoritesOnly }))}
                      />
                    ) : (
                      <div />
                    )}
                  </div>
                ) : null}
                {importError ? <ErrorState message={importError} onRetry={() => setImportError(null)} /> : null}
                {storageError ? <ErrorState message={storageError} /> : null}
                {deepLinkError ? (
                  <ErrorState
                    message={deepLinkError}
                    actionLabel="Go to home"
                    onRetry={() => {
                      setDeepLinkError(null);
                      navigate("/", { replace: true });
                    }}
                  />
                ) : null}
                {renderSection()}
              </div>
            </div>
            <div className="space-y-5">
              <PlaylistManager
                playlists={state.playlists}
                activePlaylistId={state.activePlaylistId}
                onSelect={setActivePlaylistId}
                onDelete={deletePlaylist}
                onRename={renamePlaylist}
                onRefresh={refreshPlaylist}
              />
              <DetailsPanel
                item={playerState.currentItem}
                resumeAt={currentResume}
                episodePageUrl={episodePageUrl}
                onGoToBrowse={goToBrowseFromDetails}
              />
            </div>
          </div>
        </main>
      </div>
      <PlaylistImportModal
        open={importOpen}
        loading={importing}
        error={importError}
        progress={importProgress}
        progressLabel={importProgressLabel}
        onClose={() => setImportOpen(false)}
        onSubmit={handleImport}
      />
      <InstallAppBanner />
    </div>
  );
};

export default App;
