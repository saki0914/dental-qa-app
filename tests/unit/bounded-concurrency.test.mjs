import assert from "node:assert/strict";
import test from "node:test";

import { createTaskQueue, runWithConcurrency } from "../../js/core/bounded-concurrency.js";

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("タスクキューは同時実行数を守り、待ち行列が満杯のときだけ追加側を待たせる", async () => {
  const queue = createTaskQueue({ concurrency: 2, capacity: 1 });
  const gates = Array.from({ length: 5 }, deferred);
  const started = [];
  let running = 0;
  let peak = 0;
  const task = index => async () => {
    started.push(index);
    running += 1;
    peak = Math.max(peak, running);
    await gates[index].promise;
    running -= 1;
  };
  await queue.add(task(0));
  await queue.add(task(1));
  await queue.add(task(2));
  await delay(1);
  assert.deepEqual(started, [0, 1], "2件実行中、1件待ち");
  let fourthAccepted = false;
  const fourth = queue.add(task(3)).then(() => { fourthAccepted = true; });
  await delay(5);
  assert.equal(fourthAccepted, false, "待ち行列が満杯なら追加側が待つ");
  assert.equal(queue.pending, 4);
  gates[0].resolve();
  await fourth;
  await delay(1);
  assert.deepEqual(started, [0, 1, 2], "空いた枠で待ちの先頭が始まる");
  const fifth = queue.add(task(4));
  gates.forEach(gate => gate.resolve());
  await fifth;
  await queue.drain();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(queue.pending, 0);
});

test("タスクキューは失敗後に待ちと後続を始めず、開始済みの完了を待ってから最初のエラーを返す", async () => {
  const queue = createTaskQueue({ concurrency: 2, capacity: 2 });
  const slow = deferred();
  const started = [];
  const finished = [];
  await queue.add(async () => { started.push("slow"); await slow.promise; finished.push("slow"); });
  await queue.add(async () => { started.push("fail"); throw new Error("upload failed"); });
  await queue.add(async () => { started.push("queued"); });
  await delay(5);
  await assert.rejects(queue.add(async () => { started.push("late"); }), /upload failed/);
  let settled = false;
  const draining = queue.drain().catch(error => { settled = true; throw error; });
  await delay(5);
  assert.equal(settled, false, "開始済みの処理が終わるまで待つ");
  slow.resolve();
  await assert.rejects(draining, /upload failed/);
  assert.deepEqual(started, ["slow", "fail"], "失敗後は待ちも後続も始めない");
  assert.deepEqual(finished, ["slow"]);
  await queue.settle();
});

test("空のタスクキューはすぐに完了する", async () => {
  const queue = createTaskQueue({ concurrency: 3 });
  await queue.drain();
  await queue.settle();
  assert.equal(queue.pending, 0);
});
