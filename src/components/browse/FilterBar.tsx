interface FilterBarProps {
  groups: string[];
  selectedGroup: string;
  favoritesOnly: boolean;
  groupLabel?: string;
  allOptionLabel?: string;
  includeAllOption?: boolean;
  onGroupChange: (group: string) => void;
  onToggleFavorites: () => void;
}

export const FilterBar = ({
  groups,
  selectedGroup,
  favoritesOnly,
  groupLabel = "Group",
  allOptionLabel = "All groups",
  includeAllOption = true,
  onGroupChange,
  onToggleFavorites,
}: FilterBarProps) => (
  <div className="flex flex-wrap items-center gap-2">
    <select
      className="input max-w-56 cursor-pointer rounded-xl py-2"
      value={selectedGroup}
      onChange={(event) => onGroupChange(event.target.value)}
      aria-label={`${groupLabel} filter`}
    >
      {includeAllOption ? <option value="all">{allOptionLabel}</option> : null}
      {groups.map((group) => (
        <option key={group} value={group}>
          {group}
        </option>
      ))}
    </select>
    <button
      className={favoritesOnly ? "btn btn-primary py-2 text-xs" : "btn border-white/10 py-2 text-xs"}
      type="button"
      onClick={onToggleFavorites}
    >
      {favoritesOnly ? "Show all" : "Favorites only"}
    </button>
  </div>
);
