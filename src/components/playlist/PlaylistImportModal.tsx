import { useRef, useState } from "react";
import type { PlaylistSource } from "../../types/models";

interface PlaylistImportModalProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  progress: number;
  progressLabel: string | null;
  onClose: () => void;
  onSubmit: (name: string, source: PlaylistSource, rawText?: string) => Promise<void>;
}

export const PlaylistImportModal = ({
  open,
  loading,
  error,
  progress,
  progressLabel,
  onClose,
  onSubmit,
}: PlaylistImportModalProps) => {
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<PlaylistSource["type"]>("xtream");
  const [url, setUrl] = useState("");
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [xtreamHost, setXtreamHost] = useState("");
  const [xtreamUsername, setXtreamUsername] = useState("");
  const [xtreamPassword, setXtreamPassword] = useState("");
  const [xtreamOutput, setXtreamOutput] = useState<"ts" | "m3u8">("ts");
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setFileText(await file.text());
    setSourceType("file");
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) await handleFile(file);
  };

  const submit = async () => {
    const trimmedName = name.trim() || "My Playlist";
    if (sourceType === "url") {
      await onSubmit(trimmedName, { type: "url", value: url.trim() });
      return;
    }
    if (sourceType === "raw") {
      await onSubmit(trimmedName, { type: "raw", value: "inline" }, rawText);
      return;
    }
    if (sourceType === "xtream") {
      await onSubmit(trimmedName, {
        type: "xtream",
        value: xtreamHost.trim(),
        xtream: {
          host: xtreamHost.trim().replace(/\/+$/, ""),
          username: xtreamUsername.trim(),
          password: xtreamPassword,
          output: xtreamOutput,
        },
      });
      return;
    }
    await onSubmit(trimmedName, { type: "file", value: fileName || "playlist.m3u", originalName: fileName }, fileText);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4">
      <div className="panel w-full max-w-2xl space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Import Playlist</h2>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Playlist name" />
        <div className="flex flex-wrap gap-2">
          <button className={`btn ${sourceType === "xtream" ? "btn-primary" : ""}`} onClick={() => setSourceType("xtream")} type="button">
            Xtream Recommended
          </button>
          <button className={`btn ${sourceType === "raw" ? "btn-primary" : ""}`} onClick={() => setSourceType("raw")} type="button">
            Raw M3U
          </button>
          <button className={`btn ${sourceType === "file" ? "btn-primary" : ""}`} onClick={() => setSourceType("file")} type="button">
            File
          </button>
          <button className={`btn ${sourceType === "url" ? "btn-primary" : ""}`} onClick={() => setSourceType("url")} type="button">
            URL
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Xtream is recommended when your provider gives you `player_api.php` credentials because it imports faster and keeps series details lazy-loaded.
        </p>
        {sourceType === "url" ? (
          <div className="space-y-2">
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/playlist.m3u or .../player_api.php?username=...&password=..."
            />
            <p className="text-xs text-slate-500">`player_api.php` URLs are auto-detected and imported with the richer Xtream API flow.</p>
          </div>
        ) : null}
        {sourceType === "raw" ? (
          <textarea
            className="input min-h-[220px]"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="#EXTM3U..."
          />
        ) : null}
        {sourceType === "file" ? (
          <div
            className="rounded-lg border border-dashed border-slate-600 bg-slate-900/60 p-4 text-sm text-slate-300"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            <p>Drag and drop an M3U file here, or use the file picker.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn" type="button" onClick={() => fileInputRef.current?.click()}>
                Choose file
              </button>
              {fileName ? <span className="text-xs text-slate-400">{fileName}</span> : null}
            </div>
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".m3u,.m3u8,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await handleFile(file);
              }}
            />
          </div>
        ) : null}
        {sourceType === "xtream" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Host</span>
              <input
                className="input"
                value={xtreamHost}
                onChange={(e) => setXtreamHost(e.target.value)}
                placeholder="https://provider.example:8080"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Username</span>
              <input className="input" value={xtreamUsername} onChange={(e) => setXtreamUsername(e.target.value)} placeholder="username" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Password</span>
              <input
                className="input"
                type="password"
                value={xtreamPassword}
                onChange={(e) => setXtreamPassword(e.target.value)}
                placeholder="password"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Live output</span>
              <select
                className="input"
                value={xtreamOutput}
                onChange={(e) => setXtreamOutput(e.target.value === "m3u8" ? "m3u8" : "ts")}
              >
                <option value="ts">MPEG-TS (.ts) — recommended for live TV</option>
                <option value="m3u8">HLS (.m3u8)</option>
              </select>
            </label>
            <p className="md:col-span-2 text-xs text-slate-500">
              Uses `player_api.php` for categories, live channels, VOD, series, catch-up flags, and artwork. Native IPTV apps (Vu Player, TiviMate, IPTV Smarters) use MPEG-TS for live streams by default.
            </p>
          </div>
        ) : null}
        {error ? <p className="text-sm text-rose-300">{error}</p> : null}
        {loading ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{progressLabel ?? "Importing..."}</span>
              <span>{Math.max(0, Math.min(100, progress))}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-cyan-400 transition-[width] duration-200"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="button" onClick={submit} disabled={loading}>
            {loading ? "Importing..." : "Import playlist"}
          </button>
        </div>
      </div>
    </div>
  );
};
