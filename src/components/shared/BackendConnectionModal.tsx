import { useMemo, useState } from "react";
import { Check, Copy, Download, MonitorDown, Server, Unplug, X } from "lucide-react";
import type { BackendConnectionState } from "../../hooks/useBackendConnection";
import { RELAY_ORIGIN, normalizeBackendOrigin } from "../../utils/relayDiscovery";

const RELEASES_URL = "https://github.com/orel56000/CommunityIPTVPlayer/releases";

interface BackendConnectionModalProps {
  open: boolean;
  connection: BackendConnectionState & {
    connected: boolean;
    connect: (origin: string) => Promise<string>;
    useSelf: () => void;
    disconnect: () => void;
  };
  onClose: () => void;
}

const copyText = async (value: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

const statusText = (connected: boolean, relayBase: string): string => {
  if (!connected) return "No backend connected";
  if (!relayBase) return "Using this app";
  return `Using ${relayBase}`;
};

export const BackendConnectionModal = ({ open, connection, onClose }: BackendConnectionModalProps) => {
  const [input, setInput] = useState(connection.savedBackendOrigin || RELAY_ORIGIN);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const origins = useMemo(() => {
    const fromInfo = connection.serverInfo?.origins?.filter(Boolean) ?? [];
    const currentOrigin = typeof window !== "undefined" ? window.location.origin : "";
    const all = connection.canServe ? [currentOrigin, ...fromInfo] : fromInfo;
    return Array.from(new Set(all.filter((value) => /^https?:\/\//i.test(value))));
  }, [connection.canServe, connection.serverInfo?.origins]);

  if (!open) return null;

  const connect = async (raw: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const origin = await connection.connect(raw);
      setInput(origin);
      setMessage("Connected. Playback will use this backend.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect to that backend.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    const ok = await copyText(value);
    if (!ok) {
      setMessage("Could not copy automatically. Select the address and copy it manually.");
      return;
    }
    setCopied(value);
    window.setTimeout(() => setCopied((current) => (current === value ? null : current)), 1800);
  };

  const normalizedPreview = (() => {
    try {
      return normalizeBackendOrigin(input);
    } catch {
      return input.trim();
    }
  })();

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-950/75 p-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-md sm:p-6 sm:pt-16">
      <div className="panel w-full max-w-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Server size={18} className="text-cyan-300" aria-hidden />
              <h2 className="text-base font-semibold text-slate-100">Backend connection</h2>
            </div>
            <p className="mt-1 text-xs text-slate-400">{statusText(connection.connected, connection.relayBase)}</p>
          </div>
          <button type="button" className="control-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 sm:px-5">
          {connection.canServe ? (
            <section className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] p-3.5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-cyan-100">This native app can be the server</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-300">
                    Keep this app open and use one of these addresses in a browser on this device or on the same network.
                  </p>
                </div>
                <button type="button" className="btn btn-primary shrink-0 px-3 py-2 text-sm" onClick={connection.useSelf}>
                  <Check size={15} aria-hidden />
                  Use this app
                </button>
              </div>
              {origins.length ? (
                <div className="mt-3 space-y-2">
                  {origins.map((origin) => (
                    <div
                      key={origin}
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-slate-950/35 px-2.5 py-2"
                    >
                      <code className="min-w-0 flex-1 truncate text-xs text-slate-200">{origin}</code>
                      <button
                        type="button"
                        className="control-btn shrink-0"
                        onClick={() => void copy(origin)}
                        aria-label={`Copy ${origin}`}
                        title="Copy address"
                      >
                        {copied === origin ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : (
            <section className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3.5">
              <div className="flex gap-3">
                <MonitorDown className="mt-0.5 shrink-0 text-amber-300" size={20} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-100">This browser needs a native backend</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-300">
                    Browsers cannot reliably fetch IPTV streams by themselves. The native app runs a small local server that{" "}
                    fetches from your home IP and handles live streams, then this browser connects to it.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a className="btn btn-primary px-3 py-2 text-sm" href={RELEASES_URL} target="_blank" rel="noreferrer">
                      <Download size={15} aria-hidden />
                      Get native app
                    </a>
                    <button type="button" className="btn px-3 py-2 text-sm" onClick={() => void connect(RELAY_ORIGIN)}>
                      Try this PC
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-3.5">
            <label className="text-sm font-semibold text-slate-100" htmlFor="backend-origin">
              Connect to another backend
            </label>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Paste the server address from the native app, for example <span className="text-slate-300">192.168.1.23:11471</span>.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                id="backend-origin"
                className="input min-w-0 flex-1"
                value={input}
                placeholder="http://192.168.1.23:11471"
                onChange={(event) => setInput(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary justify-center px-4 py-2 text-sm"
                onClick={() => void connect(input)}
                disabled={busy || !input.trim()}
              >
                Connect
              </button>
            </div>
            {normalizedPreview ? (
              <button
                type="button"
                className="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
                onClick={() => void copy(normalizedPreview)}
              >
                {copied === normalizedPreview ? <Check size={13} /> : <Copy size={13} />}
                <span className="truncate">{normalizedPreview}</span>
              </button>
            ) : null}
          </section>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-h-5 text-xs text-slate-400" role="status">
              {message}
            </div>
            <button type="button" className="btn px-3 py-2 text-sm" onClick={connection.disconnect}>
              <Unplug size={15} aria-hidden />
              Disconnect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
