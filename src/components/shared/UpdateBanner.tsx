import { Download, X } from "lucide-react";
import type { UpdateInfo } from "../../utils/appUpdate";

interface UpdateBannerProps {
  update: UpdateInfo;
  onUpdate: () => void;
  onDismiss: () => void;
  busy?: boolean;
}

export const UpdateBanner = ({ update, onUpdate, onDismiss, busy = false }: UpdateBannerProps) => (
  <div className="flex items-center gap-3 rounded-2xl border border-cyan-400/25 bg-cyan-950/40 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 ring-1 ring-cyan-400/30">
      <Download size={18} className="text-cyan-300" aria-hidden />
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold text-slate-100">
        Update available — v{update.latestVersion}
      </p>
      <p className="truncate text-xs text-slate-400">
        You have v{update.currentVersion}. Get the newest version.
      </p>
    </div>
    <button type="button" className="btn btn-primary shrink-0 py-2 text-xs" onClick={onUpdate} disabled={busy}>
      {busy ? "Opening…" : "Update"}
    </button>
    <button
      type="button"
      className="control-btn shrink-0"
      onClick={onDismiss}
      aria-label="Dismiss update notice"
      title="Later"
    >
      <X size={16} />
    </button>
  </div>
);
