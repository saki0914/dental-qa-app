import assert from "node:assert/strict";
import test from "node:test";
import {
  createIndexedDbNoteResourceWriter,
  createNoteResourceCache,
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
