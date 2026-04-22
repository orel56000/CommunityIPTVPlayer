import clsx from "clsx";
import { Star } from "lucide-react";
import type { PlaylistItem } from "../../types/models";

interface ContentCardProps {
  item: PlaylistItem;
  isFavorite: boolean;
  isActive: boolean;
  onPlay: () => void;
  onToggleFavorite: () => void;
}

export const ContentCard = ({ item, isFavorite, isActive, onPlay, onToggleFavorite }: ContentCardProps) => (
  <article className={clsx("card-tile", isActive && "card-tile-active")}>
    <button className="w-full text-left" onClick={onPlay} type="button">
      {item.logo ? (
        <img src={item.logo} alt={item.title} className="h-40 w-full bg-slate-950 object-cover" loading="lazy" />
      ) : (
        <div className="flex h-40 items-center justify-center bg-gradient-to-br from-slate-800/80 via-slate-900 to-violet-950/40 text-slate-400">
          <span className="line-clamp-2 px-4 text-center text-sm font-medium">{item.title}</span>
        </div>
      )}
      <div className="space-y-1 p-3.5">
        <h4 className="line-clamp-1 text-sm font-semibold tracking-tight text-slate-100">{item.title}</h4>
        <p className="line-clamp-1 text-xs text-slate-500">{item.groupTitle ?? "Ungrouped"}</p>
      </div>
    </button>
    <div className="px-3.5 pb-3.5">
      <button className="btn w-full justify-center border-white/[0.06] py-2 text-xs" type="button" onClick={onToggleFavorite}>
        <Star size={14} className={isFavorite ? "fill-amber-300 text-amber-300" : ""} />
        {isFavorite ? "Unfavorite" : "Favorite"}
      </button>
    </div>
  </article>
);
