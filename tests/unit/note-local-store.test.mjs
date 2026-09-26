import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_LOCAL_DATABASE,
  NOTE_LOCAL_STORES,
  localRecordMatches,
  noteLocalKey
} from "../../js/core/note-local-store.js";

test("IndexedDBキーへユーザー・ノート・ページを含める", () => {
  assert.equal(noteLocalKey("alice", "note-1", "page-1"), "alice|note-1|page-1");
  assert.notEqual(noteLocalKey("alice", "note-1", "page-1"), noteLocalKey("bob", "note-1", "page-1"));
});

test("ノート用DBと復旧・サムネイルを含む6ストアの名前を固定する", () => {
  assert.equal(NOTE_LOCAL_DATABASE, "dentalQaNoteLocal");
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
