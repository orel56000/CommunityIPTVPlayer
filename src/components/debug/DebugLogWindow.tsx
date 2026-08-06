import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { getRelayBase } from "../../utils/secureUrl";

interface DebugLogEntry {
  id: number;
  ts_ms: number;
  source: "frontend" | "relay";
  method: string;
  url: string;
  status: number | null;
  duration_ms: number | null;
  error: string | null;
}

const POLL_MS = 1000;

const formatTime = (tsMs: number): string => {
  const d = new Date(tsMs);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const statusColor = (entry: DebugLogEntry): string => {
  if (entry.error || !entry.status) return "text-red-400";
  if (entry.status >= 500) return "text-red-400";
  if (entry.status >= 400) return "text-amber-400";
  return "text-emerald-400";
};

/**
 * A standalone window (see `open_debug_window` in lib.rs) that polls the
 * relay's debug log ring buffer and shows it live — every fetch the frontend
 * makes, plus what the relay itself fetches from the IPTV provider.
 */
export const DebugLogWindow = () => {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const lastIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${getRelayBase()}/api/debug/log?since=${lastIdRef.current}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const fresh = (await res.json()) as DebugLogEntry[];
        if (!fresh.length || cancelled) return;
        lastIdRef.current = fresh[fresh.length - 1].id;
        setEntries((prev) => [...prev, ...fresh].slice(-1000));
      } catch {
        // Best-effort — the relay may be momentarily unreachable; next tick retries.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [paused]);

  useEffect(() => {
    if (!stickToBottomRef.current || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [entries]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const handleClear = () => {
    void fetch(`${getRelayBase()}/api/debug/log`, { method: "DELETE" }).catch(() => undefined);
    setEntries([]);
  };

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          Debug Log
          <span className="text-xs font-normal text-slate-500">{entries.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume polling" : "Pause polling"}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="btn px-2 py-1 text-xs" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>
      <div ref={listRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-xs">
        {entries.length === 0 ? (
          <p className="p-3 text-slate-500">Waiting for requests…</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-baseline gap-2 border-b border-slate-900 py-1 leading-snug last:border-0"
            >
              <span className="shrink-0 text-slate-500">{formatTime(entry.ts_ms)}</span>
              <span
                className={clsx(
                  "shrink-0 rounded px-1 text-[10px] font-semibold uppercase",
                  entry.source === "relay" ? "bg-cyan-500/20 text-cyan-300" : "bg-violet-500/20 text-violet-300",
                )}
              >
                {entry.source}
              </span>
              <span className="shrink-0 text-slate-400">{entry.method}</span>
              <span className={clsx("shrink-0 w-10", statusColor(entry))}>{entry.status ?? (entry.error ? "ERR" : "—")}</span>
              <span className="min-w-0 flex-1 truncate text-slate-200" title={entry.url}>
                {entry.url}
              </span>
              {entry.duration_ms != null ? (
                <span className="shrink-0 text-slate-500">{Math.round(entry.duration_ms)}ms</span>
              ) : null}
              {entry.error ? <span className="shrink-0 truncate text-red-400" title={entry.error}>{entry.error}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
