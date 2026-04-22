import type { AppSettings } from "../../types/player";

interface SettingsViewProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onClearFavorites: () => void;
  onClearRecents: () => void;
  onClearContinue: () => void;
  onRemoveAllPlaylists: () => void;
  onExport: () => void;
  onImport: (file: File) => Promise<void>;
}

export const SettingsView = ({
  settings,
  onUpdate,
  onClearFavorites,
  onClearRecents,
  onClearContinue,
  onRemoveAllPlaylists,
  onExport,
  onImport,
}: SettingsViewProps) => (
  <div className="panel space-y-4 p-4">
    <h3 className="text-base font-semibold">Settings</h3>
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>Autoplay</span>
      <input
        type="checkbox"
        checked={settings.autoplay}
        onChange={(event) => onUpdate({ ...settings, autoplay: event.target.checked })}
      />
    </label>
    <p className="text-xs text-slate-500">
      The volume you set in the player is saved automatically and restored on your next visit ({Math.round(settings.rememberedVolume * 100)}% right now).
    </p>
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>Player volume: percent + number field</span>
      <input
        type="checkbox"
        checked={settings.volumePercentMode}
        onChange={(event) => onUpdate({ ...settings, volumePercentMode: event.target.checked })}
      />
    </label>
    <label className="space-y-1 text-sm">
      <span>Default volume for new installs / reset ({Math.round(settings.defaultVolume * 100)}%)</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={settings.defaultVolume}
        onChange={(event) => onUpdate({ ...settings, defaultVolume: Number(event.target.value) })}
        className="w-full"
      />
    </label>
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>Collapsed sidebar</span>
      <input
        type="checkbox"
        checked={settings.sidebarCollapsed}
        onChange={(event) => onUpdate({ ...settings, sidebarCollapsed: event.target.checked })}
      />
    </label>
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>Theme</span>
      <select className="input max-w-40" value={settings.theme} onChange={(e) => onUpdate({ ...settings, theme: e.target.value as "dark" | "light" })}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
    <div className="grid gap-2 sm:grid-cols-2">
      <button className="btn" type="button" onClick={onClearFavorites}>
        Clear favorites
      </button>
      <button className="btn" type="button" onClick={onClearRecents}>
        Clear recents
      </button>
      <button className="btn" type="button" onClick={onClearContinue}>
        Clear continue watching
      </button>
      <button className="btn" type="button" onClick={onRemoveAllPlaylists}>
        Remove all playlists
      </button>
    </div>
    <div className="grid gap-2 sm:grid-cols-2">
      <button className="btn" type="button" onClick={onExport}>
        Export app data
      </button>
      <label className="btn cursor-pointer justify-center">
        Import app data
        <input
          className="hidden"
          type="file"
          accept="application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await onImport(file);
          }}
        />
      </label>
    </div>
  </div>
);
