import type { ImportResult, PlaylistItem, XtreamSourceConfig } from "../types/models";
import { cleanAssetUrl, toRelayUrl } from "./secureUrl";
import { computeShareIdFromUrl } from "./shareId";

interface XtreamCategory {
  category_id?: string | number;
  category_name?: string;
}

interface XtreamLiveStream {
  stream_id?: string | number;
  name?: string;
  category_id?: string | number;
  stream_icon?: string;
  epg_channel_id?: string;
  tv_archive?: string | number;
  tv_archive_duration?: string | number;
  added?: string;
  [key: string]: unknown;
}

interface XtreamVodStream {
  stream_id?: string | number;
  name?: string;
  category_id?: string | number;
  stream_icon?: string;
  duration?: string | number;
  duration_secs?: string | number;
  rating?: string | number;
  plot?: string;
  genre?: string;
  cast?: string;
  director?: string;
  year?: string | number;
  releaseDate?: string;
  container_extension?: string;
  added?: string;
  [key: string]: unknown;
}

interface XtreamSeries {
  series_id?: string | number;
  name?: string;
  category_id?: string | number;
  cover?: string;
  plot?: string;
  genre?: string;
  cast?: string;
  director?: string;
  releaseDate?: string;
  rating?: string | number;
  last_modified?: string;
  [key: string]: unknown;
}

interface XtreamSeriesEpisode {
  id?: string | number;
  season?: string | number;
  title?: string;
  episode_num?: string | number;
  container_extension?: string;
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

interface XtreamSeriesInfo {
  info?: Record<string, unknown>;
  episodes?: Record<string, XtreamSeriesEpisode[] | unknown> | XtreamSeriesEpisode[];
  [key: string]: unknown;
}

interface XtreamImportOptions {
  onProgress?: (value: number) => void;
  onStatus?: (label: string) => void;
}

interface XtreamSeriesCatalogEntry {
  id: string;
  title: string;
  groupTitle: string;
  logo?: string;
  backdrop?: string;
  description?: string;
  rating?: string;
  releaseDate?: string;
  metadata: Record<string, string>;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");
const toText = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());
const nonEmpty = (value: unknown): string | undefined => {
  const text = toText(value);
  return text.length > 0 ? text : undefined;
};

const toStringRecord = (input: Record<string, unknown>, omit: string[] = []): Record<string, string> => {
  const omitSet = new Set(omit);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (omitSet.has(key) || raw == null) continue;
    if (typeof raw === "object") {
      try {
        out[key] = JSON.stringify(raw);
      } catch {
        continue;
      }
      continue;
    }
    const value = toText(raw);
    if (value) out[key] = value;
  }
  return out;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  // Go through the relay proxy (api/stream) instead of hitting the provider
  // directly. A cross-origin fetch to the Xtream host is blocked by the WebView
  // ("Load failed") because providers send no Access-Control-Allow-Origin; the
  // relay fetches it server-side (from the user's home IP) and adds CORS.
  let response: Response;
  try {
    response = await fetch(toRelayUrl(url), {
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the Xtream provider (${reason}). Check the host and your internet connection.`,
    );
  }
  if (!response.ok) {
    const message = (await response.text().catch(() => "")).slice(0, 180);
    throw new Error(message ? `Xtream request failed (${response.status}): ${message}` : `Xtream request failed (${response.status})`);
  }
  return (await response.json()) as T;
};

const buildPlayerApiUrl = (config: XtreamSourceConfig, action?: string, extra?: Record<string, string | number>): string => {
  const url = new URL(`${trimTrailingSlash(config.host)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  if (action) url.searchParams.set("action", action);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
};

const buildLiveStreamUrl = (config: XtreamSourceConfig, streamId: string): string =>
  `${trimTrailingSlash(config.host)}/live/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(streamId)}.${config.output === "m3u8" ? "m3u8" : "ts"}`;

const resolveXtreamLiveOutput = (
  preferred: XtreamSourceConfig["output"],
  allowedFormats?: string[],
): NonNullable<XtreamSourceConfig["output"]> => {
  const choice = preferred ?? "ts";
  if (!allowedFormats?.length) return choice;
  const normalized = allowedFormats.map((format) => format.toLowerCase());
  if (normalized.includes(choice)) return choice;
  if (normalized.includes("ts")) return "ts";
  if (normalized.includes("m3u8") || normalized.includes("hls")) return "m3u8";
  return choice;
};

const buildMovieStreamUrl = (config: XtreamSourceConfig, streamId: string, extension?: string): string => {
  const container = nonEmpty(extension) ?? "mp4";
  return `${trimTrailingSlash(config.host)}/movie/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(streamId)}.${container}`;
};

const buildEpisodeStreamUrl = (config: XtreamSourceConfig, episodeId: string, extension?: string): string => {
  const container = nonEmpty(extension) ?? "mp4";
  return `${trimTrailingSlash(config.host)}/series/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(episodeId)}.${container}`;
};

const makeItemId = (...parts: Array<string | number | undefined>): string => parts.filter((value) => value != null && `${value}` !== "").join("::");

const categoryMap = (categories: XtreamCategory[]): Map<string, string> =>
  new Map(
    categories
      .map((category) => [toText(category.category_id), nonEmpty(category.category_name) ?? "Ungrouped"] as const)
      .filter(([id]) => id.length > 0),
  );

const pickBackdrop = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return cleanAssetUrl(value.map((entry) => nonEmpty(entry)).find(Boolean) ?? undefined);
  }
  return cleanAssetUrl(nonEmpty(value));
};

const parseDuration = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const text = toText(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    return Number.isFinite(num) ? num : null;
  }
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
};

const extractEpisodes = (payload: XtreamSeriesInfo["episodes"]): Array<{ season: number; episode: XtreamSeriesEpisode }> => {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map((episode, index) => ({ season: Number((episode as XtreamSeriesEpisode).season ?? 1) || 1, episode: episode as XtreamSeriesEpisode, index }));
  }

  const out: Array<{ season: number; episode: XtreamSeriesEpisode }> = [];
  for (const [seasonKey, value] of Object.entries(payload)) {
    if (!Array.isArray(value)) continue;
    const season = Number(seasonKey) || 1;
    for (const episode of value) {
      out.push({ season, episode: episode as XtreamSeriesEpisode });
    }
  }
  return out;
};

const seriesEpisodeTitle = (episode: XtreamSeriesEpisode, fallbackIndex: number): string =>
  nonEmpty(episode.title) ?? `Episode ${nonEmpty(episode.episode_num) ?? String(fallbackIndex + 1)}`;

const buildSeriesCatalogEntry = (
  series: XtreamSeries,
  categoryName: string,
): XtreamSeriesCatalogEntry | null => {
  const seriesId = nonEmpty(series.series_id);
  const title = nonEmpty(series.name);
  if (!seriesId || !title) return null;
  return {
    id: seriesId,
    title,
    groupTitle: categoryName,
    logo: cleanAssetUrl(nonEmpty(series.cover)),
    backdrop: undefined,
    description: nonEmpty(series.plot),
    rating: nonEmpty(series.rating),
    releaseDate: nonEmpty(series.releaseDate),
    metadata: {
      ...toStringRecord(series, ["name", "cover", "plot", "rating", "releaseDate"]),
      series_id: seriesId,
    },
  };
};

const mapSeriesEpisodes = (
  playlistId: string,
  config: XtreamSourceConfig,
  catalog: XtreamSeriesCatalogEntry,
  details: XtreamSeriesInfo,
): PlaylistItem[] => {
  const info = details.info ?? {};
  const episodes = extractEpisodes(details.episodes);
  const seriesBackdrop = pickBackdrop(info.backdrop_path) ?? catalog.backdrop;
  const seriesDescription = nonEmpty(info.plot) ?? catalog.description;
  const rating = nonEmpty(info.rating) ?? catalog.rating;
  const releaseDate = nonEmpty(info.releaseDate) ?? catalog.releaseDate;
  const seriesLogo = cleanAssetUrl(nonEmpty(info.cover)) ?? catalog.logo;

  return episodes
    .map(({ season, episode }, episodeIndex) => {
      const episodeId = nonEmpty(episode.id);
      if (!episodeId) return null;
      const episodeInfo = (episode.info ?? {}) as Record<string, unknown>;
      const title = seriesEpisodeTitle(episode, episodeIndex);
      const episodeNumber = Number(episode.episode_num) || episodeIndex + 1;
      const streamUrl = buildEpisodeStreamUrl(
        config,
        episodeId,
        nonEmpty(episode.container_extension) ?? nonEmpty(episodeInfo.container_extension),
      );

      return {
        id: makeItemId(playlistId, "series-episode", catalog.id, episodeId),
        sourceId: episodeId,
        playlistId,
        title,
        displayName: title,
        logo: cleanAssetUrl(nonEmpty(episodeInfo.movie_image)) ?? seriesLogo,
        backdrop: pickBackdrop(episodeInfo.backdrop_path) ?? seriesBackdrop,
        description: nonEmpty(episodeInfo.plot) ?? seriesDescription,
        rating,
        releaseDate,
        groupTitle: catalog.groupTitle,
        url: streamUrl,
        streamUrl,
        kind: "series_episode",
        section: "series",
        duration: parseDuration(episodeInfo.duration_secs ?? episodeInfo.duration),
        seriesTitle: catalog.title,
        parentSeriesId: catalog.id,
        season,
        episode: episodeNumber,
        episodeTitle: title,
        tvgName: title,
        metadata: {
          ...catalog.metadata,
          ...toStringRecord(episodeInfo),
        },
        rawAttributes: {},
        xuiId: episodeId,
      } satisfies PlaylistItem;
    })
    .filter(Boolean) as PlaylistItem[];
};

export const xtreamSourceFromUrl = (value: string): XtreamSourceConfig | null => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  const username = nonEmpty(parsed.searchParams.get("username"));
  const password = nonEmpty(parsed.searchParams.get("password"));
  if (!username || !password) return null;
  if (!/\/player_api\.php$/i.test(parsed.pathname)) return null;

  const pathnameBase = parsed.pathname.replace(/\/player_api\.php$/i, "");
  const host = trimTrailingSlash(`${parsed.origin}${pathnameBase}`);
  const output = parsed.searchParams.get("output")?.toLowerCase() === "m3u8" ? "m3u8" : "ts";
  return { host, username, password, output };
};

export const importXtreamPlaylist = async (
  playlistId: string,
  config: XtreamSourceConfig,
  options: XtreamImportOptions = {},
): Promise<ImportResult> => {
  const { onProgress, onStatus } = options;
  const setProgress = (value: number) => onProgress?.(Math.max(0, Math.min(100, Math.round(value))));
  const errors: string[] = [];

  onStatus?.("Checking Xtream account...");
  setProgress(2);
  const account = await fetchJson<{
    user_info?: { auth?: number | string; status?: string; allowed_output_formats?: string[] };
  }>(buildPlayerApiUrl(config));
  if (String(account.user_info?.auth ?? "0") !== "1") {
    throw new Error("Xtream credentials were rejected by the provider.");
  }
  if (nonEmpty(account.user_info?.status) && account.user_info?.status !== "Active") {
    errors.push(`Account status is ${account.user_info?.status}. Some streams may fail.`);
  }
  const resolvedConfig: XtreamSourceConfig = {
    ...config,
    output: resolveXtreamLiveOutput(config.output, account.user_info?.allowed_output_formats),
  };

  onStatus?.("Loading live TV catalog...");
  const [liveCategories, liveStreams] = await Promise.all([
    fetchJson<XtreamCategory[]>(buildPlayerApiUrl(config, "get_live_categories")),
    fetchJson<XtreamLiveStream[]>(buildPlayerApiUrl(config, "get_live_streams")),
  ]);
  setProgress(20);

  onStatus?.("Loading movies catalog...");
  const [vodCategories, vodStreams] = await Promise.all([
    fetchJson<XtreamCategory[]>(buildPlayerApiUrl(config, "get_vod_categories")),
    fetchJson<XtreamVodStream[]>(buildPlayerApiUrl(config, "get_vod_streams")),
  ]);
  setProgress(38);

  onStatus?.("Loading series catalog...");
  const [seriesCategories, seriesList] = await Promise.all([
    fetchJson<XtreamCategory[]>(buildPlayerApiUrl(config, "get_series_categories")),
    fetchJson<XtreamSeries[]>(buildPlayerApiUrl(config, "get_series")),
  ]);
  setProgress(52);

  const liveCategoryById = categoryMap(liveCategories);
  const vodCategoryById = categoryMap(vodCategories);
  const seriesCategoryById = categoryMap(seriesCategories);

  const items: PlaylistItem[] = [];

  for (const stream of liveStreams) {
    const streamId = nonEmpty(stream.stream_id);
    const title = nonEmpty(stream.name);
    if (!streamId || !title) continue;
    const groupTitle = liveCategoryById.get(toText(stream.category_id)) ?? "Ungrouped";
    const archiveDays = nonEmpty(stream.tv_archive_duration);
    const logo = cleanAssetUrl(nonEmpty(stream.stream_icon));
    const streamUrl = buildLiveStreamUrl(resolvedConfig, streamId);
    const metadata = toStringRecord(stream, ["name", "stream_icon", "category_id"]);
    const baseItem: PlaylistItem = {
      id: makeItemId(playlistId, "live", streamId),
      sourceId: streamId,
      playlistId,
      title,
      displayName: title,
      logo,
      groupTitle,
      url: streamUrl,
      streamUrl,
      kind: "live",
      section: "live",
      duration: null,
      tvgId: nonEmpty(stream.epg_channel_id),
      tvgName: title,
      metadata,
      rawAttributes: {},
      epgChannelId: nonEmpty(stream.epg_channel_id),
      catchup: String(stream.tv_archive ?? "0"),
      catchupDays: archiveDays,
      xuiId: streamId,
      shareId: computeShareIdFromUrl(streamUrl),
    } as PlaylistItem;
    items.push(baseItem);
    if (String(stream.tv_archive ?? "0") === "1") {
      items.push({
        ...baseItem,
        id: makeItemId(playlistId, "catchup", streamId),
        section: "catchup",
        metadata: { ...metadata, archive_mode: "supported" },
      });
    }
  }

  for (const stream of vodStreams) {
    const streamId = nonEmpty(stream.stream_id);
    const title = nonEmpty(stream.name);
    if (!streamId || !title) continue;
    const streamUrl = buildMovieStreamUrl(config, streamId, nonEmpty(stream.container_extension));
    items.push({
      id: makeItemId(playlistId, "vod", streamId),
      sourceId: streamId,
      playlistId,
      title,
      displayName: title,
      logo: cleanAssetUrl(nonEmpty(stream.stream_icon)),
      groupTitle: vodCategoryById.get(toText(stream.category_id)) ?? "Ungrouped",
      url: streamUrl,
      streamUrl,
      kind: "movie",
      section: "movies",
      duration: parseDuration(stream.duration_secs ?? stream.duration),
      description: nonEmpty(stream.plot),
      rating: nonEmpty(stream.rating),
      releaseDate: nonEmpty(stream.releaseDate ?? stream.year),
      tvgName: title,
      metadata: toStringRecord(stream, ["name", "stream_icon", "category_id", "plot", "rating", "releaseDate", "year"]),
      rawAttributes: {},
      xuiId: streamId,
      shareId: computeShareIdFromUrl(streamUrl),
    });
  }

  for (const series of seriesList) {
    const categoryName = seriesCategoryById.get(toText(series.category_id)) ?? "Ungrouped";
    const catalog = buildSeriesCatalogEntry(series, categoryName);
    if (!catalog) continue;
    const detailsUrl = buildPlayerApiUrl(config, "get_series_info", { series_id: catalog.id });
    items.push({
      id: makeItemId(playlistId, "series", catalog.id),
      sourceId: catalog.id,
      playlistId,
      title: catalog.title,
      displayName: catalog.title,
      logo: catalog.logo,
      backdrop: catalog.backdrop,
      description: catalog.description,
      rating: catalog.rating,
      releaseDate: catalog.releaseDate,
      groupTitle: catalog.groupTitle,
      url: detailsUrl,
      streamUrl: detailsUrl,
      kind: "series",
      section: "series",
      duration: null,
      tvgName: catalog.title,
      metadata: catalog.metadata,
      rawAttributes: {},
      xuiId: catalog.id,
    });
  }

  onStatus?.("Finalizing playlist...");
  setProgress(100);
  return { items, errors };
};

export const loadXtreamSeriesEpisodes = async (
  playlistId: string,
  config: XtreamSourceConfig,
  seriesItem: PlaylistItem,
): Promise<PlaylistItem[]> => {
  const seriesId = nonEmpty(seriesItem.xuiId) ?? nonEmpty(seriesItem.sourceId) ?? nonEmpty(seriesItem.metadata.series_id);
  if (!seriesId) {
    throw new Error("Series is missing an Xtream series ID.");
  }

  const details = await fetchJson<XtreamSeriesInfo>(buildPlayerApiUrl(config, "get_series_info", { series_id: seriesId }));
  const catalog: XtreamSeriesCatalogEntry = {
    id: seriesId,
    title: seriesItem.title,
    groupTitle: seriesItem.groupTitle ?? "Ungrouped",
    logo: seriesItem.logo,
    backdrop: seriesItem.backdrop,
    description: seriesItem.description,
    rating: seriesItem.rating,
    releaseDate: seriesItem.releaseDate,
    metadata: { ...seriesItem.metadata, series_id: seriesId },
  };
  return mapSeriesEpisodes(playlistId, config, catalog, details);
};
