import { ExternalLink, Server, Settings, X } from "lucide-react";
import type { ReactNode } from "react";
import clsx from "clsx";
import { GitHubIcon } from "../shared/GitHubIcon";
import type { RelayStatus } from "../../utils/relayDiscovery";

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  backendStatus: RelayStatus;
  onOpenBackendConnection: () => void;
  onOpenSettings: () => void;
  /** The playlists manager and stream-details panels, rendered inside the drawer. */
  playlistsPanel: ReactNode;
  detailsPanel: ReactNode;
}

const statusDot = (status: RelayStatus): string =>
  status === "available"
    ? "bg-emerald-400"
    : status === "checking" || status === "unknown"
      ? "bg-amber-400"
      : "bg-rose-500";

const statusLabel = (status: RelayStatus): string =>
  status === "available"
    ? "Connected"
    : status === "checking"
      ? "Checking…"
      : status === "unknown"
        ? "…"
        : "Not connected";

/**
 * Phone-only slide-in drawer (from the right) that holds the utility actions that
 * used to crowd the header — backend connection, settings, GitHub — plus the
 * playlists and stream-details panels. Hidden on `sm+`, where those live in the
 * header and the right column instead.
 */
export const MobileMenu = ({
  open,
  onClose,
  backendStatus,
  onOpenBackendConnection,
  onOpenSettings,
  playlistsPanel,
  detailsPanel,
}: MobileMenuProps) => (
  <div className={clsx("fixed inset-0 z-40 sm:hidden", !open && "pointer-events-none")} aria-hidden={!open}>
    <button
      type="button"
      aria-label="Close menu"
      tabIndex={open ? 0 : -1}
      className={clsx(
        "absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200",
        open ? "opacity-100" : "opacity-0",
      )}
      onClick={onClose}
    />
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      className={clsx(
        "absolute inset-y-0 right-0 flex w-[86%] max-w-sm flex-col gap-3 overflow-y-auto border-l border-white/10 bg-slate-950/95 p-4 shadow-2xl shadow-black/60 backdrop-blur-xl transition-transform duration-300",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Menu</span>
        <button type="button" className="control-btn" onClick={onClose} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="btn w-full justify-start gap-3"
          onClick={() => {
            onClose();
            onOpenBackendConnection();
          }}
        >
          <Server size={16} className="shrink-0" />
          <span className="flex-1 text-left">Backend connection</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <span className={clsx("h-2 w-2 rounded-full", statusDot(backendStatus))} aria-hidden />
            {statusLabel(backendStatus)}
          </span>
        </button>
        <button
          type="button"
          className="btn w-full justify-start gap-3"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          <Settings size={16} className="shrink-0" />
          <span className="flex-1 text-left">Settings</span>
        </button>
        <a
          className="btn w-full justify-start gap-3"
          href="https://github.com/orel56000/CommunityIPTVPlayer"
          target="_blank"
          rel="noopener noreferrer"
        >
          <GitHubIcon className="h-4 w-4 shrink-0 text-slate-200" />
          <span className="flex-1 text-left">GitHub</span>
          <ExternalLink size={14} className="shrink-0 text-slate-500" aria-hidden />
        </a>
      </div>

      <div className="mt-1 flex min-h-0 flex-1 flex-col gap-3">
        {playlistsPanel}
        {detailsPanel}
      </div>
    </div>
  </div>
);
