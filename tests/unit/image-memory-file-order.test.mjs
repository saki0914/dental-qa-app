import assert from "node:assert/strict";
import test from "node:test";

import { moveImageMemoryFile } from "../../js/core/image-memory-file-order.js";

test("画像ファイルを指定した位置へ移動し、元の配列は変更しない", () => {
  const files = [{ name: "3.png" }, { name: "1.png" }, { name: "2.png" }];

  const reordered = moveImageMemoryFile(files, 0, 1);

  assert.deepEqual(reordered.map(file => file.name), ["1.png", "3.png", "2.png"]);
  assert.deepEqual(files.map(file => file.name), ["3.png", "1.png", "2.png"]);
  assert.notEqual(reordered, files);
});

test("同名ファイルも配列位置によって正しく移動する", () => {
  const first = { name: "page.png", id: "first" };
  const second = { name: "page.png", id: "second" };

  assert.deepEqual(moveImageMemoryFile([first, second], 1, 0), [second, first]);
});

test("範囲外または同じ位置への移動は並びを維持したコピーを返す", () => {
  const files = [{ name: "1.png" }, { name: "2.png" }];

  for (const [fromIndex, toIndex] of [[-1, 0], [0, 2], [0, 0], [0.5, 1]]) {
    const result = moveImageMemoryFile(files, fromIndex, toIndex);
    assert.deepEqual(result, files);
    assert.notEqual(result, files);
  }
});
