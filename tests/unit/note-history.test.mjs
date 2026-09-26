import assert from "node:assert/strict";
import test from "node:test";
import { createNoteHistory } from "../../js/core/note-history.js";

test("Undo・Redoは1操作単位の前後状態を復元する", () => {
  const history = createNoteHistory({ limit: 100 });
  history.push({ value: 1 }, { value: 2 }, "移動");
  assert.deepEqual(history.undo({ value: 2 }), { value: 1 });
  assert.deepEqual(history.redo({ value: 1 }), { value: 2 });
});

test("新規操作後はRedo履歴を破棄する", () => {
  const history = createNoteHistory();
  history.push({ value: 1 }, { value: 2 }); history.undo({ value: 2 });
  history.push({ value: 1 }, { value: 3 });
  assert.equal(history.canRedo(), false);
});

test("履歴は指定上限を超えて保持しない", () => {
  const history = createNoteHistory({ limit: 2 });
  history.push(0, 1); history.push(1, 2); history.push(2, 3);
  assert.deepEqual(history.sizes(), { undo: 2, redo: 0 });
});
