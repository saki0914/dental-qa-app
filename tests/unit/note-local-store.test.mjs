import assert from "node:assert/strict";
import test from "node:test";
import { NOTE_LOCAL_DATABASE, NOTE_LOCAL_STORES, noteLocalKey } from "../../js/core/note-local-store.js";

test("IndexedDBキーへユーザー・ノート・ページを含める", () => {
  assert.equal(noteLocalKey("alice", "note-1", "page-1"), "alice|note-1|page-1");
  assert.notEqual(noteLocalKey("alice", "note-1", "page-1"), noteLocalKey("bob", "note-1", "page-1"));
});

test("ノート用DBと4ストアの名前を固定する", () => {
  assert.equal(NOTE_LOCAL_DATABASE, "dentalQaNoteLocal");
  assert.deepEqual(NOTE_LOCAL_STORES, ["pageDrafts", "pendingAssets", "pendingSaves", "conflicts"]);
});
