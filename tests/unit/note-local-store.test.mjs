import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_LOCAL_DATABASE,
  NOTE_LOCAL_DATABASE_VERSION,
  NOTE_LOCAL_STORES,
  createNoteLocalStore,
  localRecordMatches,
  noteLocalKey
} from "../../js/core/note-local-store.js";

test("IndexedDBキーへユーザー・ノート・ページを含める", () => {
  assert.equal(noteLocalKey("alice", "note-1", "page-1"), "alice|note-1|page-1");
  assert.equal(noteLocalKey("alice", "note-1", "page-1", "thumbnail"), "alice|note-1|page-1|thumbnail");
  assert.equal(noteLocalKey("alice", "note-1", "cleanup", "retry-1"), "alice|note-1|cleanup|retry-1");
  assert.notEqual(noteLocalKey("alice", "note-1", "page-1"), noteLocalKey("bob", "note-1", "page-1"));
});

test("ノート用DBと復旧・サムネイルを含む6ストアの名前を固定する", () => {
  assert.equal(NOTE_LOCAL_DATABASE, "dentalQaNoteLocal");
  assert.equal(NOTE_LOCAL_DATABASE_VERSION, 2);
  assert.deepEqual(NOTE_LOCAL_STORES, [
    "pageDrafts", "pendingAssets", "pendingSaves", "conflicts", "pendingCleanups", "thumbnails"
  ]);
});

test("mutationIdを優先し、旧レコードだけ日時一致へフォールバックする", () => {
  assert.equal(localRecordMatches(
    { mutationId: "new", updatedAt: "later" },
    { mutationId: "old", updatedAt: "earlier" }
  ), false);
  assert.equal(localRecordMatches(
    { mutationId: "same", updatedAt: "later" },
    { mutationId: "same", updatedAt: "earlier" }
  ), true);
  assert.equal(localRecordMatches(
    { updatedAt: "legacy" },
    { updatedAt: "legacy" }
  ), true);
  assert.equal(localRecordMatches(
    { updatedAt: "changed" },
    { updatedAt: "legacy" }
  ), false);
  assert.equal(localRecordMatches(
    { mutationId: "new", updatedAt: "legacy" },
    { updatedAt: "legacy" }
  ), false);
});

test("全6ストアの新規レコードはuidとnoteIdを必須にする", async () => {
  const localStore = createNoteLocalStore(undefined);
  for (const storeName of NOTE_LOCAL_STORES) {
    await assert.rejects(
      localStore.put(storeName, { key: `${storeName}|missing-uid`, noteId: "note-1" }),
      error => error instanceof TypeError && /uidとnoteId/.test(error.message)
    );
    await assert.rejects(
      localStore.put(storeName, { key: `${storeName}|missing-note`, uid: "alice" }),
      error => error instanceof TypeError && /uidとnoteId/.test(error.message)
    );
  }
});

test("全6ストアをv2主キーのユーザー・ノートprefix範囲で取得する", async () => {
  const calls = [];
  const database = {
    close() {},
    transaction(storeName) {
      const transaction = {
        objectStore() {
          return {
            getAll(query) {
              calls.push({ storeName, query });
              const request = { result: [] };
              queueMicrotask(() => transaction.oncomplete?.());
              return request;
            }
          };
        }
      };
      return transaction;
    }
  };
  const indexedDb = {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  const keyRange = {
    bound: (lower, upper) => ({ lower, upper })
  };
  const localStore = createNoteLocalStore(indexedDb, keyRange);

  for (const storeName of NOTE_LOCAL_STORES) {
    await localStore.listForNote(storeName, "alice", "note-1");
  }
  await localStore.listForUser("pendingCleanups", "alice");
  await localStore.close();

  assert.deepEqual(calls.slice(0, NOTE_LOCAL_STORES.length), NOTE_LOCAL_STORES.map(storeName => ({
    storeName,
    query: { lower: "alice|note-1|", upper: "alice|note-1|\uffff" }
  })));
  assert.deepEqual(calls.at(-1), {
    storeName: "pendingCleanups",
    query: { lower: "alice|", upper: "alice|\uffff" }
  });
});

test("iPad Safariで閉じられたIndexedDB接続は1回だけ開き直して書き込む", async () => {
  let opens = 0;
  const writes = [];
  const makeDatabase = closed => ({
    close() {},
    transaction(storeName) {
      if (closed) {
        const error = new Error("The database connection is closing.");
        error.name = "InvalidStateError";
        throw error;
      }
      const transaction = {
        objectStore() {
          return {
            put(value) {
              writes.push({ storeName, value });
              const request = { result: value.key };
              queueMicrotask(() => transaction.oncomplete?.());
              return request;
            }
          };
        }
      };
      return transaction;
    }
  });
  const indexedDb = {
    open() {
      opens += 1;
      const request = { result: makeDatabase(opens === 1) };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  const localStore = createNoteLocalStore(indexedDb, { bound: (lower, upper) => ({ lower, upper }) });
  await localStore.put("thumbnails", { key: "alice|note-1|page-1|thumbnail", uid: "alice", noteId: "note-1" });
  assert.equal(opens, 2);
  assert.equal(writes.length, 1);
  await localStore.put("thumbnails", { key: "alice|note-1|page-2|thumbnail", uid: "alice", noteId: "note-1" });
  assert.equal(opens, 2, "開き直した接続を再利用する");
});

test("IndexedDBを開けなかった失敗はキャッシュせず次回に再試行する", async () => {
  let opens = 0;
  const indexedDb = {
    open() {
      opens += 1;
      const request = {};
      if (opens === 1) {
        request.error = new Error("quota");
        queueMicrotask(() => request.onerror());
      } else {
        request.result = {
          close() {},
          transaction() {
            const transaction = {
              objectStore: () => ({
                get() {
                  const getRequest = { result: { key: "k", uid: "alice", noteId: "n" } };
                  queueMicrotask(() => transaction.oncomplete?.());
                  return getRequest;
                }
              })
            };
            return transaction;
          }
        };
        queueMicrotask(() => request.onsuccess());
      }
      return request;
    }
  };
  const localStore = createNoteLocalStore(indexedDb, { bound: () => null });
  await assert.rejects(localStore.get("pageDrafts", "k"), /quota/);
  assert.deepEqual(await localStore.get("pageDrafts", "k"), { key: "k", uid: "alice", noteId: "n" });
  assert.equal(opens, 2);
});
