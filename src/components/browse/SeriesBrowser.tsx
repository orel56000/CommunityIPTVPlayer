import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronRight, Play, Star } from "lucide-react";
import clsx from "clsx";
import type { EpisodeItem, PlaybackProgress, SeriesItem } from "../../types/models";
import { useInfiniteList } from "../../hooks/useInfiniteList";
import { formatShortDate } from "../../utils/time";

interface SeriesBrowserProps {
  series: SeriesItem[];
  activeEpisodeId?: string;
  selectedSeriesId: string | null;
  loadingSeriesId?: string | null;
  favoriteSeriesIds: Set<string>;
  progressByItemId: Map<string, PlaybackProgress>;
  onSelectSeries: (seriesId: string | null) => void;
  onToggleFavoriteSeries: (seriesId: string) => void;
  onPlayEpisode: (episode: EpisodeItem) => void;
}

const seasonKey = (episode: EpisodeItem): number => episode.season ?? 0;

export const SeriesBrowser = ({
  series,
  activeEpisodeId,
  selectedSeriesId,
  loadingSeriesId,
  favoriteSeriesIds,
  progressByItemId,
  onSelectSeries,
  onToggleFavoriteSeries,
  onPlayEpisode,
}: SeriesBrowserProps) => {
  const selectedSeries = useMemo(
    () => (selectedSeriesId ? series.find((show) => show.id === selectedSeriesId) ?? null : null),
    [series, selectedSeriesId],
  );

  if (selectedSeries) {
    return (
      <SeriesDetailView
        show={selectedSeries}
        activeEpisodeId={activeEpisodeId}
        loading={loadingSeriesId === selectedSeries.id}
        isFavorite={favoriteSeriesIds.has(selectedSeries.id)}
        progressByItemId={progressByItemId}
        onPlay={onPlayEpisode}
        onBack={() => onSelectSeries(null)}
        onToggleFavorite={() => onToggleFavoriteSeries(selectedSeries.id)}
      />
    );
  }

  return (
    <SeriesGridView
      series={series}
      loadingSeriesId={loadingSeriesId}
      favoriteSeriesIds={favoriteSeriesIds}
      onOpen={(id) => onSelectSeries(id)}
      onToggleFavorite={onToggleFavoriteSeries}
    />
  );
};

interface SeriesGridViewProps {
  series: SeriesItem[];
  loadingSeriesId?: string | null;
  favoriteSeriesIds: Set<string>;
  onOpen: (seriesId: string) => void;
  onToggleFavorite: (seriesId: string) => void;
}

const SeriesGridView = ({ series, loadingSeriesId, favoriteSeriesIds, onOpen, onToggleFavorite }: SeriesGridViewProps) => {
  const { visibleCount, hasMore, sentinelRef } = useInfiniteList(series.length, { initialCount: 40, step: 40 });
  const visible = useMemo(() => series.slice(0, visibleCount), [series, visibleCount]);

  if (!series.length) {
    return <p className="text-sm text-slate-400">No series in this playlist yet.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
        {visible.map((show) => (
          <article
            key={show.id}
            className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900 transition hover:border-slate-600"
          >
            <button
              type="button"
              onClick={() => onOpen(show.id)}
              className="flex w-full flex-col text-left focus:outline-none focus:ring-2 focus:ring-cyan-500/60"
            >
              {show.logo ? (
                <img
                  src={show.logo}
                  alt={show.title}
                  loading="lazy"
                  className="aspect-[2/3] w-full bg-slate-950 object-cover"
                />
              ) : (
                <div className="flex aspect-[2/3] w-full items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950 text-slate-400">
                  <span className="line-clamp-3 px-3 text-center text-sm">{show.title}</span>
                </div>
              )}
              <div className="space-y-1 p-3">
                <h4 className="line-clamp-1 text-sm font-semibold text-slate-100">{show.title}</h4>
                <p className="line-clamp-1 text-xs text-slate-400">
                  {show.episodes.length > 0
                    ? `${show.episodes.length} episode${show.episodes.length === 1 ? "" : "s"}`
                    : loadingSeriesId === show.id
                      ? "Loading episodes..."
                      : "Open to load episodes"}
                  {show.groupTitle ? ` - ${show.groupTitle}` : ""}
                </p>
              </div>
            </button>
            <div className="px-3 pb-3">
              <button
                type="button"
                className="btn w-full justify-center border-white/[0.06] py-2 text-xs"
                onClick={() => onToggleFavorite(show.id)}
              >
                <Star size={14} className={favoriteSeriesIds.has(show.id) ? "fill-amber-300 text-amber-300" : ""} />
                {favoriteSeriesIds.has(show.id) ? "Unfavorite" : "Favorite"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {hasMore ? (
        <div
          ref={sentinelRef}
          className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-center text-xs text-slate-400"
        >
          Loading more series...
        </div>
      ) : null}
    </div>
  );
};

interface SeriesDetailViewProps {
  show: SeriesItem;
  activeEpisodeId?: string;
  loading?: boolean;
  isFavorite: boolean;
  progressByItemId: Map<string, PlaybackProgress>;
  onPlay: (episode: EpisodeItem) => void;
  onBack: () => void;
  onToggleFavorite: () => void;
}

export const SeriesDetailView = ({
  show,
  activeEpisodeId,
  loading = false,
  isFavorite,
  progressByItemId,
  onPlay,
  onBack,
  onToggleFavorite,
}: SeriesDetailViewProps) => {
  const seasons = useMemo(() => {
    const map = new Map<number, EpisodeItem[]>();
    for (const episode of show.episodes) {
      const key = seasonKey(episode);
      const bucket = map.get(key) ?? [];
      bucket.push(episode);
      map.set(key, bucket);
    }
    return Array.from(map.entries())
      .map(([season, episodes]) => ({ season, episodes }))
      .sort((a, b) => a.season - b.season);
  }, [show.episodes]);

  const activeSeasonFromWatching = useMemo(() => {
    if (!activeEpisodeId) return null;
    const ep = show.episodes.find((episode) => episode.id === activeEpisodeId);
    return ep ? seasonKey(ep) : null;
  }, [activeEpisodeId, show.episodes]);

  const [activeSeason, setActiveSeason] = useState<number>(() => activeSeasonFromWatching ?? seasons[0]?.season ?? 0);

  useEffect(() => {
    if (activeSeasonFromWatching != null && activeSeasonFromWatching !== activeSeason) {
      setActiveSeason(activeSeasonFromWatching);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show.id, activeSeasonFromWatching]);

  const currentSeason = useMemo(
    () => seasons.find((season) => season.season === activeSeason) ?? seasons[0],
    [seasons, activeSeason],
  );

  const seasonHasAnyProgress = useMemo(() => {
    if (!currentSeason?.episodes.length) return false;
    return currentSeason.episodes.some((episode) => {
      const progress = progressByItemId.get(episode.id);
      return Boolean(progress?.completed || (progress && progress.positionSec > 3));
    });
  }, [currentSeason, progressByItemId]);

  const scrollTargetId = useMemo(() => {
    if (!currentSeason?.episodes.length) return null;
    if (!seasonHasAnyProgress) return currentSeason.episodes[0].id;
    const activeInSeason = currentSeason.episodes.find((episode) => episode.id === activeEpisodeId);
    return activeInSeason?.id ?? currentSeason.episodes[0].id;
  }, [currentSeason, seasonHasAnyProgress, activeEpisodeId]);

  const scrollTargetRef = useRef<HTMLLIElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const scroller = listRef.current;
    const targetEl = scrollTargetRef.current;
    if (!scroller || !targetEl) return;
    const target = targetEl.offsetTop - scroller.clientHeight / 2 + targetEl.clientHeight / 2;
    try {
      scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    } catch {
      scroller.scrollTop = Math.max(0, target);
    }
  }, [scrollTargetId, activeSeason, show.id]);

  const firstEpisode = show.episodes[0];
  const nextUnwatched = useMemo(() => {
    for (const episode of show.episodes) {
      const progress = progressByItemId.get(episode.id);
      if (!progress?.completed) return episode;
    }
    return firstEpisode;
  }, [show.episodes, progressByItemId, firstEpisode]);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onBack} className="btn shrink-0" aria-label="Back to series list">
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-slate-100">{show.title}</h2>
          <p className="text-xs text-slate-400">
            {show.episodes.length > 0
              ? `${show.episodes.length} episode${show.episodes.length === 1 ? "" : "s"}`
              : loading
                ? "Loading episodes..."
                : "Episodes load when you open the series"}
            {show.groupTitle ? ` - ${show.groupTitle}` : ""}
          </p>
          {show.description ? (
            <p dir="auto" className="mt-2 text-sm leading-6 text-slate-300 [text-align:start]">
              {show.description}
            </p>
          ) : null}
        </div>
        <button type="button" className="btn shrink-0" onClick={onToggleFavorite}>
          <Star size={14} className={isFavorite ? "fill-amber-300 text-amber-300" : ""} />
          {isFavorite ? "Unfavorite" : "Favorite"}
        </button>
        {nextUnwatched ? (
          <button type="button" className="btn btn-primary shrink-0" onClick={() => onPlay(nextUnwatched)}>
            <Play size={14} />
            {progressByItemId.get(nextUnwatched.id)?.positionSec ? "Resume" : "Play"}
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-[200px_1fr]">
        <div className="hidden md:block">
          {show.logo ? (
            <img
              src={show.logo}
              alt={show.title}
              loading="lazy"
              className="aspect-[2/3] w-full rounded-xl border border-slate-800 bg-slate-950 object-cover"
            />
          ) : (
            <div className="flex aspect-[2/3] w-full items-center justify-center rounded-xl border border-slate-800 bg-gradient-to-br from-slate-800 to-slate-950 text-slate-400">
              <span className="line-clamp-3 px-3 text-center text-sm">{show.title}</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {seasons.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
              {seasons.map(({ season, episodes }) => (
                <button
                  key={season}
                  type="button"
                  onClick={() => setActiveSeason(season)}
                  className={clsx(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition",
                    season === activeSeason
                      ? "bg-cyan-500/20 text-cyan-100"
                      : "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
                  )}
                >
                  Season {season}
                  <span className="ml-1 text-[10px] text-slate-500">{episodes.length}</span>
                </button>
              ))}
            </div>
          ) : null}

          {currentSeason ? (
            <section className="panel p-3">
              <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
                <span>
                  {currentSeason.episodes.length} episode{currentSeason.episodes.length === 1 ? "" : "s"}
                </span>
                <span>scroll for more</span>
              </div>
              <div
                ref={listRef}
                className="max-h-[min(60vh,32rem)] overflow-y-auto rounded-md bg-slate-950/40 pr-1"
              >
                <ul className="space-y-1 p-1">
                  {currentSeason.episodes.map((episode) => {
                    const progress = progressByItemId.get(episode.id);
                    const ratio =
                      progress && progress.durationSec > 0 ? Math.min(1, progress.positionSec / progress.durationSec) : 0;
                    const isActive = activeEpisodeId === episode.id;
                    const isScrollTarget = episode.id === scrollTargetId;
                    const isSuggestedStart = !seasonHasAnyProgress && episode.id === currentSeason.episodes[0]?.id;
                    const isCompleted = Boolean(progress?.completed);
                    return (
                      <li
                        key={episode.id}
                        ref={isScrollTarget ? scrollTargetRef : undefined}
                        aria-current={isSuggestedStart ? "true" : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => onPlay(episode)}
                          className={clsx(
                            "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm transition",
                            isActive
                              ? "bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-400/50"
                              : isSuggestedStart
                                ? "border border-dashed border-slate-500/50 bg-slate-800/80 text-slate-100"
                                : "bg-slate-900 hover:bg-slate-800",
                          )}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2">
                              {isCompleted ? (
                                <CheckCircle2 size={14} className="shrink-0 text-emerald-400" aria-label="Watched" />
                              ) : (
                                <span
                                  className={clsx(
                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                    ratio > 0 ? "bg-cyan-300" : "bg-slate-700",
                                  )}
                                  aria-hidden
                                />
                              )}
                              <span className="line-clamp-1">
                                S{episode.season ?? 0}E{episode.episode ?? 0}
                                {"  "} - {"  "}
                                {episode.title}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2 text-[11px] text-slate-400">
                              {progress?.updatedAt ? <span>{formatShortDate(progress.updatedAt)}</span> : null}
                              {isActive ? <span className="text-cyan-200">Now playing</span> : null}
                              {isSuggestedStart && !isActive ? <span className="text-slate-500">Start here</span> : null}
                              <ChevronRight size={14} />
                            </span>
                          </div>
                          {ratio > 0 && !isCompleted ? (
                            <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="h-full rounded-full bg-cyan-400"
                                style={{ width: `${Math.max(2, ratio * 100)}%` }}
                              />
                            </div>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ) : loading ? (
            <section className="panel p-4 text-sm text-slate-400">Loading series details...</section>
          ) : (
            <section className="panel p-4 text-sm text-slate-400">No episodes loaded for this series yet.</section>
          )}
        </div>
      </div>
    </div>
  );
};
