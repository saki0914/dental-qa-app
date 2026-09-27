import assert from "node:assert/strict";
import test from "node:test";
import { createNotePageSaveQueue } from "../../js/core/note-page-save-queue.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("同一ページのライブ保存と復旧保存を同時に実行しない", async () => {
  const queue = createNotePageSaveQueue();
  const firstGate = deferred();
  const secondStarted = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async (name, gate = null) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (name === "recovery") secondStarted.resolve();
    if (gate) await gate.promise;
    inFlight -= 1;
    return name;
  };

  const live = queue.enqueue("u|note|page", () => run("live", firstGate));
  const recovery = queue.enqueue("u|note|page", () => run("recovery"));
  await Promise.resolve();
  assert.equal(inFlight, 1);
  assert.equal(maxInFlight, 1);

  firstGate.resolve();
  await secondStarted.promise;
  assert.equal(maxInFlight, 1);
  assert.deepEqual(await Promise.all([live, recovery]), ["live", "recovery"]);
  assert.equal(queue.size, 0);
});

test("ページが異なる保存は互いを待たせない", async () => {
  const queue = createNotePageSaveQueue();
  const gate = deferred();
  let started = 0;
  const first = queue.enqueue("u|note|page-1", async () => { started += 1; await gate.promise; });
  const second = queue.enqueue("u|note|page-2", async () => { started += 1; await gate.promise; });
  await Promise.resolve();
  assert.equal(started, 2);
  gate.resolve();
  await Promise.all([first, second]);
});

test("先行保存の失敗後も同じページの次の保存を実行する", async () => {
  const queue = createNotePageSaveQueue();
  const calls = [];
  const first = queue.enqueue("u|note|page", async () => {
    calls.push("first");
    throw new Error("failed");
  });
  const second = queue.enqueue("u|note|page", async () => {
    calls.push("second");
    return "saved";
  });
  await assert.rejects(first, /failed/);
  assert.equal(await second, "saved");
  assert.deepEqual(calls, ["first", "second"]);
});
