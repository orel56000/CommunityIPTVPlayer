import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { CheckCircle2, ChevronRight, Search, Star, X } from "lucide-react";
import type { EpisodeItem, PlaybackProgress, PlaylistItem, SeriesItem } from "../../types/models";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useInfiniteList } from "../../hooks/useInfiniteList";
import { filterByQuery } from "../../utils/search";
import { getGroups } from "../../utils/grouping";
import { watchedStateFor, type WatchedState } from "../../utils/watchedState";
import { SeriesDetailView } from "../browse/SeriesBrowser";

type SearchCategory =
  | "all"
  | "live"
  | "movies"
  | "catchup"
  | "series"
  | "favorites"
  | "recents"
  | "continue"
  | "settings";

export type { SearchCategory };

export interface SearchOpenFocus {
  category?: SearchCategory;
  seriesId?: string;
}

const categories: Array<{ id: SearchCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "live", label: "Live TV" },
  { id: "movies", label: "Movies" },
  { id: "catchup", label: "Catch-up" },
  { id: "series", label: "Series" },
  { id: "favorites", label: "Favorites" },
  { id: "recents", label: "Recently Played" },
  { id: "continue", label: "Continue Watching" },
  { id: "settings", label: "Settings" },
];

const sectionLabel = (section: PlaylistItem["section"]): string => {
  switch (section) {
    case "live":
      return "Live";
    case "movies":
      return "Movie";
    case "catchup":
      return "Catch-up";
    case "series":
      return "Series";
    default:
      return section;
  }
};

const isSeriesCatalogItem = (item: PlaylistItem): boolean =>
  item.section === "series" && item.kind === "series";

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  playlistItems: PlaylistItem[];
  groupedSeries: SeriesItem[];
  favoritesItems: PlaylistItem[];
  recentsItems: PlaylistItem[];
  continueItems: PlaylistItem[];
  favoriteSet: Set<string>;
  favoriteSeriesIds: Set<string>;
  progressByItemId: Map<string, PlaybackProgress>;
  loadingSeriesId: string | null;
  activeItemId?: string;
  settingsPanel?: ReactNode;
  onPlay: (item: PlaylistItem) => void;
  onToggleFavorite: (item: PlaylistItem) => void;
  onToggleFavoriteSeries: (seriesId: string) => void;
  onEnsureSeriesLoaded: (seriesId: string) => void;
  onSetWatched?: (episodes: EpisodeItem[], watched: boolean) => void;
  /** Mark/unmark a whole series from a list row (loads its episodes first). */
  onSetSeriesWatched?: (seriesId: string, watched: boolean) => void;
  initialFocus?: SearchOpenFocus | null;
}

export const SearchOverlay = ({
  open,
  onClose,
  playlistItems,
  groupedSeries,
  favoritesItems,
  recentsItems,
  continueItems,
  favoriteSet,
  favoriteSeriesIds,
  progressByItemId,
  loadingSeriesId,
  activeItemId,
  settingsPanel,
  onPlay,
  onToggleFavorite,
  onToggleFavoriteSeries,
  onEnsureSeriesLoaded,
  onSetWatched,
  onSetSeriesWatched,
  initialFocus = null,
}: SearchOverlayProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SearchCategory>("all");
  const [selectedGroup, setSelectedGroup] = useState("all");
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(query, 160);

  const selectedSeries = useMemo(
    () => (selectedSeriesId ? groupedSeries.find((show) => show.id === selectedSeriesId) ?? null : null),
    [groupedSeries, selectedSeriesId],
  );

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setQuery("");
      setSelectedGroup("all");
      const nextCategory = initialFocus?.category ?? "all";
      setCategory(nextCategory);
      if (initialFocus?.seriesId) {
        setSelectedSeriesId(initialFocus.seriesId);
        onEnsureSeriesLoaded(initialFocus.seriesId);
      } else {
        setSelectedSeriesId(null);
      }
      window.setTimeout(() => inputRef.current?.focus(), 80);
    }
    prevOpenRef.current = open;
  }, [open, initialFocus, onEnsureSeriesLoaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedSeriesId) {
        setSelectedSeriesId(null);
        return;
      }
      onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, selectedSeriesId]);

  useEffect(() => {
    setSelectedGroup("all");
  }, [category]);

  const baseItems = useMemo(() => {
    switch (category) {
      case "live":
        return playlistItems.filter((item) => item.section === "live");
      case "movies":
        return playlistItems.filter((item) => item.section === "movies" && item.kind === "movie");
      case "catchup":
        return playlistItems.filter((item) => item.section === "catchup");
      case "series":
        return playlistItems.filter((item) => isSeriesCatalogItem(item));
      case "favorites":
        return favoritesItems;
      case "recents":
        return recentsItems;
      case "continue":
        return continueItems;
      case "settings":
        return [];
      case "all":
      default:
        if (debouncedQuery.trim()) {
          return playlistItems.filter((item) => {
            if (item.section === "live") {
              return item.kind === "live" || item.kind === "unknown";
            }
            if (item.section === "movies") {
              return item.kind === "movie";
            }
            if (item.section === "series") {
              return item.kind === "series" || item.kind === "series_episode";
            }
            return item.section === "catchup";
          });
        }
        return [];
    }
  }, [category, playlistItems, favoritesItems, recentsItems, continueItems, debouncedQuery]);

  const groups = useMemo(() => {
    if (!["live", "movies", "catchup", "series"].includes(category)) return [];
    return getGroups(baseItems);
  }, [baseItems, category]);

  const filteredItems = useMemo(() => {
    let items = filterByQuery(baseItems, debouncedQuery);
    if (selectedGroup !== "all" && groups.length > 0) {
      items = items.filter((item) => (item.groupTitle ?? "Ungrouped") === selectedGroup);
    }
    return items;
  }, [baseItems, debouncedQuery, selectedGroup, groups.length]);

  const { visibleCount, hasMore, sentinelRef } = useInfiniteList(filteredItems.length, {
    initialCount: 80,
    step: 80,
  });
  const visibleItems = useMemo(() => filteredItems.slice(0, visibleCount), [filteredItems, visibleCount]);

  /**
   * Watched state per series catalog row, for the visible rows only.
   *
   * A series counts as watched ONLY when every one of its episodes is — and
   * that can only be proven once the episodes are actually loaded. They are
   * fetched lazily and never persisted, so a series whose episodes this session
   * has not loaded stays unmarked rather than guessing. Clicking the control
   * loads them first (see handleSetSeriesWatched in App.tsx), so acting on it
   * is always correct even when the badge cannot know yet.
   */
  const seriesWatchedById = useMemo(() => {
    const byId = new Map<string, WatchedState>();
    if (!onSetSeriesWatched) return byId;
    const episodesById = new Map(groupedSeries.map((show) => [show.id, show.episodes]));
    for (const item of visibleItems) {
      if (!isSeriesCatalogItem(item)) continue;
      byId.set(item.id, watchedStateFor(episodesById.get(item.id) ?? [], progressByItemId));
    }
    return byId;
  }, [visibleItems, groupedSeries, progressByItemId, onSetSeriesWatched]);

  const handlePick = (item: PlaylistItem) => {
    if (isSeriesCatalogItem(item)) {
      setSelectedSeriesId(item.id);
      onEnsureSeriesLoaded(item.id);
      return;
    }
    onPlay(item);
    onClose();
  };

  const handlePlayEpisode = (episode: PlaylistItem) => {
    onPlay(episode);
    onClose();
  };

  const handleCategoryPick = (next: SearchCategory) => {
    setCategory(next);
    setSelectedGroup("all");
    setSelectedSeriesId(null);
  };

  if (!open) return null;

  return (
    <div className="search-overlay-root" role="dialog" aria-modal="true" aria-label="Search content">
      <button type="button" className="search-overlay-backdrop" onClick={onClose} aria-label="Close search" />
      <div className="search-overlay-panel">
        <div className="search-overlay-header">
          <div className="relative flex-1">
            <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-cyan-400/80" />
            <input
              ref={inputRef}
              className="search-overlay-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search live TV, movies, series, catch-up, and more…"
            />
            {query ? (
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X size={16} />
              </button>
            ) : null}
          </div>
          <button type="button" className="btn border-white/10 bg-white/5 px-3 py-2.5" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!selectedSeries ? (
          <>
            <div className="search-overlay-categories">
              {categories.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={clsx("search-overlay-category", category === entry.id && "search-overlay-category-active")}
                  onClick={() => handleCategoryPick(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            {groups.length > 0 ? (
              <div className="search-overlay-groups">
                <button
                  type="button"
                  className={clsx("search-overlay-group", selectedGroup === "all" && "search-overlay-group-active")}
                  onClick={() => setSelectedGroup("all")}
                >
                  All groups
                </button>
                {groups.map((group) => (
                  <button
                    key={group}
                    type="button"
                    className={clsx("search-overlay-group", selectedGroup === group && "search-overlay-group-active")}
                    onClick={() => setSelectedGroup(group)}
                  >
                    {group}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="search-overlay-meta">
              <span className="text-xs text-slate-500">
                {category === "settings"
                  ? "App preferences & data"
                  : category === "all" && !debouncedQuery.trim()
                    ? "Type to search across Live TV, Movies, Series, and Catch-up"
                    : `${filteredItems.length.toLocaleString()} result${filteredItems.length === 1 ? "" : "s"}`}
              </span>
            </div>
          </>
        ) : null}

        <div className="search-overlay-results">
          {selectedSeries ? (
            <SeriesDetailView
              show={selectedSeries}
              activeEpisodeId={activeItemId}
              loading={loadingSeriesId === selectedSeries.id}
              isFavorite={favoriteSeriesIds.has(selectedSeries.id)}
              progressByItemId={progressByItemId}
              onPlay={handlePlayEpisode}
              onBack={() => setSelectedSeriesId(null)}
              onToggleFavorite={() => onToggleFavoriteSeries(selectedSeries.id)}
              onSetWatched={onSetWatched}
            />
          ) : category === "settings" && settingsPanel ? (
            <div className="min-w-0 max-w-full">{settingsPanel}</div>
          ) : category === "all" && !debouncedQuery.trim() ? (
            <div className="search-overlay-empty">
              <p className="text-sm font-medium text-slate-300">Global search</p>
              <p className="mt-1 max-w-md text-sm text-slate-500">
                Start typing to find channels, movies, series, and catch-up in one place. Pick a category above to
                browse a specific library.
              </p>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="search-overlay-empty">
              <p className="text-sm text-slate-400">No matches for “{debouncedQuery}”</p>
            </div>
          ) : (
            // Key the list by query+filters so a new query REPLACES the list
            // wholesale. Without this, WKWebView occasionally kept painting rows
            // from the previous keystroke's query (stale frame) while the count
            // updated — the "wrong #1 result" bug.
            <ul key={`${category}::${selectedGroup}::${debouncedQuery}`} className="divide-y divide-white/[0.06]">
              {visibleItems.map((item) => (
                <li
                  key={item.id}
                  className={clsx(
                    "flex items-center gap-3 px-2 py-2.5 transition duration-150 sm:px-3",
                    item.id === activeItemId ? "bg-cyan-500/10" : "hover:bg-white/[0.04]",
                  )}
                >
                  {item.logo ? (
                    <img
                      src={item.logo}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-xl bg-slate-950 object-cover ring-1 ring-white/10"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-sm font-semibold text-slate-300 ring-1 ring-white/10">
                      {item.title.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => handlePick(item)}>
                    <p className="line-clamp-1 text-sm font-medium text-slate-100">{item.title}</p>
                    <p className="line-clamp-1 text-xs text-slate-500">
                      <span className="text-cyan-500/80">{sectionLabel(item.section)}</span>
                      {isSeriesCatalogItem(item) ? (
                        <>
                          <span className="mx-1.5 text-slate-700">·</span>
                          <span className="text-slate-500">Browse episodes</span>
                        </>
                      ) : null}
                      {item.groupTitle ? (
                        <>
                          <span className="mx-1.5 text-slate-700">·</span>
                          {item.groupTitle}
                        </>
                      ) : null}
                    </p>
                  </button>
                  {isSeriesCatalogItem(item) ? (
                    <>
                      {onSetSeriesWatched ? (
                        <button
                          type="button"
                          className="flex shrink-0 items-center rounded p-1.5 transition hover:bg-white/10"
                          aria-pressed={seriesWatchedById.get(item.id) === "all"}
                          aria-label={
                            seriesWatchedById.get(item.id) === "all"
                              ? `Mark all of ${item.title} as unwatched`
                              : `Mark all of ${item.title} as watched`
                          }
                          title={
                            seriesWatchedById.get(item.id) === "all"
                              ? "Whole series watched — click to unmark"
                              : "Mark every episode in this series as watched"
                          }
                          onClick={() => onSetSeriesWatched(item.id, seriesWatchedById.get(item.id) !== "all")}
                        >
                          <CheckCircle2
                            size={16}
                            className={clsx(
                              "transition",
                              seriesWatchedById.get(item.id) === "all"
                                ? "fill-emerald-400/20 text-emerald-400"
                                : seriesWatchedById.get(item.id) === "partial"
                                  ? "text-emerald-400/50"
                                  : "text-slate-500 opacity-40 hover:opacity-100",
                            )}
                          />
                        </button>
                      ) : null}
                      <ChevronRight size={16} className="shrink-0 text-slate-500" aria-hidden />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn shrink-0 border-white/10 px-2.5 py-2"
                      onClick={() => onToggleFavorite(item)}
                      aria-label={favoriteSet.has(item.id) ? "Remove favorite" : "Add favorite"}
                    >
                      <Star size={14} className={favoriteSet.has(item.id) ? "fill-amber-300 text-amber-300" : ""} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!selectedSeries && category !== "settings" && hasMore ? (
            <div ref={sentinelRef} className="py-4 text-center text-xs text-slate-500">
              Loading more…
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
