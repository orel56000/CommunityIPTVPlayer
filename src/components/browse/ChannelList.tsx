import { useMemo } from "react";
import clsx from "clsx";
import { Star } from "lucide-react";
import type { PlaylistItem } from "../../types/models";
import { useInfiniteList } from "../../hooks/useInfiniteList";

interface ChannelListProps {
  channels: PlaylistItem[];
  activeItemId?: string;
  favoriteSet: Set<string>;
  onPlay: (item: PlaylistItem) => void;
  onToggleFavorite: (item: PlaylistItem) => void;
}

export const ChannelList = ({ channels, activeItemId, favoriteSet, onPlay, onToggleFavorite }: ChannelListProps) => {
  const { visibleCount, hasMore, sentinelRef } = useInfiniteList(channels.length, { initialCount: 120, step: 120 });
  const visibleChannels = useMemo(() => channels.slice(0, visibleCount), [channels, visibleCount]);

  return (
    <div className="panel overflow-hidden p-0">
      <ul className="divide-y divide-white/[0.06]">
        {visibleChannels.map((channel) => (
          <li
            key={channel.id}
            className={clsx(
              "flex items-center gap-3 px-3 py-2.5 transition duration-200",
              channel.id === activeItemId
                ? "bg-gradient-to-r from-cyan-500/12 via-sky-500/8 to-transparent"
                : "hover:bg-white/[0.04]",
            )}
          >
            {channel.logo ? (
              <img
                src={channel.logo}
                alt={channel.title}
                className="h-10 w-10 rounded-xl bg-slate-950 object-cover ring-1 ring-white/10"
                loading="lazy"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-sm font-semibold text-slate-300 ring-1 ring-white/10">
                {channel.title.slice(0, 1).toUpperCase()}
              </div>
            )}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onPlay(channel)}>
              <p className="line-clamp-1 text-sm font-medium text-slate-100">{channel.title}</p>
              <p className="line-clamp-1 text-xs text-slate-500">{channel.groupTitle ?? "Ungrouped"}</p>
            </button>
            <button className="btn shrink-0 border-white/10 px-2.5 py-2" type="button" onClick={() => onToggleFavorite(channel)}>
              <Star size={14} className={favoriteSet.has(channel.id) ? "fill-amber-300 text-amber-300" : ""} />
            </button>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <div ref={sentinelRef} className="border-t border-white/[0.05] px-3 py-3 text-center text-xs text-slate-500">
          Loading more channels…
        </div>
      ) : null}
    </div>
  );
};
