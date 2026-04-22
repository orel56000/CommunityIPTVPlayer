import clsx from "clsx";
import type { PlaylistSection } from "../../types/models";

const tabs: Array<{ id: PlaylistSection; label: string }> = [
  { id: "live", label: "Live TV" },
  { id: "movies", label: "Movies" },
  { id: "series", label: "Series" },
  { id: "catchup", label: "Catch-up" },
  { id: "favorites", label: "Favorites" },
  { id: "recents", label: "Recently Played" },
  { id: "continue", label: "Continue Watching" },
  { id: "settings", label: "Settings" },
];

interface SectionTabsProps {
  activeSection: PlaylistSection;
  onChange: (section: PlaylistSection) => void;
}

export const SectionTabs = ({ activeSection, onChange }: SectionTabsProps) => (
  <div className="flex gap-1 overflow-x-auto rounded-2xl border border-white/[0.06] bg-slate-950/50 p-1 shadow-inner backdrop-blur-md [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
    {tabs.map((tab) => (
      <button
        key={tab.id}
        type="button"
        className={clsx(
          "shrink-0 whitespace-nowrap rounded-xl px-3.5 py-2 text-xs font-semibold tracking-wide transition duration-200",
          activeSection === tab.id
            ? "bg-gradient-to-r from-cyan-500 to-sky-500 text-white shadow-md shadow-cyan-500/25"
            : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
        )}
        onClick={() => onChange(tab.id)}
      >
        {tab.label}
      </button>
    ))}
  </div>
);
