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
