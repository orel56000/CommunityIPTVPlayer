import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import type { AppSettings, UIFilters } from "./types/player";
import type {
  ContinueWatchingEntry,
  FavoriteEntry,
  PlaybackProgress,
  PlaylistItem,
  PlaylistSection,
  RecentEntry,
  SavedPlaylist,
} from "./types/models";
import { storage } from "./utils/storage";
import { getShareId } from "./utils/shareId";
import { buildEpisodeUrl, buildWatchPath, parseWatchPath, resolveWatchDeepLink } from "./utils/watchUrl";
import { buildSeriesFromCatalog, getGroups, getNextEpisode, groupSeries } from "./utils/grouping";
import { useActivePlaylist } from "./hooks/useActivePlaylist";
import { usePlaylistImport } from "./hooks/usePlaylistImport";
import { useFavorites } from "./hooks/useFavorites";
import { useRecents } from "./hooks/useRecents";
import { useContinueWatching } from "./hooks/useContinueWatching";
import { usePlaylistFilter } from "./hooks/usePlaylistFilter";
import { usePlayer } from "./hooks/usePlayer";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { useBackendConnection } from "./hooks/useBackendConnection";
import { Header } from "./components/layout/Header";
import { SearchOverlay, type SearchOpenFocus } from "./components/layout/SearchOverlay";
import { PlaylistImportModal } from "./components/playlist/PlaylistImportModal";
import { VideoPlayer } from "./components/player/VideoPlayer";
import { PlaylistManager } from "./components/playlist/PlaylistManager";
import { SettingsView } from "./components/views/SettingsView";
import { ErrorState } from "./components/shared/ErrorState";
import { InstallAppBanner } from "./components/shared/InstallAppBanner";
import { BackendConnectionModal } from "./components/shared/BackendConnectionModal";
import { DetailsPanel } from "./components/panels/DetailsPanel";
import { PlayerNavBar } from "./components/player/PlayerNavBar";
import { now } from "./utils/time";
import { playlistDb } from "./utils/indexedDb";
import { loadPlaylistSource } from "./utils/loadPlaylistSource";
import { loadXtreamSeriesEpisodes } from "./utils/xtream";
import { serializePlaylistItemsToM3u } from "./utils/exportM3u";
import { resolveRecentDisplayItem, resolveRecentItemId } from "./utils/recentItems";

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState<SearchOpenFocus | null>(null);
  const [filters, setFilters] = useState<UIFilters>(initialFilters);
  const debouncedQuery = useDebouncedValue(filters.query, 180);
  const [storageError, setStorageError] = useState<string | null>(null);
  const lastProgressRef = useRef<Record<string, number>>({});
  const syncedPlaylistIdsRef = useRef<Set<string>>(new Set());
  const restoredLastVisitRef = useRef(false);
  const appliedDeepLinkKey = useRef<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [loadingSeriesId, setLoadingSeriesId] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionPlaybackError, setConnectionPlaybackError] = useState<string | null>(null);
  const backendConnection = useBackendConnection();
  const canPlayVideos = backendConnection.connected;
  const shouldRenderAnalytics =
    typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname);

  const setPlaylists = useCallback((playlists: SavedPlaylist[]) => setState((prev) => ({ ...prev, playlists })), []);
  const setActivePlaylistId = useCallback(
    (activePlaylistId: string | null) => setState((prev) => ({ ...prev, activePlaylistId })),
    [],
  );
  const setFavorites = useCallback((favorites: FavoriteEntry[]) => setState((prev) => ({ ...prev, favorites })), []);
  const setRecents = useCallback((recents: RecentEntry[]) => setState((prev) => ({ ...prev, recents })), []);
  const setProgress = useCallback((progress: PlaybackProgress[]) => setState((prev) => ({ ...prev, progress })), []);
  const setContinueWatching = useCallback(
    (continueWatching: ContinueWatchingEntry[]) => setState((prev) => ({ ...prev, continueWatching })),
    [],
  );
  const setSettings = useCallback((settings: AppSettings) => setState((prev) => ({ ...prev, settings })), []);
  const setSection = useCallback((section: PlaylistSection) => setState((prev) => ({ ...prev, section })), []);
  const toggleRightPanel = useCallback(() => {
    setState((prev) => ({
      ...prev,
      settings: { ...prev.settings, rightPanelOpen: !prev.settings.rightPanelOpen },
    }));
  }, []);

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
            const parsed = await loadPlaylistSource(playlist.id, playlist.source, sourceContent ?? "");
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

  useEffect(() => {
    if (canPlayVideos) setConnectionPlaybackError(null);
  }, [canPlayVideos]);

  const activePlaylist = useActivePlaylist(state.playlists, state.activePlaylistId);
  const playlistItems = useMemo(() => activePlaylist?.items ?? [], [activePlaylist]);
  const groupedSeries = useMemo(() => groupSeries(playlistItems), [playlistItems]);
  const hasSeriesCatalog = useMemo(
    () => playlistItems.some((item) => item.section === "series" && item.kind === "series"),
    [playlistItems],
  );
  const buildSeriesViewForItems = useCallback(
    (items: PlaylistItem[]) =>
      items.some((item) => item.section === "series" && item.kind === "series")
        ? buildSeriesFromCatalog(items, items.filter((item) => item.section === "series" && item.kind === "series"))
        : groupSeries(items),
    [],
  );
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
  const { updateProgress, clearContinueWatching, getResumePosition } = useContinueWatching(
    state.continueWatching,
    setContinueWatching,
    state.progress,
    setProgress,
  );

  const progressByItemId = useMemo(() => {
    const map = new Map<string, PlaybackProgress>();
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
    if (location.pathname !== "/") {
      restoredLastVisitRef.current = true;
      return;
    }

    const watch = state.lastPlayedWatch;
    if (watch) {
      restoredLastVisitRef.current = true;
      navigate(buildWatchPath(watch.playlistName, watch.shareId), { replace: true });
      return;
    }

    if (!state.lastPlayedId) {
      restoredLastVisitRef.current = true;
      return;
    }

    const stillHydrating = state.playlists.some((p) => (p.itemCount ?? 0) > 0 && p.items.length === 0);
    const found = state.playlists.flatMap((p) => p.items).find((i) => i.id === state.lastPlayedId);

    if (found) {
      if (!canPlayVideos) return;
      restoredLastVisitRef.current = true;
      setCurrentItem(found);
      if (found.playlistId !== state.activePlaylistId) setActivePlaylistId(found.playlistId);
      setSection(found.section);
      return;
    }

    if (stillHydrating) return;
    restoredLastVisitRef.current = true;
  }, [
    deepLink,
    location.pathname,
    navigate,
    state.playlists,
    state.lastPlayedId,
    state.lastPlayedWatch,
    state.activePlaylistId,
    canPlayVideos,
    setCurrentItem,
    setSection,
    setActivePlaylistId,
  ]);

  useEffect(() => {
    const item = playerState.currentItem;
    if (!item) return;
    const pl = state.playlists.find((p) => p.id === item.playlistId);
    if (!pl) return;
    const shareId = getShareId(item);
    const target = buildWatchPath(pl.name, shareId);
    const watch = { playlistName: pl.name, shareId, itemId: item.id };

    setState((prev) => {
      if (
        prev.lastPlayedId === item.id &&
        prev.lastPlayedWatch?.playlistName === watch.playlistName &&
        prev.lastPlayedWatch?.shareId === watch.shareId &&
        prev.lastPlayedWatch?.itemId === watch.itemId
      ) {
        return prev;
      }
      return { ...prev, lastPlayedId: item.id, lastPlayedWatch: watch };
    });

    if (location.pathname !== target) navigate(target, { replace: true });
  }, [playerState.currentItem, state.playlists, location.pathname, navigate]);

  useEffect(() => {
    if (!deepLink) {
      appliedDeepLinkKey.current = null;
      setDeepLinkError(null);
    }
  }, [deepLink]);

  const handlePlayerVolume = useCallback(
    (next: number) => {
      const clamped = Math.min(2, Math.max(0, next));
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
        return playlistItems.filter((item) => item.section === "live" && (item.kind === "live" || item.kind === "unknown"));
      case "movies":
        return playlistItems.filter((item) => item.section === "movies" && item.kind === "movie");
      case "series":
        return hasSeriesCatalog
          ? playlistItems.filter((item) => item.section === "series" && item.kind === "series")
          : playlistItems.filter((item) => item.section === "series" && item.kind === "series_episode");
      case "catchup":
        return playlistItems.filter((item) => item.section === "catchup");
      default:
        return playlistItems;
    }
  }, [playlistItems, state.section, hasSeriesCatalog]);
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
  const allSeriesForPlaylist = useMemo(() => buildSeriesViewForItems(playlistItems), [buildSeriesViewForItems, playlistItems]);
  const seriesFavoriteItemById = useMemo(() => {
    const map = new Map<string, PlaylistItem>();
    for (const show of allSeriesForPlaylist) {
      const directItem = playlistItems.find((item) => item.id === show.id && item.section === "series");
      if (directItem) {
        map.set(show.id, directItem);
        continue;
      }
      const firstEpisode = show.episodes[0];
      if (firstEpisode) {
        const episodeItem = playlistItems.find((item) => item.id === firstEpisode.id);
        if (episodeItem) map.set(show.id, episodeItem);
      }
    }
    return map;
  }, [allSeriesForPlaylist, playlistItems]);
  const favoriteSeriesIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [seriesId, item] of seriesFavoriteItemById.entries()) {
      if (favoriteSet.has(item.id)) ids.add(seriesId);
    }
    return ids;
  }, [seriesFavoriteItemById, favoriteSet]);

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

  const recentsItems = useMemo(() => {
    const seen = new Set<string>();
    const items: PlaylistItem[] = [];
    for (const entry of state.recents) {
      const playlist = state.playlists.find((pl) => pl.id === entry.playlistId);
      if (!playlist) continue;
      const grouped = buildSeriesViewForItems(playlist.items);
      const item = resolveRecentDisplayItem(entry.itemId, entry.playlistId, playlist.items, grouped);
      if (!item) continue;
      const key = `${item.playlistId}::${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    return items;
  }, [buildSeriesViewForItems, state.recents, state.playlists]);

  const pushRecentForItem = useCallback(
    (item: PlaylistItem) => {
      const playlist = state.playlists.find((pl) => pl.id === item.playlistId);
      const items = playlist?.items ?? playlistItems;
      const grouped = playlist ? buildSeriesViewForItems(items) : allSeriesForPlaylist;
      pushRecent(item.playlistId, resolveRecentItemId(item, items, grouped));
    },
    [allSeriesForPlaylist, buildSeriesViewForItems, playlistItems, pushRecent, state.playlists],
  );

  const continueItems = useMemo(
    () =>
      state.continueWatching
        .map((entry) => state.playlists.flatMap((playlist) => playlist.items).find((item) => item.id === entry.itemId))
        .filter(Boolean) as PlaylistItem[],
    [state.continueWatching, state.playlists],
  );

  const openSearch = useCallback((focus?: SearchOpenFocus | null) => {
    setSearchFocus(focus ?? null);
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchFocus(null);
  }, []);

  const showBackendRequired = useCallback(() => {
    setConnectionPlaybackError(
      "You are not connected to a Community IPTV Player backend, so playback was not started.",
    );
    setConnectionOpen(true);
  }, []);

  useEffect(() => {
    if (!deepLink) return;
    const { playlistName, shareId } = deepLink;
    const key = `${playlistName}\0${shareId}`;

    const hints: { itemId?: string | null } = {};
    if (state.lastPlayedWatch?.playlistName === playlistName && state.lastPlayedWatch?.shareId === shareId) {
      hints.itemId = state.lastPlayedWatch.itemId ?? state.lastPlayedId;
    }

    const resolution = resolveWatchDeepLink(state.playlists, deepLink, hints);

    if (resolution.status === "pending") {
      setDeepLinkError(null);
      return;
    }

    if (resolution.status === "not_found") {
      if (!resolution.playlist && state.playlists.length > 0) {
        setDeepLinkError(
          `No playlist named “${playlistName}”. Links use the exact playlist name — rename or import a playlist to match.`,
        );
      } else if (resolution.playlist && resolution.playlist.items.length > 0) {
        setDeepLinkError(
          `That stream is not in playlist “${playlistName}”. Both people need the same stream URL in the M3U so the episode ID matches.`,
        );
      }
      return;
    }

    const { item, playlist } = resolution;

    if (playerState.currentItem?.id === item.id) {
      appliedDeepLinkKey.current = key;
      setDeepLinkError(null);
      return;
    }

    if (appliedDeepLinkKey.current === key) return;
    if (!canPlayVideos) {
      setDeepLinkError(null);
      showBackendRequired();
      return;
    }
    appliedDeepLinkKey.current = key;
    setDeepLinkError(null);

    setActivePlaylistId(playlist.id);
    setSection(item.section);
    setCurrentItem(item);
    pushRecentForItem(item);
  }, [
    deepLink,
    playerState.currentItem,
    pushRecentForItem,
    canPlayVideos,
    showBackendRequired,
    setActivePlaylistId,
    setCurrentItem,
    setSection,
    state.lastPlayedId,
    state.lastPlayedWatch,
    state.playlists,
  ]);

  const handleToggleFavorite = (item: PlaylistItem) => toggleFavorite(item.playlistId, item.id);
  const handleToggleFavoriteSeries = useCallback(
    (seriesId: string) => {
      const item = seriesFavoriteItemById.get(seriesId);
      if (!item) return;
      toggleFavorite(item.playlistId, item.id);
    },
    [seriesFavoriteItemById, toggleFavorite],
  );

  const ensureSeriesLoaded = useCallback(
    async (seriesViewId: string) => {
      if (!activePlaylist || activePlaylist.source.type !== "xtream" || !activePlaylist.source.xtream) return;
      const seriesItem = activePlaylist.items.find((item) => item.id === seriesViewId && item.kind === "series");
      if (!seriesItem) return;
      const seriesId = seriesItem.xuiId ?? seriesItem.sourceId;
      const hasEpisodes = activePlaylist.items.some(
        (item) => item.kind === "series_episode" && item.parentSeriesId === seriesId,
      );
      if (hasEpisodes) return;

      setLoadingSeriesId(seriesViewId);
      try {
        const episodes = await loadXtreamSeriesEpisodes(activePlaylist.id, activePlaylist.source.xtream, seriesItem);
        setState((prev) => ({
          ...prev,
          playlists: prev.playlists.map((playlist) => {
            if (playlist.id !== activePlaylist.id) return playlist;
            const withoutPrevious = playlist.items.filter(
              (item) => !(item.kind === "series_episode" && item.parentSeriesId === seriesId),
            );
            const nextItems = [...withoutPrevious, ...episodes];
            return { ...playlist, items: nextItems, itemCount: nextItems.length, lastUpdatedAt: now() };
          }),
        }));
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Failed to load series details.");
      } finally {
        setLoadingSeriesId((current) => (current === seriesViewId ? null : current));
      }
    },
    [activePlaylist, setImportError],
  );

  const handlePlay = useCallback((item: PlaylistItem) => {
    if (item.kind === "series") {
      if (item.playlistId !== state.activePlaylistId) setActivePlaylistId(item.playlistId);
      void ensureSeriesLoaded(item.id);
      openSearch({ category: "series", seriesId: item.id });
      return;
    }
    if (!canPlayVideos) {
      showBackendRequired();
      return;
    }
    setCurrentItem(item);
    pushRecentForItem(item);
  }, [
    canPlayVideos,
    ensureSeriesLoaded,
    openSearch,
    pushRecentForItem,
    setActivePlaylistId,
    setCurrentItem,
    showBackendRequired,
    state.activePlaylistId,
  ]);

  const openSearchForNowPlaying = useCallback(() => {
    const item = playerState.currentItem;
    if (!item) {
      openSearch();
      return;
    }

    if (item.kind === "series") {
      void ensureSeriesLoaded(item.id);
      openSearch({ category: "series", seriesId: item.id });
      return;
    }

    if (item.kind === "series_episode" || item.section === "series") {
      const show = allSeriesForPlaylist.find((series) => series.episodes.some((ep) => ep.id === item.id));
      if (show) {
        void ensureSeriesLoaded(show.id);
        openSearch({ category: "series", seriesId: show.id });
        return;
      }

      const catalog = playlistItems.find(
        (entry) =>
          entry.kind === "series" &&
          (entry.id === item.parentSeriesId ||
            entry.xuiId === item.parentSeriesId ||
            entry.sourceId === item.parentSeriesId),
      );
      if (catalog) {
        void ensureSeriesLoaded(catalog.id);
        openSearch({ category: "series", seriesId: catalog.id });
        return;
      }
    }

    const categoryBySection: Partial<Record<PlaylistSection, SearchOpenFocus["category"]>> = {
      live: "live",
      movies: "movies",
      catchup: "catchup",
      series: "series",
      favorites: "favorites",
      recents: "recents",
      continue: "continue",
    };
    openSearch({ category: categoryBySection[item.section] ?? "all" });
  }, [allSeriesForPlaylist, ensureSeriesLoaded, openSearch, playerState.currentItem, playlistItems]);

  const handleSearchPlay = useCallback(
    (item: PlaylistItem) => {
      setSearchOpen(false);
      setSearchFocus(null);
      setSection(item.section);
      setActivePlaylistId(item.playlistId);
      handlePlay(item);
    },
    [handlePlay, setActivePlaylistId, setSection],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Slash" || searchOpen) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch, searchOpen]);

  const goToBrowseFromDetails = useCallback(
    (item: PlaylistItem) => {
      if (item.playlistId !== state.activePlaylistId) setActivePlaylistId(item.playlistId);
      if (item.kind === "series_episode") {
        const pl = state.playlists.find((p) => p.id === item.playlistId);
        if (!pl) return;
        const grouped = buildSeriesViewForItems(pl.items);
        const show = grouped.find((s) => s.episodes.some((ep) => ep.id === item.id));
        if (show) {
          void ensureSeriesLoaded(show.id);
          openSearch({ category: "series", seriesId: show.id });
        }
        return;
      }
      if (item.kind === "series") {
        void ensureSeriesLoaded(item.id);
        openSearch({ category: "series", seriesId: item.id });
        return;
      }
      const categoryBySection: Partial<Record<PlaylistSection, SearchOpenFocus["category"]>> = {
        live: "live",
        movies: "movies",
        catchup: "catchup",
        favorites: "favorites",
        recents: "recents",
        continue: "continue",
      };
      openSearch({ category: categoryBySection[item.section] ?? "all" });
    },
    [buildSeriesViewForItems, ensureSeriesLoaded, openSearch, state.activePlaylistId, state.playlists, setActivePlaylistId],
  );

  const currentNextEpisode = useMemo(() => {
    const current = playerState.currentItem;
    if (!current || current.kind !== "series_episode") return null;
    return getNextEpisode(groupedSeries, current.id);
  }, [groupedSeries, playerState.currentItem]);

  const handleImport = async (
    name: string,
    source: SavedPlaylist["source"],
    text?: string,
  ) => {
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

  const downloadPlaylist = async (playlistId: string) => {
    const playlist = state.playlists.find((value) => value.id === playlistId);
    if (!playlist) return;

    let sourceContent: string | null = null;
    try {
      sourceContent = await playlistDb.loadPlaylistSourceContent(playlist.id);
    } catch {
      sourceContent = null;
    }

    let text = sourceContent && sourceContent.includes("#EXTM3U") ? sourceContent : null;
    if (!text) {
      const items = playlist.items.length > 0 ? playlist.items : await playlistDb.loadPlaylistItems(playlist.id);
      text = serializePlaylistItemsToM3u(items);
    }

    const blob = new Blob([text], { type: "application/x-mpegURL;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeBaseName =
      playlist.name
        .replace(/[<>:"/\\|?*]+/g, "_")
        .split("")
        .filter((char) => char.charCodeAt(0) >= 32)
        .join("")
        .trim() || "playlist";
    a.download = `${safeBaseName}.m3u`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const refreshPlaylist = async (playlistId: string) => {
    const playlist = state.playlists.find((value) => value.id === playlistId);
    if (!playlist || !["url", "xtream"].includes(playlist.source.type)) return;
    try {
      const parsed = await loadPlaylistSource(playlist.id, playlist.source);
      await Promise.all([
        playlistDb.savePlaylistItems(playlist.id, parsed.items),
        playlistDb.savePlaylistSourceContent(playlist.id, parsed.sourceContent),
      ]);
      setPlaylists(
        state.playlists.map((entry) =>
          entry.id === playlist.id
            ? {
                ...entry,
                source: parsed.normalizedSource ?? entry.source,
                items: parsed.items,
                itemCount: parsed.items.length,
                importErrors: parsed.errors,
                lastUpdatedAt: now(),
              }
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

  const settingsPanel = (
    <SettingsView
      embedded
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

  return (
    <div className="flex h-full flex-col overflow-hidden text-slate-100">
      <Header
        currentItem={playerState.currentItem}
        rightPanelOpen={state.settings.rightPanelOpen}
        backendStatus={backendConnection.status}
        onOpenSearch={() => openSearch()}
        onOpenNowPlaying={openSearchForNowPlaying}
        onOpenBackendConnection={() => setConnectionOpen(true)}
        onToggleRightPanel={toggleRightPanel}
      />
      <main className="mx-auto flex min-h-0 w-full max-w-[1920px] flex-1 flex-col overflow-hidden px-4 py-3 lg:px-8">
        <div
          className={
            state.settings.rightPanelOpen
              ? "grid h-full min-h-0 gap-4 overflow-hidden xl:grid-cols-[minmax(0,1fr)_380px]"
              : "grid h-full min-h-0 gap-4 overflow-hidden"
          }
        >
          <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
            <VideoPlayer
              className="min-h-0 flex-1"
              item={playerState.currentItem}
              autoplay={state.settings.autoplay}
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
              playbackBlocked={!canPlayVideos}
              onPlaybackBlockedAction={showBackendRequired}
            />
            {currentNextEpisode ? (
              <PlayerNavBar
                nextEpisode={currentNextEpisode}
                onPlayNext={() => currentNextEpisode && handlePlay(currentNextEpisode)}
              />
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
            {connectionPlaybackError ? (
              <ErrorState
                message={connectionPlaybackError}
                actionLabel="Open connection"
                onRetry={() => setConnectionOpen(true)}
              />
            ) : null}
          </div>
          {state.settings.rightPanelOpen ? (
            <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
              <PlaylistManager
                playlists={state.playlists}
                activePlaylistId={state.activePlaylistId}
                onSelect={setActivePlaylistId}
                onDelete={deletePlaylist}
                onDownload={(playlistId) => {
                  void downloadPlaylist(playlistId);
                }}
                onRename={renamePlaylist}
                onRefresh={refreshPlaylist}
                onAddPlaylist={() => setImportOpen(true)}
              />
              <DetailsPanel
                item={playerState.currentItem}
                resumeAt={currentResume}
                episodePageUrl={episodePageUrl}
                onGoToBrowse={goToBrowseFromDetails}
              />
            </div>
          ) : null}
        </div>
      </main>
      <SearchOverlay
        open={searchOpen}
        onClose={closeSearch}
        initialFocus={searchFocus}
        settingsPanel={settingsPanel}
        playlistItems={playlistItems}
        groupedSeries={allSeriesForPlaylist}
        favoritesItems={favoritesItems}
        recentsItems={recentsItems}
        continueItems={continueItems}
        favoriteSet={favoriteSet}
        favoriteSeriesIds={favoriteSeriesIds}
        progressByItemId={progressByItemId}
        loadingSeriesId={loadingSeriesId}
        activeItemId={playerState.currentItem?.id}
        onPlay={handleSearchPlay}
        onToggleFavorite={handleToggleFavorite}
        onToggleFavoriteSeries={handleToggleFavoriteSeries}
        onEnsureSeriesLoaded={(seriesId) => {
          void ensureSeriesLoaded(seriesId);
        }}
      />
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
      <BackendConnectionModal
        open={connectionOpen}
        connection={backendConnection}
        onClose={() => setConnectionOpen(false)}
      />
      {shouldRenderAnalytics ? <Analytics /> : null}
    </div>
  );
};

export default App;
