import test from "node:test";
import assert from "node:assert/strict";
import { createSaveCoordinator } from "../../js/core/save-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test("デバウンス中の連続変更は最新の固定スナップショットへ集約する", async () => {
  const persisted = [];
  const transitions = [];
  const session = { userId: "user-a" };
  const coordinator = createSaveCoordinator({
    debounceMs: 5,
    persist: async item => {
      persisted.push(item);
      return true;
    },
    onTransition: event => transitions.push(`${event.type}:${event.generation}`)
  });
  coordinator.setSession(session);

  const firstState = { questionStatuses: { q1: 1 }, masks: [{ id: "mask-1" }] };
  const first = coordinator.request({
    session,
    snapshot: firstState,
    options: { allowEmptyProgress: true }
  });
  firstState.questionStatuses.q1 = 2;
  firstState.masks.push({ id: "mutated-after-queue" });

  const latestState = {
    questionStatuses: { q1: 2 },
    masks: [{ id: "mask-1" }, { id: "mask-2" }]
  };
  const second = coordinator.request({
    session,
    snapshot: latestState,
    options: { showAlerts: true }
  });
  latestState.masks.length = 0;

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].snapshot, {
    questionStatuses: { q1: 2 },
    masks: [{ id: "mask-1" }, { id: "mask-2" }]
  });
  assert.equal(persisted[0].options.allowEmptyProgress, true);
  assert.equal(persisted[0].options.showAlerts, true);
  assert.deepEqual(transitions, ["waiting:1", "waiting:2", "saving:2", "saved:2"]);
});

test("実行中に追加された保存は同時writeせず、新しい世代だけ完了表示する", async () => {
  const gates = [deferred(), deferred()];
  const started = [];
  const transitions = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const session = { userId: "user-a" };
  const coordinator = createSaveCoordinator({
    persist: async item => {
      const index = started.length;
      started.push(item.snapshot.value);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gates[index].promise;
      concurrent -= 1;
      return true;
    },
    onTransition: event => transitions.push(`${event.type}:${event.generation}`)
  });
  coordinator.setSession(session);

  const first = coordinator.request({
    session,
    snapshot: { value: "first" },
    immediate: true
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = coordinator.request({
    session,
    snapshot: { value: "latest" },
    immediate: true
  });

  assert.deepEqual(started, ["first"]);
  gates[0].resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(started, ["first", "latest"]);
  gates[1].resolve();

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(
    transitions.filter(value => value.startsWith("saved")),
    ["saved:2"]
  );
});

test("セッション切替後は旧セッションの完了を成功扱いせず新セッションを直列保存する", async () => {
  const oldGate = deferred();
  const started = [];
  const oldSession = { userId: "user-a" };
  const newSession = { userId: "user-b" };
  const coordinator = createSaveCoordinator({
    persist: async item => {
      started.push(item.session.userId);
      if (item.session === oldSession) await oldGate.promise;
      return true;
    }
  });
  coordinator.setSession(oldSession);

  const oldSave = coordinator.request({
    session: oldSession,
    snapshot: { value: "old" },
    immediate: true
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  coordinator.setSession(newSession);
  const newSave = coordinator.request({
    session: newSession,
    snapshot: { value: "new" },
    immediate: true
  });

  assert.deepEqual(started, ["user-a"]);
  oldGate.resolve();
  assert.equal(await oldSave, false);
  assert.equal(await newSave, true);
  assert.deepEqual(started, ["user-a", "user-b"]);
});

test("競合失敗後はdirtyを維持するがflushで自動リトライしない", async () => {
  const session = { userId: "user-a" };
  const gate = deferred();
  let persistCount = 0;
  const coordinator = createSaveCoordinator({
    persist: async () => {
      persistCount += 1;
      await gate.promise;
      const error = new Error("forced conflict");
      error.name = "CloudSaveConflictError";
      error.stopQueuedSaves = true;
      throw error;
    }
  });
  coordinator.setSession(session);

  const firstSave = coordinator.request({
    session,
    snapshot: { value: "unsaved" },
    immediate: true
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const queuedSave = coordinator.request({
    session,
    snapshot: { value: "newer but still conflicted" },
    immediate: true
  });
  gate.resolve();

  assert.equal(await firstSave, false);
  assert.equal(await queuedSave, false);
  assert.equal(coordinator.isDirty(session), true);
  assert.equal(await coordinator.flush(session), false);
  assert.equal(persistCount, 1);
});
