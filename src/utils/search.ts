import type { PlaylistItem } from "../types/models";
import { getShareId } from "./shareId";

export interface FilterInput {
  query: string;
  group: string;
  favoritesOnly: boolean;
  favoriteItemIds: Set<string>;
}

/**
 * Tiered, name-first IPTV search ranker.
 *
 * Ranking is dominated by a discrete match TIER; a small in-tier refinement
 * (match position, extra words, title length) only breaks ties and can never
 * overturn tier order. Fuzzy/subsequence matching is confined to the short
 * "name" fields (title, tvgName, seriesTitle, episodeTitle); groupTitle and
 * description/metadata are substring-only, last-resort tiers.
 *
 * This replaces the previous approach, which ran loose subsequence matching
 * against one giant concatenated string (title + description + all metadata +
 * ids). Because that text was huge, almost any short query matched almost every
 * item as a subsequence, flooding results and muddying the order. Confining
 * fuzzy matching to name fields and ranking by explicit tiers puts the item the
 * user actually typed at the top.
 */

// Tiers (higher = better). Every name tier ranks above the non-name tiers.
const T_EXACT = 10; // a name field equals the query
const T_WORD = 9; // query equals a whole word in a name field
const T_WORD_PREFIX = 8; // a name-field word starts with the query
const T_SUBSTRING = 7; // query is a contiguous substring of a name field
const T_MULTI_PREFIX = 6; // every query token is a word-prefix within a name field
const T_FUZZY = 5; // bounded fuzzy (subsequence or Levenshtein<=2) in a name field
const T_GROUP = 3; // every token is a substring of groupTitle
const T_META = 1; // every token is a substring of description / metadata / ids

const WORD_SPLIT = /[\s|/\\\-_.:,()[\]]+/;

const normalize = (value: unknown): string =>
  value == null ? "" : String(value).trim().toLowerCase();

interface Word {
  w: string;
  at: number;
}

const splitWords = (text: string): Word[] => {
  const raw = text.split(WORD_SPLIT);
  const out: Word[] = [];
  let pos = 0;
  for (const w of raw) {
    if (!w) continue;
    let idx = text.indexOf(w, pos);
    if (idx < 0) idx = pos;
    out.push({ w, at: idx });
    pos = idx + w.length;
  }
  return out;
};

interface NameField {
  text: string;
  words: Word[];
}

interface ItemSearchData {
  nameFields: NameField[];
  titleLen: number;
  group: string;
  metaBlob: string;
}

/**
 * Per-item cache of the normalized/tokenized searchable text. WeakMap keyed on
 * the item object so the cost is paid once per item (not per keystroke) and the
 * memory is released automatically when the playlist is swapped out.
 */
const searchDataCache = new WeakMap<PlaylistItem, ItemSearchData>();

const buildSearchData = (item: PlaylistItem): ItemSearchData => {
  const cached = searchDataCache.get(item);
  if (cached) return cached;

  const nameTexts = [
    normalize(item.title),
    normalize(item.tvgName),
    normalize(item.seriesTitle),
    normalize(item.episodeTitle),
  ];
  const nameFields = nameTexts.map((text) => ({ text, words: text ? splitWords(text) : [] }));

  const metaParts = [
    normalize(item.description),
    normalize(item.tvgId),
    normalize(item.xuiId),
    normalize(getShareId(item)),
  ];
  const metadata = item.metadata;
  if (metadata) {
    for (const value of Object.values(metadata)) metaParts.push(normalize(value));
  }

  const data: ItemSearchData = {
    nameFields,
    titleLen: nameTexts[0].length,
    group: normalize(item.groupTitle),
    metaBlob: metaParts.join(" "),
  };
  searchDataCache.set(item, data);
  return data;
};

/** token is an in-order subsequence of word (gaps allowed). */
const isSubsequence = (token: string, word: string): boolean => {
  if (token.length > word.length) return false;
  let c = 0;
  for (let i = 0; i < word.length && c < token.length; i += 1) {
    if (word.charCodeAt(i) === token.charCodeAt(c)) c += 1;
  }
  return c === token.length;
};

/** True when the Levenshtein distance between a and b is <= max. */
const withinLevenshtein = (a: string, b: string, max: number): boolean => {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return false;
  if (la === 0) return lb <= max;
  if (lb === 0) return la <= max;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let k = 1; k <= lb; k += 1) {
      const cost = ca === b.charCodeAt(k - 1) ? 0 : 1;
      const del = prev[k] + 1;
      const ins = cur[k - 1] + 1;
      const sub = prev[k - 1] + cost;
      let m = del < ins ? del : ins;
      if (sub < m) m = sub;
      cur[k] = m;
      if (m < rowMin) rowMin = m;
    }
    if (rowMin > max) return false;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb] <= max;
};

interface FieldMatch {
  tier: number;
  at: number;
  extra: number;
}

/** Best match tier for one name field, or null if it doesn't match. */
const evalNameField = (field: NameField, nq: string, tokens: string[]): FieldMatch | null => {
  const { text, words } = field;
  if (!text) return null;
  if (text === nq) return { tier: T_EXACT, at: 0, extra: 0 };

  const extraAll = Math.max(0, words.length - tokens.length);

  if (tokens.length === 1) {
    const tk = tokens[0];
    for (const word of words) {
      if (word.w === tk) return { tier: T_WORD, at: word.at, extra: words.length - 1 };
    }
    for (const word of words) {
      if (word.w.length > tk.length && word.w.startsWith(tk)) {
        return { tier: T_WORD_PREFIX, at: word.at, extra: words.length - 1 };
      }
    }
  }

  const subAt = text.indexOf(nq);
  if (subAt >= 0) return { tier: T_SUBSTRING, at: subAt, extra: extraAll };

  let prefixAt = Infinity;
  let allPrefix = true;
  for (const token of tokens) {
    let hit = false;
    for (const word of words) {
      if (word.w.startsWith(token)) {
        hit = true;
        if (word.at < prefixAt) prefixAt = word.at;
        break;
      }
    }
    if (!hit) {
      allPrefix = false;
      break;
    }
  }
  if (allPrefix) return { tier: T_MULTI_PREFIX, at: prefixAt === Infinity ? 0 : prefixAt, extra: extraAll };

  let fuzzyAt = Infinity;
  let allFuzzy = true;
  for (const token of tokens) {
    // Gate fuzzy to tokens of length >= 3 so a 1-2 char token can't fuzzy-match
    // almost every word.
    if (token.length < 3) {
      allFuzzy = false;
      break;
    }
    // Tighter edit-distance budget for short tokens so a 4-letter token can't
    // match an unrelated 3-letter word at distance 2.
    const maxDist = token.length >= 6 ? 2 : 1;
    let found = false;
    for (const word of words) {
      if (isSubsequence(token, word.w) || withinLevenshtein(token, word.w, maxDist)) {
        found = true;
        if (word.at < fuzzyAt) fuzzyAt = word.at;
        break;
      }
    }
    if (!found) {
      allFuzzy = false;
      break;
    }
  }
  if (allFuzzy) return { tier: T_FUZZY, at: fuzzyAt === Infinity ? 0 : fuzzyAt, extra: extraAll };

  return null;
};

/** All tokens present as substrings of text; returns the first token's index or -1. */
const allTokensSubstring = (text: string, tokens: string[]): number => {
  if (!text) return -1;
  let first = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const idx = text.indexOf(tokens[i]);
    if (idx < 0) return -1;
    if (i === 0) first = idx;
  }
  return first < 0 ? 0 : first;
};

interface Scored {
  item: PlaylistItem;
  tier: number;
  at: number;
  extra: number;
  titleLen: number;
  ord: number;
}

export const searchByQuery = (items: PlaylistItem[], query: string): PlaylistItem[] => {
  const nqRaw = normalize(query);
  if (!nqRaw) return items.slice();
  // nq keeps punctuation (for exact/substring tiers, compared against raw field
  // text). Word tokens are split on punctuation too — matching how field words
  // are split — so "tehran (2020)" -> ["tehran","2020"] and "2020" matches the
  // field word "2020" cleanly instead of the token "(2020)" fuzzy-matching it.
  const nq = nqRaw.split(/\s+/).filter(Boolean).join(" ");
  if (!nq) return items.slice();
  const wordTokens = nqRaw.split(WORD_SPLIT).filter(Boolean);
  const tokens = wordTokens.length ? wordTokens : [nq];

  const scored: Scored[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const data = buildSearchData(item);

    let best: FieldMatch | null = null;
    for (const field of data.nameFields) {
      const r = evalNameField(field, nq, tokens);
      if (!r) continue;
      if (best === null || r.tier > best.tier || (r.tier === best.tier && r.at < best.at)) best = r;
    }

    let tier: number;
    let at: number;
    let extra: number;
    if (best) {
      ({ tier, at, extra } = best);
    } else {
      const gAt = allTokensSubstring(data.group, tokens);
      if (gAt >= 0) {
        tier = T_GROUP;
        at = gAt;
        extra = 0;
      } else {
        const mAt = allTokensSubstring(data.metaBlob, tokens);
        if (mAt < 0) continue; // no tier reached -> excluded
        tier = T_META;
        at = mAt;
        extra = 0;
      }
    }

    scored.push({ item, tier, at, extra, titleLen: data.titleLen, ord: i });
  }

  scored.sort((x, y) => {
    if (x.tier !== y.tier) return y.tier - x.tier; // higher tier first
    if (x.at !== y.at) return x.at - y.at; // earlier match position
    if (x.extra !== y.extra) return x.extra - y.extra; // fewer extra words
    if (x.titleLen !== y.titleLen) return x.titleLen - y.titleLen; // shorter title
    return x.ord - y.ord; // stable
  });

  return scored.map((s) => s.item);
};

export const filterByQuery = searchByQuery;

export const filterItems = (items: PlaylistItem[], input: FilterInput): PlaylistItem[] => {
  const group = normalize(input.group);
  const groupFilterActive = group !== "" && group !== "all";
  const out: PlaylistItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (groupFilterActive && normalize(item.groupTitle) !== group) continue;
    if (input.favoritesOnly && !input.favoriteItemIds.has(item.id)) continue;
    out.push(item);
  }
  return searchByQuery(out, input.query);
};
