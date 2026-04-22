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
  const [sourceType, setSourceType] = useState<PlaylistSource["type"]>("url");
  const [url, setUrl] = useState("");
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
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
        <div className="flex gap-2">
          <button className={`btn ${sourceType === "url" ? "btn-primary" : ""}`} onClick={() => setSourceType("url")} type="button">
            URL
          </button>
          <button className={`btn ${sourceType === "raw" ? "btn-primary" : ""}`} onClick={() => setSourceType("raw")} type="button">
            Raw M3U
          </button>
          <button className={`btn ${sourceType === "file" ? "btn-primary" : ""}`} onClick={() => setSourceType("file")} type="button">
            File
          </button>
        </div>
        {sourceType === "url" ? (
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/playlist.m3u" />
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
