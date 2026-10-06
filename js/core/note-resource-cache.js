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

const MANIFEST_KIND = "note-resource-manifest";
const MANIFEST_NAME = "~note-resource-manifest";
// Cached page images are stored under keys ending in "|resource-<hash>"
// (see resourceLocalCacheKey in study-notes.js).
const RESOURCE_KEY_PATTERN = /\|resource-[^|]*$/;

// The record that lists every cached resource of a user (key, size, time).
export function noteResourceManifestKey(uid) {
  return `${uid}|${MANIFEST_NAME}`;
}

function resourceEntry(record) {
  if (record?.kind !== "note-resource" || !validText(record.key)) return null;
  return {
    key: record.key,
    blobSize: recordSize(record),
    updatedAt: String(record.updatedAt || record.createdAt || "")
  };
}

export function createIndexedDbNoteResourceWriter({
  localStore,
  storeName = "thumbnails",
  maxEntries = NOTE_RESOURCE_CACHE_MAX_ENTRIES,
  maxBytes = NOTE_RESOURCE_IDB_MAX_BYTES,
  isResourceKey = key => RESOURCE_KEY_PATTERN.test(String(key)),
  onEvictions = () => {}
} = {}) {
  let writeQueue = Promise.resolve();
  // Reading every record to decide what to evict read every cached image
  // (up to maxBytes) from IndexedDB for each new one. A store that can list
  // its keys alone keeps a manifest of sizes and times instead.
  const keyed = typeof localStore?.listKeysForUser === "function" && typeof localStore?.get === "function";

  async function deleteKeys(keys) {
    for (const key of keys) await localStore.delete(storeName, key);
    if (keys.length) onEvictions(keys.length);
  }

  // The cached resources of a user, without their images: the manifest gives
  // the size and time of each, and the stored keys (read without values) show
  // which still exist. A resource the manifest does not list (cached before
  // the manifest existed, or by another tab at the same moment) is read once.
  async function resourceEntries(uid) {
    if (!keyed) {
      const records = await localStore.listForUser(storeName, uid);
      return records.map(resourceEntry).filter(Boolean);
    }
    const [manifest, keys] = await Promise.all([
      localStore.get(storeName, noteResourceManifestKey(uid)).catch(() => null),
      localStore.listKeysForUser(storeName, uid)
    ]);
    const listed = new Map(
      (manifest?.kind === MANIFEST_KIND && Array.isArray(manifest.entries) ? manifest.entries : [])
        .filter(entry => validText(entry?.key))
        .map(entry => [entry.key, entry])
    );
    const entries = [];
    for (const key of keys) {
      if (!validText(key) || !isResourceKey(key)) continue;
      const entry = listed.get(key) || resourceEntry(await localStore.get(storeName, key).catch(() => null));
      if (entry?.key === key) entries.push(entry);
    }
    return entries;
  }

  async function managedKeys(uid) {
    if (!keyed) {
      const records = await localStore.listForUser(storeName, uid);
      return records.filter(item => item?.kind === "note-resource" && validText(item.key)).map(item => item.key);
    }
    return (await localStore.listKeysForUser(storeName, uid)).filter(key => validText(key) && isResourceKey(key));
  }

  async function saveManifest(uid, entries) {
    if (!keyed) return;
    try {
      await localStore.put(storeName, {
        key: noteResourceManifestKey(uid),
        uid,
        noteId: MANIFEST_NAME,
        kind: MANIFEST_KIND,
        entries,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      // The next write reads the resources the manifest misses.
      console.debug("ノート画像キャッシュの一覧を保存できませんでした。", error);
    }
  }

  async function write(record) {
    const blobSize = Number(record?.blobSize || 0);
    if (blobSize <= 0 || blobSize > maxBytes) return false;
    const entries = await resourceEntries(record.uid);
    const evicted = selectNoteResourceCacheEvictions(
      entries.map(entry => ({ ...entry, kind: "note-resource" })),
      { incomingKey: record.key, incomingSize: blobSize, maxEntries, maxBytes }
    );
    await deleteKeys(evicted);
    const evictedKeys = new Set(evicted);
    let retained = entries.filter(entry => entry.key !== record.key && !evictedKeys.has(entry.key));
    try {
      await localStore.put(storeName, record);
    } catch (error) {
      if (!isIndexedDbQuotaError(error)) throw error;
      // Browser quotas vary substantially, especially in iPad private or
      // low-storage sessions. These records are reproducible cache data, so
      // clear only managed resources before making one final write attempt.
      await deleteKeys(await managedKeys(record.uid));
      retained = [];
      await localStore.put(storeName, record);
    }
    const written = resourceEntry({ kind: "note-resource", ...record, blobSize });
    await saveManifest(record.uid, written ? [...retained, written] : retained);
    return true;
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
