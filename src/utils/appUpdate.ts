/**
 * Release-channel auto-update check. Only used by customer (release) builds — the
 * relay reports `debug: true` for our dev builds, and the caller skips the check
 * there. Queries the GitHub Releases API for the latest tag and, if it is newer
 * than the running version, returns where to get it.
 */
const REPO = "orel56000/CommunityIPTVPlayer";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  /** Direct download URL of the Android APK asset (null if none on the release). */
  apkUrl: string | null;
  apkName: string | null;
}

/** Parse "v1.2.3" / "1.2.3" into numeric parts. */
const parseVersion = (value: string): number[] =>
  value
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .map((part) => parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

/** True if `a` is strictly newer than `b` (semver-ish, numeric compare). */
export const isNewerVersion = (a: string, b: string): boolean => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
};

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/** Returns update info if GitHub has a newer release than `currentVersion`, else null. */
export const checkForUpdate = async (currentVersion: string): Promise<UpdateInfo | null> => {
  if (!currentVersion) return null;
  let data: GithubRelease;
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    data = (await res.json()) as GithubRelease;
  } catch {
    return null; // offline / rate-limited / blocked — never surface an error for this
  }

  const latestVersion = (data.tag_name ?? "").replace(/^v/i, "");
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return null;

  const assets = Array.isArray(data.assets) ? data.assets : [];
  const apk =
    assets.find((a) => /android.*arm64.*\.apk$/i.test(a.name ?? "")) ??
    assets.find((a) => (a.name ?? "").toLowerCase().endsWith(".apk"));

  return {
    currentVersion,
    latestVersion,
    releaseUrl: data.html_url ?? RELEASES_PAGE,
    apkUrl: apk?.browser_download_url ?? null,
    apkName: apk?.name ?? null,
  };
};
