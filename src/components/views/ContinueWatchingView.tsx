import { useMemo } from "react";
import { Film, Play, Tv2, X } from "lucide-react";
import { formatDuration, formatShortDate } from "../../utils/time";
import type { PlaybackProgress, PlaylistItem } from "../../types/models";
import { EmptyState } from "../shared/EmptyState";
import { useInfiniteList } from "../../hooks/useInfiniteList";

interface ContinueWatchingViewProps {
  items: PlaylistItem[];
  progress: PlaybackProgress[];
  onPlay: (item: PlaylistItem) => void;
  onRemove: (item: PlaylistItem) => void;
  onOpenSeries?: (item: PlaylistItem) => void;
}

export const ContinueWatchingView = ({
  items,
  progress,
  onPlay,
  onRemove,
  onOpenSeries,
}: ContinueWatchingViewProps) => {
  const { visibleCount, hasMore, sentinelRef } = useInfiniteList(items.length, { initialCount: 60, step: 60 });
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);

  if (!items.length) {
    return (
      <EmptyState
        title="Nothing to continue"
        description="Leave a movie or episode before it ends and we will keep your progress here."
      />
    );
  }

  return (
    <div className="space-y-2">
      {visibleItems.map((item) => {
        const p = progress.find((entry) => entry.itemId === item.id);
        const ratio = p && p.durationSec > 0 ? Math.min(1, p.positionSec / p.durationSec) : 0;
        const isSeriesEpisode = item.section === "series" || item.kind === "series_episode";
        return (
          <div key={item.id} className="panel p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-semibold">
                  {isSeriesEpisode && item.seriesTitle ? (
                    <>
                      <span className="text-slate-200">{item.seriesTitle}</span>
                      {" · "}
                      <span className="text-slate-400">
                        S{item.season ?? 0}E{item.episode ?? 0}
                        {item.episodeTitle ? ` · ${item.episodeTitle}` : ""}
                      </span>
                    </>
                  ) : (
                    item.title
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
                  <span>
                    {formatDuration(p?.positionSec ?? 0)} / {formatDuration(p?.durationSec ?? 0)}
                  </span>
                  {p?.updatedAt ? <span>· {formatShortDate(p.updatedAt)}</span> : null}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="btn"
                  onClick={() => onPlay(item)}
                  type="button"
                  title="Resume playback"
                  aria-label="Resume"
                >
                  <Play size={14} />
                  Resume
                </button>
                {isSeriesEpisode && onOpenSeries ? (
                  <button
                    className="btn"
                    onClick={() => onOpenSeries(item)}
                    type="button"
                    title="Open series — see all episodes"
                    aria-label="Open series"
                  >
                    <Tv2 size={14} />
                  </button>
                ) : null}
                {!isSeriesEpisode ? (
                  <span className="inline-flex h-8 w-8 items-center justify-center text-slate-500" title={item.section}>
                    <Film size={14} />
                  </span>
                ) : null}
                <button
                  className="control-btn"
                  onClick={() => onRemove(item)}
                  type="button"
                  title="Remove from Continue Watching"
                  aria-label="Remove from Continue Watching"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-cyan-400" style={{ width: `${ratio * 100}%` }} />
            </div>
          </div>
        );
      })}
      {hasMore ? (
        <div
          ref={sentinelRef}
          className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-center text-xs text-slate-400"
        >
          Loading more continue-watching items...
        </div>
      ) : null}
    </div>
  );
};
