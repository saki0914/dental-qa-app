import assert from "node:assert/strict";
import test from "node:test";

import {
  LINKED_NOTE_BATCH_SIZE,
  MATERIAL_NOTE_DELETE_REASONS,
  assignMaterialDefaultNoteId,
  getMaterialDefaultNoteId,
  isMaterialArchiving,
  isMaterialDeletedReason,
  markMaterialArchiving,
  markMaterialReady,
  normalizeMaterialIds,
  shouldArchiveLinkedNote,
  splitLinkedNoteWrites
} from "../../js/core/note-material-mutation.js";

test("教材IDを正規化して重複を除く", () => {
  assert.deepEqual(normalizeMaterialIds([" material-a ", "material-b", "material-a", ""]), ["material-a", "material-b"]);
  assert.throws(() => normalizeMaterialIds(["material/invalid"]), /使用できない文字/);
});

test("教材をarchivingでロックし、完了時にreadyへ戻す", () => {
  const material = { id: "material-a", status: "ready" };
  markMaterialArchiving(material, "replacement", "2026-09-27T00:00:00.000Z");
  assert.equal(isMaterialArchiving(material), true);
  assert.deepEqual(material, {
    id: "material-a",
    status: "archiving",
    archivingOperation: "replacement",
    archivingStartedAt: "2026-09-27T00:00:00.000Z"
  });

  markMaterialReady(material);
  assert.deepEqual(material, { id: "material-a", status: "ready" });
  assert.throws(() => markMaterialArchiving(material, "unknown"), /不正/);
});

test("連携ノート書込をFirestore上限500件ごとに分割する", () => {
  const notes = Array.from({ length: LINKED_NOTE_BATCH_SIZE * 2 + 1 }, (_, index) => `note-${index}`);
  const chunks = splitLinkedNoteWrites(notes);
  assert.deepEqual(chunks.map(chunk => chunk.length), [500, 500, 1]);
  assert.deepEqual(chunks.flat(), notes);
  assert.throws(() => splitLinkedNoteWrites(notes, LINKED_NOTE_BATCH_SIZE + 1), /1〜500/);
});

test("教材由来の論理削除理由だけを復元禁止として識別する", () => {
  assert.equal(isMaterialDeletedReason(MATERIAL_NOTE_DELETE_REASONS.replacement), true);
  assert.equal(isMaterialDeletedReason(MATERIAL_NOTE_DELETE_REASONS.deletion), true);
  assert.equal(isMaterialDeletedReason("user"), false);
  assert.equal(isMaterialDeletedReason(null), false);
});

test("既定ノートIDを教材レコードへ保存し、差し替え時に更新できる", () => {
  const material = { id: "material-a" };
  assert.equal(getMaterialDefaultNoteId(material), "");
  assert.equal(assignMaterialDefaultNoteId(material, "note-a"), "note-a");
  assert.equal(getMaterialDefaultNoteId(material), "note-a");
  assert.equal(assignMaterialDefaultNoteId(material, "note-b"), "note-b");
  assert.equal(getMaterialDefaultNoteId(material), "note-b");
  assert.throws(() => assignMaterialDefaultNoteId(material, "invalid/note"), /不正/);
});

test("教材差し替えではユーザー削除済みノートも復元不能へ更新する", () => {
  const replacementReason = MATERIAL_NOTE_DELETE_REASONS.replacement;
  assert.equal(shouldArchiveLinkedNote({ deletedAt: "earlier", deletedReason: "user" }, replacementReason), true);
  assert.equal(shouldArchiveLinkedNote({ deletedAt: "earlier", deletedReason: replacementReason }, replacementReason), false);
  assert.throws(() => shouldArchiveLinkedNote({}, "unknown"), /削除理由/);
});
