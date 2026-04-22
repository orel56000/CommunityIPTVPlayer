import { Download, Share, Smartphone } from "lucide-react";
import { useInstallAppPrompt } from "../../hooks/useInstallAppPrompt";

export const InstallAppBanner = () => {
  const { visible, variant, promptInstall, dismiss } = useInstallAppPrompt();

  if (!visible || !variant) return null;

  const isChromeStyle = variant === "browser-install";

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4"
      role="region"
      aria-label="Install app suggestion"
    >
      <div className="panel mx-auto flex max-w-2xl flex-col gap-3 border-cyan-500/20 p-3.5 shadow-cyan-950/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-4">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 ring-1 ring-white/10">
            {isChromeStyle ? <Download className="text-cyan-300" size={22} aria-hidden /> : <Smartphone className="text-cyan-300" size={22} aria-hidden />}
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">Install Community IPTV Player</p>
            {isChromeStyle ? (
              <p className="text-xs leading-relaxed text-slate-400">
                Add a shortcut that opens in its own window, making Community IPTV Player easier to launch from your home screen or taskbar.
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-slate-400">
                <span className="inline-flex items-center gap-1 font-medium text-slate-300">
                  <Share size={12} className="shrink-0 text-cyan-400/90" aria-hidden />
                  Share
                </span>
                , then{" "}
                <span className="font-medium text-slate-300">Add to Home Screen</span>, and it opens fullscreen like an app.
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {isChromeStyle ? (
            <button type="button" className="btn btn-primary px-4 py-2 text-sm" onClick={() => void promptInstall()}>
              Install
            </button>
          ) : null}
          <button type="button" className="btn px-3 py-2 text-sm" onClick={dismiss}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
};
