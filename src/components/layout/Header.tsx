import { ChevronRight, MonitorPlay, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import type { PlaylistItem } from "../../types/models";
import { GitHubIcon } from "../shared/GitHubIcon";

interface HeaderProps {
  currentItem: PlaylistItem | null;
  rightPanelOpen: boolean;
  onOpenSearch: () => void;
  onOpenNowPlaying: () => void;
  onToggleRightPanel: () => void;
}

const SearchTrigger = ({ onOpenSearch }: { onOpenSearch: () => void }) => (
  <button type="button" className="glass-search-trigger" onClick={onOpenSearch} aria-label="Open search">
    <Search size={18} className="shrink-0 text-cyan-400/80" />
    <span className="whitespace-nowrap text-sm text-slate-300">Search channels, movies, series…</span>
    <kbd className="hidden rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-slate-500 sm:inline">
      /
    </kbd>
  </button>
);

export const Header = ({
  currentItem,
  rightPanelOpen,
  onOpenSearch,
  onOpenNowPlaying,
  onToggleRightPanel,
}: HeaderProps) => (
  <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-slate-950/65 backdrop-blur-2xl supports-[backdrop-filter]:bg-slate-950/50">
    <div className="relative mx-auto flex h-14 max-w-[1920px] items-center px-4 sm:h-16 lg:px-8">
      <div className="relative z-10 flex min-w-0 shrink items-center gap-2.5 sm:gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 ring-1 ring-white/10 sm:h-9 sm:w-9">
            <MonitorPlay className="text-cyan-300" size={17} />
          </div>
          <span className="bg-gradient-to-r from-cyan-200 via-sky-300 to-violet-300 bg-clip-text text-sm font-bold tracking-tight text-transparent sm:text-base">
            CTV
          </span>
        </div>

        {currentItem ? (
          <button
            type="button"
            className="now-playing-chip"
            onClick={onOpenNowPlaying}
            aria-label={`Now playing: ${currentItem.title}. Open to browse episodes.`}
            title="Browse episodes & related content"
          >
            {currentItem.logo ? (
              <img
                src={currentItem.logo}
                alt=""
                className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/10 sm:h-10 sm:w-10"
                loading="lazy"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-xs font-semibold text-slate-300 ring-1 ring-white/10 sm:h-10 sm:w-10">
                {currentItem.title.slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-cyan-400/90 sm:text-[11px]">
                Now playing
              </span>
              <span className="line-clamp-1 text-xs font-medium text-slate-100 sm:text-sm">{currentItem.title}</span>
            </span>
            <ChevronRight size={15} className="shrink-0 text-slate-500" aria-hidden />
          </button>
        ) : (
          <span className="hidden text-xs text-slate-500 sm:inline">Community IPTV Player</span>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-4 inset-y-0 flex items-center justify-center sm:inset-x-8">
        <div className="pointer-events-auto max-w-full">
          <SearchTrigger onOpenSearch={onOpenSearch} />
        </div>
      </div>

      <div className="relative z-10 ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="btn border-white/10 bg-white/[0.04] px-2.5 py-2"
          onClick={onToggleRightPanel}
          aria-label={rightPanelOpen ? "Hide side panel" : "Show side panel"}
          title={rightPanelOpen ? "Hide playlists & details" : "Show playlists & details"}
        >
          {rightPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
        <a
          className="btn hidden border-white/10 bg-white/[0.04] px-3 py-2 text-sm sm:inline-flex"
          href="https://github.com/orel56000/CommunityIPTVPlayer"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open Community IPTV Player repository"
          title="Open GitHub repository"
        >
          <GitHubIcon className="h-4 w-4 text-slate-200" />
        </a>
      </div>
    </div>
  </header>
);
