import { SkipForward } from "lucide-react";
import type { EpisodeItem } from "../../types/models";

interface PlayerNavBarProps {
  currentTitle: string | null;
  nextEpisode: EpisodeItem | null;
  onPlayNext: () => void;
}

export const PlayerNavBar = ({ currentTitle, nextEpisode, onPlayNext }: PlayerNavBarProps) => {
  if (!currentTitle && !nextEpisode) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-slate-900/50 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
      <div className="min-w-0 flex-1 text-xs">
        {currentTitle ? (
          <p className="line-clamp-1">
            <span className="font-semibold text-cyan-400/90">Now playing</span>
            <span className="mx-2 text-slate-600">·</span>
            <span className="text-slate-200">{currentTitle}</span>
          </p>
        ) : null}
        {nextEpisode ? (
          <p className="mt-1 line-clamp-1 text-slate-500">
            <span className="text-slate-600">Up next</span>
            <span className="mx-2">·</span>
            <span className="text-slate-300">
              S{nextEpisode.season ?? 0}E{nextEpisode.episode ?? 0} · {nextEpisode.title}
            </span>
          </p>
        ) : null}
      </div>
      {nextEpisode ? (
        <button type="button" className="btn btn-primary shrink-0 py-2 text-xs" onClick={onPlayNext} title="Play next episode">
          <SkipForward size={14} />
          Next episode
        </button>
      ) : null}
    </div>
  );
};
