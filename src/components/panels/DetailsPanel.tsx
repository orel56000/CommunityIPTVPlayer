import { useEffect, useState } from "react";
import { Check, Copy, ListVideo, Tv2 } from "lucide-react";
import type { PlaylistItem } from "../../types/models";
import { formatDuration } from "../../utils/time";
import { getShareId } from "../../utils/shareId";

interface DetailsPanelProps {
  item: PlaylistItem | null;
  resumeAt: number;
  /** Full page URL for this episode (playlist name + stream-based ID). */
  episodePageUrl?: string | null;
  /** Jump to this title in the browse UI (series → show; other kinds → correct section). */
  onGoToBrowse?: (item: PlaylistItem) => void;
}

export const DetailsPanel = ({ item, resumeAt, episodePageUrl = null, onGoToBrowse }: DetailsPanelProps) => {
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [streamUrlVisible, setStreamUrlVisible] = useState(false);

  useEffect(() => {
    setStreamUrlVisible(false);
  }, [item?.id]);

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  const copyEpisodeLink = async () => {
    if (!episodePageUrl) return;
    try {
      await navigator.clipboard.writeText(episodePageUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  const shareId = item ? getShareId(item) : "";
  const isSeriesEpisode = Boolean(item && (item.kind === "series_episode" || item.section === "series"));

  return (
    <aside className="panel h-fit space-y-4 p-4 lg:p-5">
      <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Stream details</h3>
      {!item ? <p className="text-sm text-slate-500">Select an item to inspect metadata.</p> : null}
      {item ? (
        <>
          <div>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Title</p>
              {onGoToBrowse ? (
                <button
                  type="button"
                  className="btn shrink-0 py-1 text-[11px]"
                  title={
                    isSeriesEpisode
                      ? "Open series — see all episodes (same as Continue watching)"
                      : "Show in list — jump to this channel or title in the browse view"
                  }
                  aria-label={isSeriesEpisode ? "Open series in browse" : "Go to title in browse"}
                  onClick={() => onGoToBrowse(item)}
                >
                  {isSeriesEpisode ? <Tv2 size={14} /> : <ListVideo size={14} />}
                  {isSeriesEpisode ? "Series" : "List"}
                </button>
              ) : null}
            </div>
            <p className="mt-0.5 text-sm font-medium text-slate-100">{item.title}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Show ID</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-white/[0.06] bg-slate-950/60 px-2.5 py-1.5 text-xs font-mono text-cyan-100/90">
                {shareId}
              </code>
              <button
                type="button"
                className="btn shrink-0"
                title="Copy ID"
                aria-label="Copy Show ID"
                onClick={() => handleCopy(shareId)}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Share this ID — paste it into search to jump straight here.
            </p>
          </div>
          {episodePageUrl ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Episode link</p>
              <p className="mt-1 break-all text-[11px] leading-snug text-slate-500">
                Opens this episode after refresh or when someone opens the link. Uses your playlist name and the same stream URL as anyone else sharing the link.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg border border-white/[0.06] bg-slate-950/60 px-2.5 py-1.5 text-[11px] font-mono text-cyan-100/90">
                  {episodePageUrl}
                </code>
                <button
                  type="button"
                  className="btn shrink-0"
                  title="Copy episode page URL"
                  aria-label="Copy episode page URL"
                  onClick={() => void copyEpisodeLink()}
                >
                  {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                  {copiedLink ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          ) : null}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Category</p>
            <p className="mt-0.5 text-sm text-slate-200">{item.groupTitle ?? "Ungrouped"}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Section</p>
            <p className="mt-0.5 text-sm capitalize text-slate-200">{item.section}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Resume</p>
            <p className="mt-0.5 text-sm tabular-nums text-slate-200">{formatDuration(resumeAt)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Stream URL</p>
            {streamUrlVisible ? (
              <div className="mt-1 space-y-2">
                <p className="break-all text-xs leading-relaxed text-slate-400">{item.streamUrl}</p>
                <button
                  type="button"
                  className="btn border-slate-600/80 bg-slate-800/80 py-1.5 text-[11px] text-slate-200"
                  onClick={() => setStreamUrlVisible(false)}
                >
                  Hide URL
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn mt-1 w-full border-slate-600/80 bg-slate-900/80 py-2 text-xs text-slate-300"
                aria-expanded="false"
                onClick={() => setStreamUrlVisible(true)}
              >
                Show stream URL
              </button>
            )}
            <p className="mt-1 text-[11px] text-slate-500">Hidden until you choose to reveal it.</p>
          </div>
        </>
      ) : null}
    </aside>
  );
};
