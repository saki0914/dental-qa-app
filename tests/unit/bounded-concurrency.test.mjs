import assert from "node:assert/strict";
import test from "node:test";

import { runWithConcurrency } from "../../js/core/bounded-concurrency.js";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("同時実行数を上限以下に保ち、全件を処理する", async () => {
  let running = 0;
  let peak = 0;
  const done = [];
  await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await delay(5 + (value % 3));
    done.push(index);
    running -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test("失敗後は新しい処理を始めず、開始済みの処理を待ってから最初のエラーを返す", async () => {
  const started = [];
  const finished = [];
  await assert.rejects(runWithConcurrency([0, 1, 2, 3, 4, 5], 2, async value => {
    started.push(value);
    if (value === 1) throw new Error("upload failed");
    await delay(15);
    finished.push(value);
  }), /upload failed/);
  assert.ok(!started.includes(4) && !started.includes(5), "失敗後に後続を開始しない");
  assert.deepEqual(finished.sort(), started.filter(value => value !== 1).sort(), "開始済みの処理は完了まで待つ");
});

test("空配列ではworkerを呼ばない", async () => {
  let called = false;
  await runWithConcurrency([], 4, async () => { called = true; });
  assert.equal(called, false);
});
