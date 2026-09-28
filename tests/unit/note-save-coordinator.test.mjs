import assert from "node:assert/strict";
import test from "node:test";
import { createNoteSaveCoordinator } from "../../js/core/note-save-coordinator.js";

function memoryStore() {
  const records = new Map();
  const matches = (record, expected) => {
    if (!record) return true;
    if (expected?.mutationId) return record.mutationId === expected.mutationId;
    return !record.mutationId &&
      (record.updatedAt || record.createdAt) === (expected?.updatedAt || expected?.createdAt);
  };
  return {
    records,
    put: async (store, value) => records.set(`${store}:${value.key}`, structuredClone(value)),
    delete: async (store, key) => records.delete(`${store}:${key}`),
    async putSavePair(draft, pending) {
      records.set(`pageDrafts:${draft.key}`, structuredClone(draft));
      records.set(`pendingSaves:${pending.key}`, structuredClone(pending));
    },
    async putSavePairIfMatching(draft, pending, expectedMutationId) {
      const expected = { mutationId: expectedMutationId };
      const currentDraft = records.get(`pageDrafts:${draft.key}`);
      const currentPending = records.get(`pendingSaves:${pending.key}`);
      if (!matches(currentDraft, expected) || !matches(currentPending, expected)) return false;
      records.set(`pageDrafts:${draft.key}`, structuredClone(draft));
      records.set(`pendingSaves:${pending.key}`, structuredClone(pending));
      return true;
    },
    async deleteSavePairIfUnchanged(key, expected) {
      const draft = records.get(`pageDrafts:${key}`);
      const pending = records.get(`pendingSaves:${key}`);
      if (!matches(draft, expected?.draft) || !matches(pending, expected?.pending)) return false;
      records.delete(`pageDrafts:${key}`);
      records.delete(`pendingSaves:${key}`);
      return true;
    }
  };
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("クラウド保存前に下書きと保存待ちを端末内へ保存する", async () => {
  const localStore = memoryStore();
  const calls = [];
  const coordinator = createNoteSaveCoordinator({ localStore, debounceMs: 9999, persist: async (...args) => calls.push(args) });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] });
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), true);
  assert.equal(localStore.records.has("pendingSaves:u|n|p"), true);
  assert.equal(localStore.records.get("pageDrafts:u|n|p").expectedRevision, 0);
  assert.equal(localStore.records.get("pendingSaves:u|n|p").expectedRevision, 0);
  assert.equal(localStore.records.get("pageDrafts:u|n|p").mutationId, localStore.records.get("pendingSaves:u|n|p").mutationId);
  await coordinator.flush(identity);
  assert.equal(calls.length, 1);
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), false);
});

test("IndexedDB下書き保存失敗は端末内保存済みと誤表示しない状態を通知する", async () => {
  const localStore = memoryStore();
  const failure = new Error("IndexedDB quota exceeded");
  localStore.putSavePair = async () => { throw failure; };
  const statuses = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => assert.fail("クラウド保存へ進んではならない"),
    onStatus: (status, _identity, detail) => statuses.push({ status, detail })
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await assert.rejects(
    coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] }),
    failure
  );
  assert.deepEqual(statuses, [{ status: "local-error", detail: failure }]);
  assert.equal(coordinator.getState(identity).dirty, true);
});

test("別タブ相当の新しいmutationIdをクラウド保存完了で削除しない", async () => {
  const localStore = memoryStore();
  let releasePersist;
  let notifyStarted;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      notifyStarted();
      await persistGate;
      return { revision: 1 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "old" }], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  await localStore.putSavePair(
    { key: "u|n|p", ...identity, mutationId: "newer", updatedAt: "later", content: { revision: 0, elements: [{ id: "new" }], noteMasks: [] } },
    { key: "u|n|p", ...identity, mutationId: "newer", updatedAt: "later" }
  );
  releasePersist();
  await flushing;
  assert.equal(localStore.records.get("pageDrafts:u|n|p").mutationId, "newer");
  assert.equal(localStore.records.get("pendingSaves:u|n|p").mutationId, "newer");
});

test("保存中の同一タブ再編集は基準revisionを条件付きで更新する", async () => {
  const localStore = memoryStore();
  let releaseFirstPersist;
  let notifyFirstStarted;
  let releaseSecondPersist;
  let notifySecondStarted;
  const firstStarted = new Promise(resolve => { notifyFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirstPersist = resolve; });
  const secondStarted = new Promise(resolve => { notifySecondStarted = resolve; });
  const secondGate = new Promise(resolve => { releaseSecondPersist = resolve; });
  let calls = 0;
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      calls += 1;
      if (calls === 1) {
        notifyFirstStarted();
        await firstGate;
        return { revision: 1 };
      }
      notifySecondStarted();
      await secondGate;
      return { revision: 2 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "first" }], noteMasks: [] });
  const firstFlush = coordinator.flush(identity);
  await firstStarted;
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "second" }], noteMasks: [] });
  const secondMutationId = localStore.records.get("pageDrafts:u|n|p").mutationId;
  releaseFirstPersist();
  await firstFlush;
  await secondStarted;
  const refreshedDraft = localStore.records.get("pageDrafts:u|n|p");
  assert.equal(refreshedDraft.expectedRevision, 1);
  assert.notEqual(refreshedDraft.mutationId, secondMutationId);
  assert.equal(refreshedDraft.content.elements[0].id, "second");
  releaseSecondPersist();
  await coordinator.flush(identity);
});

test("保存中の再編集後に別タブが更新した下書きをrevision更新で上書きしない", async () => {
  const localStore = memoryStore();
  let releaseFirstPersist;
  let notifyFirstStarted;
  let releaseSecondPersist;
  let notifySecondStarted;
  const firstStarted = new Promise(resolve => { notifyFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirstPersist = resolve; });
  const secondStarted = new Promise(resolve => { notifySecondStarted = resolve; });
  const secondGate = new Promise(resolve => { releaseSecondPersist = resolve; });
  let calls = 0;
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      calls += 1;
      if (calls === 1) {
        notifyFirstStarted();
        await firstGate;
        return { revision: 1 };
      }
      notifySecondStarted();
      await secondGate;
      return { revision: 2 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "first" }], noteMasks: [] });
  const firstFlush = coordinator.flush(identity);
  await firstStarted;
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "second" }], noteMasks: [] });
  await localStore.putSavePair(
    { key: "u|n|p", ...identity, mutationId: "other-tab", updatedAt: "later", content: { revision: 0, elements: [{ id: "other" }], noteMasks: [] } },
    { key: "u|n|p", ...identity, mutationId: "other-tab", updatedAt: "later" }
  );
  releaseFirstPersist();
  await firstFlush;
  await secondStarted;
  assert.equal(localStore.records.get("pageDrafts:u|n|p").mutationId, "other-tab");
  assert.equal(localStore.records.get("pageDrafts:u|n|p").content.elements[0].id, "other");
  releaseSecondPersist();
  await coordinator.flush(identity);
});

test("保存競合時はローカル版をconflictsへ保持する", async () => {
  const localStore = memoryStore();
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  let notifiedConflict = null;
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => { throw error; },
    onStatus: (status, _identity, _detail, conflict) => {
      if (status === "conflict") notifiedConflict = conflict;
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "x" }], noteMasks: [] });
  await assert.rejects(coordinator.flush(identity), /conflict/);
  assert.equal(localStore.records.has("conflicts:u|n|p"), true);
  assert.deepEqual(notifiedConflict, localStore.records.get("conflicts:u|n|p"));
});

test("競合解決で破棄した保存状態は後続flushで再送しない", async () => {
  const localStore = memoryStore();
  const calls = [];
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async (...args) => {
      calls.push(args);
      throw error;
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "local" }], noteMasks: [] });
  await assert.rejects(coordinator.flush(identity), /conflict/);
  assert.equal(coordinator.discard(identity), true);
  assert.equal(await coordinator.flush(identity), null);
  assert.equal(calls.length, 1);
});

test("実行中の保存を破棄した後は遅れて失敗しても競合を再作成しない", async () => {
  const localStore = memoryStore();
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  let releasePersist;
  let notifyStarted;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      notifyStarted();
      await persistGate;
      throw error;
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "local" }], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  assert.equal(coordinator.discard(identity), true);
  releasePersist();
  await assert.rejects(flushing, /conflict/);
  assert.equal(localStore.records.has("conflicts:u|n|p"), false);
  assert.equal(await coordinator.flush(identity), null);
});

test("実行中の保存を破棄した後は遅れて成功しても下書きを再作成しない", async () => {
  const localStore = memoryStore();
  let releasePersist;
  let notifyStarted;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      notifyStarted();
      await persistGate;
      return { revision: 1 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "local" }], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  coordinator.discard(identity);
  await localStore.deleteSavePairIfUnchanged("u|n|p", {
    draft: localStore.records.get("pageDrafts:u|n|p"),
    pending: localStore.records.get("pendingSaves:u|n|p")
  });
  releasePersist();
  await flushing;
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), false);
  assert.equal(localStore.records.has("pendingSaves:u|n|p"), false);
});

test("連続scheduleのローカル書込みが逆順で完了しても最新タイマーだけが保存する", async () => {
  const localStore = memoryStore();
  const originalPutSavePair = localStore.putSavePair;
  const releases = [];
  localStore.putSavePair = async (...args) => {
    const gate = new Promise(resolve => releases.push(resolve));
    await gate;
    return originalPutSavePair(...args);
  };
  const persisted = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 5,
    persist: async (_identity, content) => {
      persisted.push(content.elements[0].id);
      return { revision: 1 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  const first = coordinator.schedule(identity, { revision: 0, elements: [{ id: "first" }], noteMasks: [] });
  const second = coordinator.schedule(identity, { revision: 0, elements: [{ id: "second" }], noteMasks: [] });
  while (releases.length < 2) await wait(0);
  releases[1]();
  await second;
  releases[0]();
  await first;
  await wait(25);
  assert.deepEqual(persisted, ["second"]);
});

test("reset後に遅延成功した保存は状態やUIを更新しない", async () => {
  const localStore = memoryStore();
  const statuses = [];
  let releasePersist;
  let notifyStarted;
  let activeAfterRelease;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    onStatus: status => statuses.push(status),
    persist: async (_identity, _content, isActive) => {
      notifyStarted();
      await persistGate;
      activeAfterRelease = isActive();
      return { revision: 1 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  const statusCountBeforeReset = statuses.length;
  coordinator.reset();
  releasePersist();
  await flushing;
  assert.equal(activeAfterRelease, false);
  assert.equal(statuses.length, statusCountBeforeReset);
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), true);
});

test("同一UIDの再ログイン世代へ古い保存結果を持ち込まない", async () => {
  const localStore = memoryStore();
  const statuses = [];
  let sessionGeneration = 0;
  let releasePersist;
  let notifyStarted;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    isSessionCurrent: identity => identity.uid === "u" && identity.sessionGeneration === sessionGeneration,
    onStatus: status => statuses.push(status),
    persist: async () => {
      notifyStarted();
      await persistGate;
      return { revision: 1 };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p", sessionGeneration: 0 };
  await coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  const statusCountBeforeRelogin = statuses.length;
  sessionGeneration = 1;
  releasePersist();
  await flushing;
  assert.equal(statuses.length, statusCountBeforeRelogin);
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), true);
});

test("reset後に遅延失敗した保存は競合レコードを作らない", async () => {
  const localStore = memoryStore();
  let releasePersist;
  let notifyStarted;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const conflict = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      notifyStarted();
      await persistGate;
      throw conflict;
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  coordinator.reset();
  releasePersist();
  await assert.rejects(flushing, /conflict/);
  assert.equal(localStore.records.has("conflicts:u|n|p"), false);
});

test("保存中に古いidentityで再編集・flushしてもexpectedRevisionは後退しない", async () => {
  const localStore = memoryStore();
  let releaseFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const revisions = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async identity => {
      revisions.push(identity.expectedRevision);
      if (revisions.length === 1) { firstStarted(); await gate; }
      return { revision: identity.expectedRevision + 1 };
    }
  });
  const stale = { uid: "u", noteId: "n", pageId: "p", expectedRevision: 0 };
  await coordinator.schedule(stale, { revision: 0, elements: [{ id: "a" }], noteMasks: [] });
  const firstFlush = coordinator.flush(stale);
  await started;
  await coordinator.schedule(stale, { revision: 0, elements: [{ id: "b" }], noteMasks: [] });
  const secondFlush = coordinator.flush(stale);
  releaseFirst();
  await firstFlush;
  await secondFlush;
  await coordinator.flush(stale);
  assert.deepEqual(revisions, [0, 1]);
  assert.equal(localStore.records.has("conflicts:u|n|p"), false);
});

test("dirty状態へ渡された新しいidentityだけではexpectedRevisionを引き上げない", async () => {
  const localStore = memoryStore();
  const revisions = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async identity => {
      revisions.push(identity.expectedRevision);
      return { revision: identity.expectedRevision + 1 };
    }
  });
  const base = { uid: "u", noteId: "n", pageId: "p", expectedRevision: 2 };
  await coordinator.schedule(base, { revision: 2, elements: [{ id: "dirty" }], noteMasks: [] });
  await coordinator.flush({ ...base, expectedRevision: 9 });
  assert.deepEqual(revisions, [2]);
});

test("未送信状態がないページは新しいidentityのexpectedRevisionを採用する", async () => {
  const localStore = memoryStore();
  const revisions = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async identity => {
      revisions.push(identity.expectedRevision);
      return { revision: identity.expectedRevision + 1 };
    }
  });
  const base = { uid: "u", noteId: "n", pageId: "p", expectedRevision: 2 };
  await coordinator.schedule(base, { revision: 2, elements: [{ id: "first" }], noteMasks: [] });
  await coordinator.flush(base);
  await coordinator.schedule(
    { ...base, expectedRevision: 7 },
    { revision: 7, elements: [{ id: "fresh" }], noteMasks: [] }
  );
  await coordinator.flush({ ...base, expectedRevision: 7 });
  assert.deepEqual(revisions, [2, 7]);
});

test("復旧保存中に新しい編集が入っても同一ページを直列化してrevisionを引き継ぐ", async () => {
  const localStore = memoryStore();
  const key = "u|n|p";
  await localStore.putSavePair(
    { key, uid: "u", noteId: "n", pageId: "p", expectedRevision: 0, mutationId: "recovery", updatedAt: "2026-01-01T00:00:00.000Z", content: { revision: 0, elements: [{ id: "recovered" }], noteMasks: [] } },
    { key, uid: "u", noteId: "n", pageId: "p", expectedRevision: 0, mutationId: "recovery", updatedAt: "2026-01-01T00:00:00.000Z" }
  );
  let releaseRecovery;
  let recoveryStarted;
  const started = new Promise(resolve => { recoveryStarted = resolve; });
  const gate = new Promise(resolve => { releaseRecovery = resolve; });
  let inFlight = 0;
  let maxInFlight = 0;
  const revisions = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async identity => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      revisions.push(identity.expectedRevision);
      if (revisions.length === 1) { recoveryStarted(); await gate; }
      inFlight -= 1;
      return { revision: identity.expectedRevision + 1 };
    }
  });
  const stale = { uid: "u", noteId: "n", pageId: "p", expectedRevision: 0 };
  const recovering = coordinator.recover(
    stale,
    { revision: 0, elements: [{ id: "recovered" }], noteMasks: [] },
    { mutationId: "recovery", updatedAt: "2026-01-01T00:00:00.000Z" }
  );
  await started;
  await coordinator.schedule(stale, { revision: 0, elements: [{ id: "new-edit" }], noteMasks: [] });
  const flushing = coordinator.flush(stale);
  releaseRecovery();
  await recovering;
  await flushing;
  await coordinator.flush(stale);

  assert.deepEqual(revisions, [0, 1]);
  assert.equal(maxInFlight, 1);
  assert.equal(localStore.records.has("conflicts:u|n|p"), false);
});

test("書込み中はdebounce後のクラウド保存を保留し、保留が解けてから1回だけ保存する", async () => {
  const localStore = memoryStore();
  const calls = [];
  let holding = true;
  const holdRequests = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 5,
    cloudSaveHoldMs: request => {
      holdRequests.push(request);
      return holding ? 10 : 0;
    },
    persist: async (_identity, content) => {
      calls.push(content);
      return { revision: calls.length };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "a" }], noteMasks: [] });
  await wait(60);
  assert.equal(calls.length, 0, "保留中はクラウド保存を始めない");
  assert.ok(holdRequests.length >= 2, "保留中は一定間隔で再判定する");
  assert.ok(holdRequests.at(-1).heldMs > holdRequests[0].heldMs, "保留時間を渡す");
  assert.equal(coordinator.getState(identity).dirty, true);
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "a" }, { id: "b" }], noteMasks: [] });
  holding = false;
  await wait(60);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].elements.map(element => element.id), ["a", "b"]);
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), false);
});

test("明示flushは書込み中の保留に関係なくすぐクラウド保存する", async () => {
  const localStore = memoryStore();
  const calls = [];
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 5,
    cloudSaveHoldMs: () => 60_000,
    persist: async (...args) => { calls.push(args); return { revision: 1 }; }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] });
  await wait(20);
  assert.equal(calls.length, 0);
  await coordinator.flush(identity);
  assert.equal(calls.length, 1);
});

test("保存中に入った編集の再保存も書込み中は保留する", async () => {
  const localStore = memoryStore();
  let releaseFirst;
  let notifyFirstStarted;
  const firstStarted = new Promise(resolve => { notifyFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  let holding = false;
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 5,
    cloudSaveHoldMs: () => (holding ? 10 : 0),
    persist: async (_identity, content) => {
      calls.push(content.elements.map(element => element.id));
      if (calls.length === 1) {
        notifyFirstStarted();
        await firstGate;
      }
      return { revision: calls.length };
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "first" }], noteMasks: [] });
  await firstStarted;
  holding = true;
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "first" }, { id: "second" }], noteMasks: [] });
  releaseFirst();
  await wait(60);
  assert.deepEqual(calls, [["first"]], "書込み中は後続generationを直ちに再送しない");
  holding = false;
  await wait(60);
  assert.deepEqual(calls, [["first"], ["first", "second"]]);
  assert.equal(coordinator.getState(identity).dirty, false);
});
