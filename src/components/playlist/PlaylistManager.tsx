import { Download, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import clsx from "clsx";
import type { SavedPlaylist } from "../../types/models";
import { formatRelative } from "../../utils/time";

interface PlaylistManagerProps {
  playlists: SavedPlaylist[];
  activePlaylistId: string | null;
  onSelect: (playlistId: string) => void;
  onDelete: (playlistId: string) => void;
  onDownload: (playlistId: string) => void;
  onRename: (playlistId: string) => void;
  onRefresh: (playlistId: string) => void;
  onAddPlaylist: () => void;
}

export const PlaylistManager = ({
  playlists,
  activePlaylistId,
  onDelete,
  onDownload,
  onRename,
  onSelect,
  onRefresh,
  onAddPlaylist,
}: PlaylistManagerProps) => (
  <div className="panel panel-scroll min-h-0 max-h-[42%] shrink-0 space-y-3 overflow-x-hidden p-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold tracking-tight text-slate-100">Saved playlists</h3>
      <button className="btn btn-primary px-2.5 py-1.5 text-xs" type="button" onClick={onAddPlaylist}>
        <Plus size={14} />
        Add playlist
      </button>
    </div>
    {!playlists.length ? <p className="text-sm text-slate-500">No playlists saved yet.</p> : null}
    {playlists.map((playlist) => (
      <div
        key={playlist.id}
        className={clsx(
          "rounded-2xl border p-3.5 transition duration-200",
          playlist.id === activePlaylistId
            ? "border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-sky-500/5 shadow-inner"
            : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1] hover:bg-white/[0.05]",
        )}
      >
        <button type="button" onClick={() => onSelect(playlist.id)} className="w-full text-left">
          <p className="line-clamp-1 text-sm font-semibold text-slate-100">{playlist.name}</p>
          <p className="line-clamp-1 text-xs text-slate-500">
            {playlist.itemCount.toLocaleString()} items · updated {formatRelative(playlist.lastUpdatedAt)}
          </p>
        </button>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn border-white/10 py-1.5 text-xs" type="button" onClick={() => onRename(playlist.id)}>
            <Pencil size={14} /> Rename
          </button>
          <button className="btn border-white/10 py-1.5 text-xs" type="button" onClick={() => onDownload(playlist.id)}>
            <Download size={14} /> Download
          </button>
          <button
            className="btn border-white/10 py-1.5 text-xs"
            type="button"
            onClick={() => onRefresh(playlist.id)}
            disabled={!["url", "xtream"].includes(playlist.source.type)}
          >
            <RefreshCw size={14} /> Reload source
          </button>
          <button className="btn border-rose-500/20 bg-rose-500/10 py-1.5 text-xs text-rose-200 hover:bg-rose-500/20" type="button" onClick={() => onDelete(playlist.id)}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
    ))}
  </div>
);
