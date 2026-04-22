import { Menu, MonitorPlay } from "lucide-react";
import type { PlaylistItem } from "../../types/models";

interface HeaderProps {
  currentItem: PlaylistItem | null;
  onOpenImport: () => void;
  onToggleSidebar: () => void;
}

export const Header = ({ currentItem, onOpenImport, onToggleSidebar }: HeaderProps) => (
  <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-slate-950/65 px-4 backdrop-blur-2xl supports-[backdrop-filter]:bg-slate-950/50 lg:px-8">
    <div className="mx-auto flex h-16 max-w-[1920px] items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <button
          className="btn border-white/10 bg-white/[0.04] px-3 py-2 lg:hidden"
          type="button"
          onClick={onToggleSidebar}
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
        <div className="hidden items-center gap-2.5 lg:flex">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 ring-1 ring-white/10">
            <MonitorPlay className="text-cyan-300" size={18} />
          </div>
          <span className="bg-gradient-to-r from-cyan-200 via-sky-300 to-violet-300 bg-clip-text text-base font-bold tracking-tight text-transparent">
            CTV
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 justify-center px-4 md:flex">
        <div className="max-w-xl truncate rounded-full border border-white/[0.06] bg-white/[0.04] px-4 py-1.5 text-center text-xs text-slate-400 backdrop-blur-sm">
          {currentItem ? (
            <>
              <span className="font-medium text-cyan-400/90">Now playing</span>
              <span className="mx-2 text-slate-600">·</span>
              <span className="text-slate-300">{currentItem.title}</span>
            </>
          ) : (
            <span>Import an M3U playlist to start watching</span>
          )}
        </div>
      </div>
      <button className="btn btn-primary shrink-0 px-4 py-2 text-sm" type="button" onClick={onOpenImport}>
        Add playlist
      </button>
    </div>
  </header>
);
