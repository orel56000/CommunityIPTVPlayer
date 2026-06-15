import { SkipForward } from "lucide-react";
import type { EpisodeItem } from "../../types/models";

interface PlayerNavBarProps {
  nextEpisode: EpisodeItem | null;
  onPlayNext: () => void;
}

export const PlayerNavBar = ({ nextEpisode, onPlayNext }: PlayerNavBarProps) => {
  if (!nextEpisode) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-slate-900/50 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
      <p className="min-w-0 flex-1 line-clamp-1 text-xs text-slate-500">
        <span className="text-slate-600">Up next</span>
        <span className="mx-2">·</span>
        <span className="text-slate-300">
          S{nextEpisode.season ?? 0}E{nextEpisode.episode ?? 0} · {nextEpisode.title}
        </span>
      </p>
      <button type="button" className="btn btn-primary shrink-0 py-2 text-xs" onClick={onPlayNext} title="Play next episode">
        <SkipForward size={14} />
        Next episode
      </button>
    </div>
  );
};
