const DEFAULT_CACHE_NAME = "dental-qa-note-resources-v1";
export const NOTE_RESOURCE_CACHE_MAX_ENTRIES = 48;
export const NOTE_RESOURCE_IDB_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_PATH = "/__dental-note-resource-cache__/v1/";

function validText(value) {
  return typeof value === "string" && value.length > 0;
}

function isBlobLike(value) {
  return Boolean(
    value &&
    Number(value.size) > 0 &&
    typeof value.arrayBuffer === "function" &&
    typeof value.type === "string"
  );
}

function cacheRequestUrl(origin, uid, resourceKey) {
  const base = String(origin || "").replace(/\/$/, "");
  if (!base || !validText(uid) || !validText(resourceKey)) return "";
  return `${base}${CACHE_PATH}${encodeURIComponent(uid)}?key=${encodeURIComponent(resourceKey)}`;
}

function recordTimestamp(record) {
  const parsed = Date.parse(record?.updatedAt || record?.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordSize(record) {
  const size = Number(record?.blob?.size ?? record?.blobSize ?? record?.blobBytes?.byteLength ?? 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

export function selectNoteResourceCacheEvictions(records, {
  incomingKey = "",
  incomingSize = 0,
  maxEntries = NOTE_RESOURCE_CACHE_MAX_ENTRIES,
  maxBytes = NOTE_RESOURCE_IDB_MAX_BYTES
} = {}) {
  const entryLimit = Math.max(1, Math.trunc(Number(maxEntries) || 1));
  const byteLimit = Math.max(0, Number(maxBytes) || 0);
  let retainedEntries = incomingKey ? 1 : 0;
  let retainedBytes = Math.max(0, Number(incomingSize) || 0);
  const evictedKeys = [];
  const candidates = (Array.isArray(records) ? records : [])
    .filter(record => record?.kind === "note-resource" && validText(record.key) && record.key !== incomingKey)
    .sort((left, right) => recordTimestamp(right) - recordTimestamp(left) || String(right.key).localeCompare(String(left.key)));

  candidates.forEach(record => {
    const size = recordSize(record);
    if (retainedEntries < entryLimit && retainedBytes + size <= byteLimit) {
      retainedEntries += 1;
      retainedBytes += size;
    } else {
      evictedKeys.push(record.key);
    }
  });
  return evictedKeys;
}

function isIndexedDbQuotaError(error) {
  return error?.name === "QuotaExceededError" || /quota/i.test(String(error?.message || error || ""));
}

export function createIndexedDbNoteResourceWriter({
  localStore,
  storeName = "thumbnails",
  maxEntries = NOTE_RESOURCE_CACHE_MAX_ENTRIES,
  maxBytes = NOTE_RESOURCE_IDB_MAX_BYTES,
  onEvictions = () => {}
} = {}) {
  let writeQueue = Promise.resolve();

  async function deleteKeys(keys) {
    for (const key of keys) await localStore.delete(storeName, key);
    if (keys.length) onEvictions(keys.length);
  }

  async function prune(record) {
    const records = await localStore.listForUser(storeName, record.uid);
    await deleteKeys(selectNoteResourceCacheEvictions(records, {
      incomingKey: record.key,
      incomingSize: record.blobSize,
      maxEntries,
      maxBytes
    }));
  }

  async function write(record) {
    const blobSize = Number(record?.blobSize || 0);
    if (blobSize <= 0 || blobSize > maxBytes) return false;
    await prune(record);
    try {
      await localStore.put(storeName, record);
      return true;
    } catch (error) {
      if (!isIndexedDbQuotaError(error)) throw error;
      // Browser quotas vary substantially, especially in iPad private or
      // low-storage sessions. These records are reproducible cache data, so
      // clear only managed resources before making one final write attempt.
      const managedRecords = await localStore.listForUser(storeName, record.uid);
      const managedKeys = managedRecords
        .filter(item => item?.kind === "note-resource" && validText(item.key))
        .map(item => item.key);
      await deleteKeys(managedKeys);
      await localStore.put(storeName, record);
      return true;
    }
  }

  function enqueue(record) {
    const pending = writeQueue.then(() => write(record));
    writeQueue = pending.catch(() => {});
    return pending;
  }

  return { write, enqueue };
}

export function createNoteResourceCache({
  cacheStorage = null,
  origin = "",
  cacheName = DEFAULT_CACHE_NAME,
  maxEntries = NOTE_RESOURCE_CACHE_MAX_ENTRIES,
  now = () => Date.now()
} = {}) {
  const resolveCacheStorage = () => cacheStorage || globalThis.caches;
  const resolveOrigin = () => origin || globalThis.location?.origin || "";
  const isAvailable = () => Boolean(resolveCacheStorage()?.open && resolveOrigin());

  async function trim(cache) {
    const requests = await cache.keys();
    if (requests.length <= maxEntries) return;
    const entries = await Promise.all(requests.map(async request => {
      const response = await cache.match(request);
      return {
        request,
        cachedAt: Number(response?.headers?.get?.("x-dental-cached-at") || 0)
      };
    }));
    entries.sort((left, right) => left.cachedAt - right.cachedAt);
    await Promise.all(entries.slice(0, Math.max(0, entries.length - maxEntries))
      .map(entry => cache.delete(entry.request)));
  }

  async function get(uid, resourceKey) {
    const requestUrl = cacheRequestUrl(resolveOrigin(), uid, resourceKey);
    if (!isAvailable() || !requestUrl) return null;
    try {
      const cache = await resolveCacheStorage().open(cacheName);
      const response = await cache.match(requestUrl);
      if (!response?.ok) return null;
      const blob = await response.blob();
      return blob.size > 0 ? blob : null;
    } catch (error) {
      console.debug("ノート画像キャッシュを読み込めませんでした。", error);
      return null;
    }
  }

  async function put(uid, resourceKey, blob) {
    const requestUrl = cacheRequestUrl(resolveOrigin(), uid, resourceKey);
    // Firebase's getBlob() may return a Blob whose constructor belongs to the
    // SDK/WebKit realm. Duck typing avoids rejecting that valid value solely
    // because `instanceof Blob` crosses realms on iPad Safari.
    if (!isAvailable() || !requestUrl || !isBlobLike(blob)) return false;
    try {
      const cache = await resolveCacheStorage().open(cacheName);
      await cache.put(requestUrl, new Response(blob, {
        headers: {
          "content-type": blob.type || "application/octet-stream",
          "x-dental-cached-at": String(now())
        }
      }));
      await trim(cache);
      return true;
    } catch (error) {
      console.debug("ノート画像キャッシュへ保存できませんでした。", error);
      return false;
    }
  }

  return {
    get available() { return isAvailable(); },
    get,
    put
  };
}
