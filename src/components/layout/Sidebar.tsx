import clsx from "clsx";
import { Settings } from "lucide-react";
import type { PlaylistSection, SavedPlaylist } from "../../types/models";

interface SidebarProps {
  playlists: SavedPlaylist[];
  activePlaylistId: string | null;
  activeSection: PlaylistSection;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSelectPlaylist: (id: string) => void;
  onSelectSection: (section: PlaylistSection) => void;
}

const sections: Array<{ id: PlaylistSection; label: string }> = [
  { id: "live", label: "Live TV" },
  { id: "movies", label: "Movies" },
  { id: "series", label: "Series" },
  { id: "catchup", label: "Catch-up" },
  { id: "favorites", label: "Favorites" },
  { id: "recents", label: "Recently Played" },
  { id: "continue", label: "Continue Watching" },
];

const navBtn = (active: boolean) =>
  clsx(
    "w-full rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition duration-200",
    active
      ? "border-cyan-500/35 bg-gradient-to-r from-cyan-500/15 via-sky-500/10 to-transparent text-cyan-50 shadow-inner shadow-cyan-500/5"
      : "border-transparent bg-white/[0.03] text-slate-300 hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-slate-100",
  );

export const Sidebar = ({
  playlists,
  activePlaylistId,
  activeSection,
  collapsed,
  mobileOpen,
  onCloseMobile,
  onSelectPlaylist,
  onSelectSection,
}: SidebarProps) => (
  <>
    <div
      className={clsx(
        "fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm transition-opacity lg:hidden",
        !mobileOpen && "pointer-events-none opacity-0",
      )}
      onClick={onCloseMobile}
      aria-hidden
    />
    <aside
      className={clsx(
        "fixed left-0 top-16 z-40 h-[calc(100vh-4rem)] overflow-y-auto border-r border-white/[0.06] bg-slate-950/55 p-3 shadow-2xl shadow-black/40 backdrop-blur-2xl transition-transform duration-300 ease-out lg:static lg:z-0 lg:h-auto lg:translate-x-0 lg:shadow-none",
        collapsed ? "w-[5.25rem]" : "w-72",
        mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
      )}
    >
      <div className="space-y-6 px-1 pb-6">
        <div>
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Playlists</p>
          <div className="space-y-1">
            {playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                className={navBtn(playlist.id === activePlaylistId)}
                onClick={() => {
                  onSelectPlaylist(playlist.id);
                  onCloseMobile();
                }}
              >
                {collapsed ? (
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-sm font-bold text-cyan-300">
                    {playlist.name.slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  playlist.name
                )}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Browse</p>
          <div className="space-y-1">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={navBtn(section.id === activeSection)}
                onClick={() => {
                  onSelectSection(section.id);
                  onCloseMobile();
                }}
              >
                {collapsed ? (
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-xs font-semibold text-slate-200">
                    {section.label.slice(0, 1)}
                  </span>
                ) : (
                  section.label
                )}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className={clsx(navBtn(activeSection === "settings"), "mt-2 flex items-center gap-2")}
          onClick={() => {
            onSelectSection("settings");
            onCloseMobile();
          }}
        >
          <Settings size={16} className="shrink-0 text-slate-400" />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
    </aside>
  </>
);
