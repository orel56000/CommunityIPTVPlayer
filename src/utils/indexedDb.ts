import type { PlaylistItem } from "../types/models";

const DB_NAME = "iptv-player-db";
const DB_VERSION = 3;
const PLAYLIST_STORE = "playlistItems";
const CHUNK_STORE = "playlistItemChunks";
const SOURCE_STORE = "playlistSources";

/** Items per IndexedDB record — large single-record puts often fail in the browser. */
const ITEMS_PER_CHUNK = 3000;

interface PlaylistItemsRecord {
  playlistId: string;
  items: PlaylistItem[];
  updatedAt: number;
}

interface ChunkMetaRecord {
  key: string;
  partCount: number;
  totalItems: number;
  updatedAt: number;
}

interface ChunkPartRecord {
  key: string;
  partIndex: number;
  items: PlaylistItem[];
  updatedAt: number;
}

interface PlaylistSourceRecord {
  playlistId: string;
  content: string;
  updatedAt: number;
}

const chunkKey = {
  prefix: (playlistId: string) => `chunk::${playlistId}::`,
  meta: (playlistId: string) => `chunk::${playlistId}::meta`,
  part: (playlistId: string, index: number) => `chunk::${playlistId}::p::${index}`,
};

const hasIndexedDb = (): boolean => typeof indexedDB !== "undefined";

const openDb = async (): Promise<IDBDatabase | null> => {
  if (!hasIndexedDb()) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PLAYLIST_STORE)) {
        db.createObjectStore(PLAYLIST_STORE, { keyPath: "playlistId" });
      }
      if (!db.objectStoreNames.contains(SOURCE_STORE)) {
        db.createObjectStore(SOURCE_STORE, { keyPath: "playlistId" });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const runTransaction = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> => {
  const db = await openDb();
  if (!db) throw new Error("IndexedDB is unavailable in this browser.");
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    handler(store, resolve, reject);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
};

const runTransactionMulti = async <T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  handler: (
    getStore: (name: string) => IDBObjectStore,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void,
  ) => void,
): Promise<T> => {
  const db = await openDb();
  if (!db) throw new Error("IndexedDB is unavailable in this browser.");
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const getStore = (name: string) => {
      if (!storeNames.includes(name)) throw new Error(`Store "${name}" is not part of this transaction.`);
      return transaction.objectStore(name);
    };
    handler(getStore, resolve, reject);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
};

const deleteChunkKeysForPlaylist = (
  chunkStore: IDBObjectStore,
  playlistId: string,
  onDone: () => void,
  onError: (reason?: unknown) => void,
): void => {
  const pfx = chunkKey.prefix(playlistId);
  const range = IDBKeyRange.bound(pfx, `${pfx}\uffff`);
  const request = chunkStore.openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    } else {
      onDone();
    }
  };
  request.onerror = () => onError(request.error);
};

export const playlistDb = {
  async savePlaylistItems(playlistId: string, items: PlaylistItem[]): Promise<void> {
    await runTransactionMulti<void>([PLAYLIST_STORE, CHUNK_STORE], "readwrite", (getStore, resolve, reject) => {
      const legacyStore = getStore(PLAYLIST_STORE);
      const chunkStore = getStore(CHUNK_STORE);

      deleteChunkKeysForPlaylist(
        chunkStore,
        playlistId,
        () => {
          const delLegacy = legacyStore.delete(playlistId);
          delLegacy.onsuccess = () => {
            if (items.length === 0) {
              resolve();
              return;
            }
            const partCount = Math.ceil(items.length / ITEMS_PER_CHUNK);
            let partIndex = 0;

            const writeNextPart = (): void => {
              if (partIndex >= partCount) {
                const meta: ChunkMetaRecord = {
                  key: chunkKey.meta(playlistId),
                  partCount,
                  totalItems: items.length,
                  updatedAt: Date.now(),
                };
                const metaReq = chunkStore.put(meta);
                metaReq.onsuccess = () => resolve();
                metaReq.onerror = () => reject(metaReq.error);
                return;
              }
              const start = partIndex * ITEMS_PER_CHUNK;
              const slice = items.slice(start, start + ITEMS_PER_CHUNK);
              const record: ChunkPartRecord = {
                key: chunkKey.part(playlistId, partIndex),
                partIndex,
                items: slice,
                updatedAt: Date.now(),
              };
              const putReq = chunkStore.put(record);
              putReq.onsuccess = () => {
                partIndex += 1;
                writeNextPart();
              };
              putReq.onerror = () => reject(putReq.error);
            };

            writeNextPart();
          };
          delLegacy.onerror = () => reject(delLegacy.error);
        },
        reject,
      );
    });
  },

  async loadPlaylistItems(playlistId: string): Promise<PlaylistItem[]> {
    return runTransactionMulti<PlaylistItem[]>([PLAYLIST_STORE, CHUNK_STORE], "readonly", (getStore, resolve, reject) => {
      const legacyStore = getStore(PLAYLIST_STORE);
      const chunkStore = getStore(CHUNK_STORE);
      const metaReq = chunkStore.get(chunkKey.meta(playlistId));
      metaReq.onsuccess = () => {
        const meta = metaReq.result as ChunkMetaRecord | undefined;
        if (meta && typeof meta.partCount === "number" && meta.partCount >= 0) {
          if (meta.partCount === 0) {
            resolve([]);
            return;
          }
          const parts: PlaylistItem[][] = new Array(meta.partCount);
          let remaining = meta.partCount;
          for (let i = 0; i < meta.partCount; i += 1) {
            const idx = i;
            const partReq = chunkStore.get(chunkKey.part(playlistId, idx));
            partReq.onsuccess = () => {
              const part = partReq.result as ChunkPartRecord | undefined;
              parts[idx] = part?.items ?? [];
              remaining -= 1;
              if (remaining === 0) {
                resolve(parts.flat());
              }
            };
            partReq.onerror = () => reject(partReq.error);
          }
          return;
        }
        const legacyReq = legacyStore.get(playlistId);
        legacyReq.onsuccess = () => {
          const record = legacyReq.result as PlaylistItemsRecord | undefined;
          resolve(record?.items ?? []);
        };
        legacyReq.onerror = () => reject(legacyReq.error);
      };
      metaReq.onerror = () => reject(metaReq.error);
    });
  },

  async deletePlaylistItems(playlistId: string): Promise<void> {
    await runTransactionMulti<void>([PLAYLIST_STORE, CHUNK_STORE], "readwrite", (getStore, resolve, reject) => {
      const legacyStore = getStore(PLAYLIST_STORE);
      const chunkStore = getStore(CHUNK_STORE);
      deleteChunkKeysForPlaylist(
        chunkStore,
        playlistId,
        () => {
          const delLegacy = legacyStore.delete(playlistId);
          delLegacy.onsuccess = () => resolve();
          delLegacy.onerror = () => reject(delLegacy.error);
        },
        reject,
      );
    });
  },

  async clearPlaylistItems(): Promise<void> {
    await runTransactionMulti<void>([PLAYLIST_STORE, CHUNK_STORE], "readwrite", (getStore, resolve, reject) => {
      const legacyStore = getStore(PLAYLIST_STORE);
      const chunkStore = getStore(CHUNK_STORE);
      const c1 = legacyStore.clear();
      const c2 = chunkStore.clear();
      let pending = 2;
      const check = (): void => {
        pending -= 1;
        if (pending === 0) resolve();
      };
      c1.onsuccess = check;
      c2.onsuccess = check;
      c1.onerror = () => reject(c1.error);
      c2.onerror = () => reject(c2.error);
    });
  },

  async savePlaylistSourceContent(playlistId: string, content: string): Promise<void> {
    await runTransaction<void>(SOURCE_STORE, "readwrite", (store, resolve, reject) => {
      const value: PlaylistSourceRecord = { playlistId, content, updatedAt: Date.now() };
      const request = store.put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async loadPlaylistSourceContent(playlistId: string): Promise<string | null> {
    return runTransaction<string | null>(SOURCE_STORE, "readonly", (store, resolve, reject) => {
      const request = store.get(playlistId);
      request.onsuccess = () => {
        const record = request.result as PlaylistSourceRecord | undefined;
        resolve(record?.content ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async deletePlaylistSourceContent(playlistId: string): Promise<void> {
    await runTransaction<void>(SOURCE_STORE, "readwrite", (store, resolve, reject) => {
      const request = store.delete(playlistId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async clearPlaylistSources(): Promise<void> {
    await runTransaction<void>(SOURCE_STORE, "readwrite", (store, resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
};
