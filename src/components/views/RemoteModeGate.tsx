import { useEffect, useRef } from "react";
import { MonitorPlay, Compass } from "lucide-react";
import type { RemoteMode } from "../../utils/syncSession";

interface RemoteModeGateProps {
  onChoose: (mode: RemoteMode) => void;
}

/**
 * First page a remote device sees when it opens the app over the master's
 * LAN address (`http://<ip>:11471/`): follow the master's playback ("sync")
 * or browse independently ("regular"). Shown once per browser session.
 *
 * The click here is also the user gesture that unlocks audible autoplay on TV
 * browsers — sync mode starts playback without another interaction, so this
 * page must never be skipped programmatically for follower sessions.
 */
export const RemoteModeGate = ({ onChoose }: RemoteModeGateProps) => {
  const syncButtonRef = useRef<HTMLButtonElement | null>(null);

  // TV remotes navigate by focus — give them somewhere to start.
  useEffect(() => {
    syncButtonRef.current?.focus();
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-6 text-slate-100">
      <div className="text-center">
        <h1 className="text-2xl font-semibold sm:text-3xl">Community IPTV Player</h1>
        <p className="mt-2 text-sm text-slate-400 sm:text-base">
          You are connected to another device&rsquo;s player. How do you want to use it?
        </p>
      </div>
      <div className="grid w-full max-w-3xl gap-4 sm:grid-cols-2">
        <button
          ref={syncButtonRef}
          type="button"
          onClick={() => onChoose("sync")}
          className="group flex flex-col items-center gap-3 rounded-2xl border border-cyan-400/40 bg-slate-900/80 p-8 text-center transition hover:border-cyan-300 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          <MonitorPlay className="h-10 w-10 text-cyan-300" aria-hidden />
          <span className="text-lg font-semibold">Sync to master</span>
          <span className="text-sm text-slate-400">
            Play whatever the main device plays. Episodes move forward automatically, and anything
            watched here is marked watched there too.
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose("regular")}
          className="group flex flex-col items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 p-8 text-center transition hover:border-slate-500 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          <Compass className="h-10 w-10 text-slate-300" aria-hidden />
          <span className="text-lg font-semibold">Browse on this device</span>
          <span className="text-sm text-slate-400">
            Use the app normally — pick your own shows and channels, independent of the main device.
          </span>
        </button>
      </div>
      <p className="text-xs text-slate-500">You can choose again the next time this device connects.</p>
    </div>
  );
};
