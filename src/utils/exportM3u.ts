import type { PlaylistItem } from "../types/models";

const quote = (value: string): string => `"${value.replace(/"/g, "&quot;")}"`;

const pushAttr = (parts: string[], key: string, value?: string): void => {
  const trimmed = value?.trim();
  if (!trimmed) return;
  parts.push(`${key}=${quote(trimmed)}`);
};

const extinfLine = (item: PlaylistItem): string => {
  const attrs: string[] = [];
  pushAttr(attrs, "tvg-id", item.tvgId);
  pushAttr(attrs, "tvg-name", item.tvgName ?? item.title);
  pushAttr(attrs, "tvg-logo", item.logo);
  pushAttr(attrs, "tvg-chno", item.tvgChno);
  pushAttr(attrs, "group-title", item.groupTitle);
  pushAttr(attrs, "catchup", item.catchup);
  pushAttr(attrs, "catchup-days", item.catchupDays);
  pushAttr(attrs, "catchup-source", item.catchupSource);
  pushAttr(attrs, "xui-id", item.xuiId);

  const duration = item.duration != null && Number.isFinite(item.duration) ? Math.round(item.duration) : -1;
  return `#EXTINF:${duration}${attrs.length ? ` ${attrs.join(" ")}` : ""},${item.title}`;
};

const isPlayableItem = (item: PlaylistItem): boolean => item.kind !== "series" && Boolean(item.streamUrl?.trim() || item.url?.trim());

export const serializePlaylistItemsToM3u = (items: PlaylistItem[]): string => {
  const lines = ["#EXTM3U"];
  for (const item of items) {
    if (!isPlayableItem(item)) continue;
    lines.push(extinfLine(item));
    lines.push(item.streamUrl || item.url);
  }
  return `${lines.join("\n")}\n`;
};

