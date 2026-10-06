import assert from "node:assert/strict";
import test from "node:test";
import {
  createIndexedDbNoteResourceWriter,
  createNoteResourceCache,
  noteResourceManifestKey,
  selectNoteResourceCacheEvictions
} from "../../js/core/note-resource-cache.js";

function createMemoryCacheStorage() {
  const records = new Map();
  const cache = {
    async match(request) { return records.get(String(request))?.clone() || null; },
    async put(request, response) { records.set(String(request), response.clone()); },
    async keys() { return [...records.keys()]; },
    async delete(request) { return records.delete(String(request)); }
  };
  return {
    records,
    async open() { return cache; }
  };
}

test("ノート画像キャッシュはユーザーとリソースキーを分離してBlobを復元する", async () => {
  const cacheStorage = createMemoryCacheStorage();
  const cache = createNoteResourceCache({ cacheStorage, origin: "https://example.test", now: () => 10 });
  const source = new Blob(["page-image"], { type: "image/png" });

  assert.equal(await cache.put("uid-a", "background|note-a|page-1", source), true);
  assert.equal(await (await cache.get("uid-a", "background|note-a|page-1")).text(), "page-image");
  assert.equal(await cache.get("uid-b", "background|note-a|page-1"), null);
  assert.equal(await cache.get("uid-a", "background|note-a|page-2"), null);
});

test("ノート画像キャッシュは古い項目から上限数へ整理する", async () => {
  const cacheStorage = createMemoryCacheStorage();
  let clock = 0;
  const cache = createNoteResourceCache({
    cacheStorage,
    origin: "https://example.test",
    maxEntries: 2,
    now: () => ++clock
  });

  await cache.put("uid", "one", new Blob(["1"]));
  await cache.put("uid", "two", new Blob(["2"]));
  await cache.put("uid", "three", new Blob(["3"]));

  assert.equal(cacheStorage.records.size, 2);
  assert.equal(await cache.get("uid", "one"), null);
  assert.equal(await (await cache.get("uid", "two")).text(), "2");
  assert.equal(await (await cache.get("uid", "three")).text(), "3");
});

test("Cache APIを利用できない環境では安全に無効化する", async () => {
  const cache = createNoteResourceCache({ cacheStorage: null, origin: "" });
  assert.equal(cache.available, false);
  assert.equal(await cache.get("uid", "key"), null);
  assert.equal(await cache.put("uid", "key", new Blob(["x"])), false);
});

test("IndexedDB用キャッシュ整理は新しい項目を優先して件数と総容量を制限する", () => {
  const records = [
    { key: "old", kind: "note-resource", blob: new Blob(["1234"]), updatedAt: "2026-01-01T00:00:00.000Z" },
    { key: "middle", kind: "note-resource", blob: new Blob(["1234"]), updatedAt: "2026-01-02T00:00:00.000Z" },
    { key: "new", kind: "note-resource", blob: new Blob(["1234"]), updatedAt: "2026-01-03T00:00:00.000Z" },
    { key: "thumbnail", kind: "page-thumbnail", blob: new Blob(["123456789"]), updatedAt: "2025-01-01T00:00:00.000Z" }
  ];

  assert.deepEqual(selectNoteResourceCacheEvictions(records, {
    incomingKey: "incoming",
    incomingSize: 4,
    maxEntries: 3,
    maxBytes: 12
  }), ["old"]);
  assert.deepEqual(selectNoteResourceCacheEvictions(records, {
    incomingKey: "incoming",
    incomingSize: 5,
    maxEntries: 4,
    maxBytes: 10
  }), ["middle", "old"]);
});

test("IndexedDB用キャッシュ整理は同じキーの置換と非リソース項目を削除対象にしない", () => {
  const records = [
    { key: "same", kind: "note-resource", blobSize: 100, updatedAt: "2026-01-01T00:00:00.000Z" },
    { key: "other", kind: "note-resource", blobSize: 3, updatedAt: "2026-01-02T00:00:00.000Z" },
    { key: "thumbnail", blobSize: 1000, updatedAt: "2025-01-01T00:00:00.000Z" }
  ];

  assert.deepEqual(selectNoteResourceCacheEvictions(records, {
    incomingKey: "same",
    incomingSize: 3,
    maxEntries: 2,
    maxBytes: 6
  }), []);
});

test("IndexedDB容量超過時は管理対象だけを削除して1回だけ再試行する", async () => {
  const records = [
    { key: "uid|note|old-a", uid: "uid", kind: "note-resource", blobSize: 3 },
    { key: "uid|note|old-b", uid: "uid", kind: "note-resource", blobSize: 3 },
    { key: "uid|note|thumbnail", uid: "uid", kind: "page-thumbnail", blobSize: 3 },
    { key: "uid|note|legacy-thumbnail", uid: "uid", blobSize: 3 }
  ];
  const deleted = [];
  const stored = [];
  const evictionCounts = [];
  let putCalls = 0;
  const localStore = {
    async listForUser(storeName, uid) {
      assert.equal(storeName, "thumbnails");
      assert.equal(uid, "uid");
      return records;
    },
    async delete(storeName, key) {
      deleted.push([storeName, key]);
    },
    async put(storeName, record) {
      putCalls += 1;
      if (putCalls === 1) throw new DOMException("storage quota reached", "QuotaExceededError");
      stored.push([storeName, record.key]);
    }
  };
  const writer = createIndexedDbNoteResourceWriter({
    localStore,
    onEvictions: count => evictionCounts.push(count)
  });

  assert.equal(await writer.write({
    key: "uid|note|incoming",
    uid: "uid",
    kind: "note-resource",
    blobSize: 3
  }), true);
  assert.equal(putCalls, 2);
  assert.deepEqual(deleted, [
    ["thumbnails", "uid|note|old-a"],
    ["thumbnails", "uid|note|old-b"]
  ]);
  assert.deepEqual(stored, [["thumbnails", "uid|note|incoming"]]);
  assert.deepEqual(evictionCounts, [2]);
});

test("IndexedDB書込みキューは失敗後も後続処理を直列実行する", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const localStore = {
    async listForUser() { return []; },
    async delete() {},
    async put(storeName, record) {
      events.push(`${record.key}:start`);
      if (record.key === "first") {
        await firstGate;
        events.push("first:failed");
        throw new Error("forced write failure");
      }
      events.push(`${record.key}:done`);
    }
  };
  const writer = createIndexedDbNoteResourceWriter({ localStore });
  const first = writer.enqueue({ key: "first", uid: "uid", blobSize: 1 });
  const second = writer.enqueue({ key: "second", uid: "uid", blobSize: 1 });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /forced write failure/);
  assert.equal(await second, true);
  assert.deepEqual(events, ["first:start", "first:failed", "second:start", "second:done"]);
});

// An IndexedDB stand-in that records which records are read.
function createKeyedLocalStore(initial = []) {
  const records = new Map(initial.map(record => [record.key, record]));
  const reads = [];
  return {
    records,
    reads,
    async get(storeName, key) {
      assert.equal(storeName, "thumbnails");
      reads.push(key);
      return records.get(key) || null;
    },
    async put(storeName, value) {
      assert.equal(storeName, "thumbnails");
      records.set(value.key, structuredClone(value));
    },
    async delete(storeName, key) {
      records.delete(key);
    },
    async listKeysForUser(storeName, uid) {
      return [...records.keys()].filter(key => key.startsWith(`${uid}|`)).sort();
    },
    async listForUser() {
      throw new Error("画像を含む全レコードは読み込まない");
    }
  };
}

const resource = (name, size, updatedAt) => ({
  key: `uid|note|page|resource-${name}`,
  uid: "uid",
  noteId: "note",
  pageId: "page",
  kind: "note-resource",
  blobSize: size,
  updatedAt
});

test("画像キャッシュの整理は一覧レコードとキーだけで判断し、保存済みの画像を読み込まない", async () => {
  const localStore = createKeyedLocalStore();
  const evictions = [];
  const writer = createIndexedDbNoteResourceWriter({ localStore, maxEntries: 2, maxBytes: 100, onEvictions: count => evictions.push(count) });

  assert.equal(await writer.write(resource("a", 10, "2026-01-01T00:00:00.000Z")), true);
  assert.equal(await writer.write(resource("b", 10, "2026-01-02T00:00:00.000Z")), true);
  assert.equal(await writer.write(resource("c", 10, "2026-01-03T00:00:00.000Z")), true);

  assert.deepEqual([...localStore.records.keys()].sort(), [
    "uid|note|page|resource-b",
    "uid|note|page|resource-c",
    noteResourceManifestKey("uid")
  ].sort());
  assert.deepEqual(evictions, [1]);
  assert.deepEqual(new Set(localStore.reads), new Set([noteResourceManifestKey("uid")]));
  assert.deepEqual(localStore.records.get(noteResourceManifestKey("uid")).entries.map(entry => [entry.key, entry.blobSize]), [
    ["uid|note|page|resource-b", 10],
    ["uid|note|page|resource-c", 10]
  ]);
});

test("一覧にない既存の画像キャッシュは一度だけ読み、消えた項目は一覧から外す", async () => {
  const localStore = createKeyedLocalStore([
    resource("old", 60, "2026-01-01T00:00:00.000Z"),
    resource("kept", 30, "2026-01-02T00:00:00.000Z"),
    { key: "uid|note|page|thumbnail", uid: "uid", noteId: "note", kind: "page-thumbnail", blobSize: 500, updatedAt: "2025-01-01T00:00:00.000Z" }
  ]);
  const writer = createIndexedDbNoteResourceWriter({ localStore, maxEntries: 5, maxBytes: 100 });

  // 60 + 30 + 20 exceeds 100 bytes: the oldest resource goes, the thumbnail stays.
  assert.equal(await writer.write(resource("new", 20, "2026-01-03T00:00:00.000Z")), true);
  assert.equal(localStore.records.has("uid|note|page|resource-old"), false);
  assert.equal(localStore.records.has("uid|note|page|thumbnail"), true);
  assert.deepEqual(localStore.reads.filter(key => key !== noteResourceManifestKey("uid")).sort(), [
    "uid|note|page|resource-kept",
    "uid|note|page|resource-old"
  ]);

  // Another tab removed a cached image: the manifest no longer counts it, and
  // nothing but the manifest is read again.
  localStore.records.delete("uid|note|page|resource-kept");
  localStore.reads.length = 0;
  assert.equal(await writer.write(resource("next", 20, "2026-01-04T00:00:00.000Z")), true);
  assert.deepEqual(localStore.reads, [noteResourceManifestKey("uid")]);
  assert.deepEqual(localStore.records.get(noteResourceManifestKey("uid")).entries.map(entry => entry.key).sort(), [
    "uid|note|page|resource-new",
    "uid|note|page|resource-next"
  ]);
});

test("画像キャッシュの容量超過時はキーだけで管理対象を消して1回だけ再試行する", async () => {
  const localStore = createKeyedLocalStore([
    resource("a", 3, "2026-01-01T00:00:00.000Z"),
    { key: "uid|note|page|thumbnail", uid: "uid", noteId: "note", kind: "page-thumbnail", blobSize: 3 }
  ]);
  const put = localStore.put;
  let failures = 1;
  localStore.put = async (storeName, value) => {
    if (value.kind === "note-resource" && failures > 0) {
      failures -= 1;
      throw new DOMException("storage quota reached", "QuotaExceededError");
    }
    return put(storeName, value);
  };
  const writer = createIndexedDbNoteResourceWriter({ localStore });

  assert.equal(await writer.write(resource("b", 3, "2026-01-02T00:00:00.000Z")), true);
  assert.equal(localStore.records.has("uid|note|page|resource-a"), false);
  assert.equal(localStore.records.has("uid|note|page|resource-b"), true);
  assert.equal(localStore.records.has("uid|note|page|thumbnail"), true);
  assert.deepEqual(localStore.records.get(noteResourceManifestKey("uid")).entries.map(entry => entry.key), ["uid|note|page|resource-b"]);
});
