import assert from "node:assert/strict";
import test from "node:test";
import { resolveNoteConflicts } from "../../js/core/note-conflict-resolution.js";

test("複数ページの競合をスナップショット順にすべて解決する", async () => {
  const conflicts = [{ pageId: "page-1" }, { pageId: "page-2" }, { pageId: "page-3" }];
  const decisions = [true, false, true];
  const resolved = [];
  const count = await resolveNoteConflicts(conflicts, {
    decide: async (conflict, context) => {
      assert.equal(context.total, 3);
      return decisions[context.index];
    },
    resolve: async (conflict, useLocal, context) => {
      resolved.push([conflict.pageId, useLocal, context.index]);
    }
  });

  assert.equal(count, 3);
  assert.deepEqual(resolved, [
    ["page-1", true, 0],
    ["page-2", false, 1],
    ["page-3", true, 2]
  ]);
});
