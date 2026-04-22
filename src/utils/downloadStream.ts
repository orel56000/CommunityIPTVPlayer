/**
 * Save a media file locally. Prefers `fetch()` so the browser may reuse its
 * HTTP cache (same URL you just played) instead of hitting the network again
 * when Cache-Control allows it. We cannot read raw bytes back out of an
 * arbitrary `<video>` buffer (especially HLS); blob: `src` is the exception.
 */

const INVALID_FILE_CHARS = /[/\\?%*:|"<>]/g;

export const sanitizeDownloadFilename = (title: string): string =>
  title.replace(INVALID_FILE_CHARS, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "video";

const extensionFromUrl = (url: string): string => {
  const path = url.split("?")[0]?.split("#")[0] ?? url;
  const match = path.match(/\.(m3u8|mp4|mkv|avi|webm|ts|mov|m4v|mpg|mpeg)(\?|$)/i);
  if (match) return `.${match[1].toLowerCase()}`;
  if (/\.m3u8/i.test(url)) return ".m3u8";
  return ".mp4";
};

const triggerBlobDownload = (blob: Blob, filename: string): void => {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
};

export interface DownloadMediaInput {
  streamUrl: string;
  title: string;
  /** Current `<video>` element — used when `src` is a `blob:` URL (no re-fetch). */
  video: HTMLVideoElement | null;
}

export type DownloadMediaResult = { ok: true } | { ok: false; message: string };

/**
 * Download stream. Uses `fetch(url, { cache: "default" })` so previously cached
 * responses may be reused. If `video.src` is `blob:`, fetches that object URL
 * (reads from memory, not the network).
 */
export const downloadMediaFile = async (input: DownloadMediaInput): Promise<DownloadMediaResult> => {
  const { streamUrl, title, video } = input;
  const base = sanitizeDownloadFilename(title);
  const ext = extensionFromUrl(streamUrl);
  const filename = base.endsWith(ext) ? base : `${base}${ext}`;

  const videoSrc = video?.currentSrc || video?.src || "";
  if (videoSrc.startsWith("blob:")) {
    try {
      const response = await fetch(videoSrc);
      const blob = await response.blob();
      if (!blob.size) return { ok: false, message: "Nothing to save from this stream." };
      triggerBlobDownload(blob, filename);
      return { ok: true };
    } catch {
      return { ok: false, message: "Could not read the in-memory stream for download." };
    }
  }

  try {
    const response = await fetch(streamUrl, {
      mode: "cors",
      credentials: "omit",
      cache: "default",
      referrerPolicy: "no-referrer-when-downgrade",
    });
    if (!response.ok) {
      return { ok: false, message: `Download failed (${response.status}). The server may require a different client.` };
    }
    const blob = await response.blob();
    if (!blob.size) {
      return { ok: false, message: "The server returned an empty file." };
    }
    triggerBlobDownload(blob, filename);
    return { ok: true };
  } catch {
    return {
      ok: false,
      message:
        "Could not save this stream (often cross-origin / CORS). Copy the URL from Stream details and use a desktop download manager, or open the link in a new tab and save from there.",
    };
  }
};

export const isHlsUrl = (url: string): boolean => /\.m3u8(\?|$)/i.test(url) || url.toLowerCase().includes(".m3u8");
