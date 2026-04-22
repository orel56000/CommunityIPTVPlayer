import { Search, X } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  resultCount?: number;
}

export const SearchBar = ({ value, onChange, placeholder = "Search...", resultCount }: SearchBarProps) => (
  <div className="flex items-center gap-3">
    <div className="relative flex-1">
      <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-cyan-500/70" />
      <input
        className="input rounded-2xl border-white/[0.07] py-2.5 pl-11 pr-10 shadow-none"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-200"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
    {typeof resultCount === "number" ? (
      <span className="hidden min-w-[5.5rem] text-right text-xs font-medium tabular-nums text-slate-500 sm:block">
        {resultCount.toLocaleString()}
        <span className="block text-[10px] font-normal uppercase tracking-wider text-slate-600">results</span>
      </span>
    ) : null}
  </div>
);
