import { useEffect, useState } from "react";
import { MonitorDown, X } from "lucide-react";
import {
  getRelayStatus,
  subscribeRelayStatus,
  type RelayStatus,
} from "../../utils/relayDiscovery";

const HELPER_RELEASES_URL = "https://github.com/orel56000/CommunityIPTVPlayer/releases";
const DISMISS_KEY = "ctv-helper-banner-dismissed";

/**
 * Prompts the user to install the local helper app when the site is running in
 * a plain browser (not the bundled window) and no local relay was discovered.
 * The helper is what makes IP-locked providers + live TV work; without it the
 * site keeps its current web behavior. Shown once until dismissed.
 */
export const HelperRelayBanner = () => {
  const [status, setStatus] = useState<RelayStatus>(getRelayStatus());
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => subscribeRelayStatus(setStatus), []);

  // Bundled window is served by the relay on 127.0.0.1:11471 — never prompt there.
  const servedByRelay =
    typeof window !== "undefined" &&
    /^127\.0\.0\.1$|^localhost$/i.test(window.location.hostname) &&
    window.location.port === "11471";

  if (dismissed || servedByRelay || status !== "unavailable") return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 sm:px-4"
      role="region"
      aria-label="Helper app suggestion"
    >
      <div className="panel mx-auto flex max-w-2xl flex-col gap-3 border-amber-500/20 p-3.5 shadow-amber-950/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-4">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500/20 to-cyan-500/20 ring-1 ring-white/10">
            <MonitorDown className="text-amber-300" size={22} aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">Live TV &amp; blocked streams need the helper app</p>
            <p className="text-xs leading-relaxed text-slate-400">
              Some providers only allow your home IP and block live channels in the browser. Install the
              Community IPTV Player helper — a small desktop app that streams from your machine — and this
              site will use it automatically.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <a
            className="btn btn-primary px-4 py-2 text-sm"
            href={HELPER_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
          >
            Get the helper
          </a>
          <button type="button" className="btn px-3 py-2 text-sm" onClick={dismiss} aria-label="Dismiss">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
};
