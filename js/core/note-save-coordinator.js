import { noteLocalKey } from "./note-local-store.js";
import { randomId } from "./id.js";

export function createNoteSaveCoordinator({
  localStore,
  persist,
  debounceMs = 850,
  onStatus = () => {},
  isSessionCurrent = () => true
}) {
  const states = new Map();

  function isStateStillValid(state, { generation, identity = state?.identity, requireDirty = false } = {}) {
    return Boolean(
      state &&
      !state.disposed &&
      states.get(state.key) === state &&
      isSessionCurrent(identity) &&
      (generation === undefined || state.generation === generation) &&
      (!requireDirty || state.dirty)
    );
  }

  function invalidateState(state) {
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = null;
    state.disposed = true;
    state.dirty = false;
    state.latest = null;
    state.generation += 1;
  }

  function stateFor(identity) {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    if (!states.has(key)) states.set(key, {
      key,
      identity: { ...identity },
      timer: null,
      running: null,
      localWrite: null,
      dirty: false,
      generation: 0,
      latest: null,
      latestMutation: null,
      lastError: null,
      disposed: false
    });
    const state = states.get(key);
    state.identity = { ...state.identity, ...identity };
    return state;
  }

  async function saveLocal(identity, content, mutationId = randomId(), expectedMutationId = "") {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    const expectedRevision = Number(identity.expectedRevision ?? content?.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ローカル下書きの基準リビジョンが不正です。");
    }
    const updatedAt = new Date().toISOString();
    const draft = {
      key,
      ...identity,
      expectedRevision,
      content: structuredClone(content),
      mutationId,
      updatedAt
    };
    const pending = { key, ...identity, expectedRevision, mutationId, updatedAt };
    const stored = expectedMutationId
      ? await localStore.putSavePairIfMatching(draft, pending, expectedMutationId)
      : (await localStore.putSavePair(draft, pending), true);
    if (!stored) return null;
    return { mutationId, updatedAt };
  }

  async function execute(identity, state) {
    if (state.running) return state.running;
    if (state.localWrite) await state.localWrite;
    if (!isStateStillValid(state, { identity, requireDirty: true })) return null;
    state.identity = { ...state.identity, ...identity };
    const activeIdentity = { ...state.identity };
    const generation = state.generation;
    const localMutation = { ...state.latestMutation };
    const content = structuredClone(state.latest);
    state.dirty = false;
    onStatus(globalThis.navigator?.onLine === false ? "offline" : "saving", activeIdentity);
    const running = (async () => {
      try {
        const result = await persist(
          activeIdentity,
          content,
          () => isStateStillValid(state, { generation, identity: activeIdentity })
        );
        if (!isStateStillValid(state, { identity: activeIdentity })) return result;
        if (isStateStillValid(state, { generation, identity: activeIdentity })) {
          state.lastError = null;
          const deleted = await localStore.deleteSavePairIfUnchanged(state.key, {
            draft: localMutation,
            pending: localMutation
          });
          if (isStateStillValid(state, { generation, identity: activeIdentity })) {
            onStatus(deleted ? "saved" : "local-saved", activeIdentity, result);
          }
        } else if (state.latest && Number.isInteger(result?.revision) && result.revision >= 0) {
          state.identity = { ...state.identity, expectedRevision: result.revision };
          const latestGeneration = state.generation;
          const expectedMutationId = state.latestMutation?.mutationId;
          const refreshedMutation = expectedMutationId
            ? await saveLocal(state.identity, state.latest, randomId(), expectedMutationId)
            : null;
          if (refreshedMutation && isStateStillValid(state, {
            generation: latestGeneration,
            identity: state.identity
          }) &&
              state.latestMutation?.mutationId === expectedMutationId) {
            state.latestMutation = refreshedMutation;
            onStatus("local-saved", state.identity);
          }
        }
        return result;
      } catch (error) {
        if (isStateStillValid(state, { generation, identity: activeIdentity })) {
          state.lastError = error;
          state.dirty = true;
          if (error?.name === "NoteConflictError") {
            await localStore.put("conflicts", {
              key: state.key,
              ...activeIdentity,
              content,
              error: error.message,
              updatedAt: new Date().toISOString()
            });
            if (isStateStillValid(state, { generation, identity: activeIdentity })) {
              onStatus("conflict", activeIdentity, error);
            }
          } else {
            onStatus(globalThis.navigator?.onLine === false ? "offline" : "error", activeIdentity, error);
          }
        }
        throw error;
      } finally {
        if (state.running === running) state.running = null;
        if (isStateStillValid(state, { identity: state.identity, requireDirty: true }) &&
            state.latest && state.generation !== generation) {
          void execute(state.identity, state).catch(() => {});
        }
      }
    })();
    state.running = running;
    return running;
  }

  async function schedule(identity, content) {
    if (!isSessionCurrent(identity)) {
      const error = new Error("ログインセッションが切り替わったため、保存予約を中断しました。");
      error.name = "NoteSessionChangedError";
      throw error;
    }
    const state = stateFor(identity);
    state.latest = structuredClone(content);
    state.dirty = true;
    state.generation += 1;
    const generation = state.generation;
    const mutationId = randomId();
    state.latestMutation = { mutationId };
    clearTimeout(state.timer);
    state.timer = null;
    const localWrite = saveLocal(identity, content, mutationId);
    state.localWrite = localWrite;
    try {
      const persistedMutation = await localWrite;
      if (persistedMutation && isStateStillValid(state, { generation, identity }) &&
          state.latestMutation?.mutationId === mutationId) {
        state.latestMutation = persistedMutation;
      }
    } finally {
      if (state.localWrite === localWrite) state.localWrite = null;
    }
    if (!isStateStillValid(state, { generation, identity, requireDirty: true })) return;
    onStatus("local-saved", identity);
    onStatus("editing", identity);
    const timer = setTimeout(() => {
      if (state.timer === timer) state.timer = null;
      if (!isStateStillValid(state, { generation, identity, requireDirty: true })) return;
      void execute(identity, state).catch(() => {});
    }, debounceMs);
    if (isStateStillValid(state, { generation, identity, requireDirty: true })) state.timer = timer;
    else clearTimeout(timer);
  }

  async function flush(identity) {
    const state = stateFor(identity);
    clearTimeout(state.timer);
    state.timer = null;
    if (!state.dirty && !state.running) return null;
    if (state.running) await state.running.catch(() => {});
    if (!state.dirty) return null;
    return execute(identity, state);
  }

  async function flushAll() {
    const results = [];
    for (const state of states.values()) {
      clearTimeout(state.timer);
      if (state.running) await state.running.catch(() => {});
      if (state.dirty && state.latest) {
        results.push(await execute(state.identity, state).catch(error => error));
      }
    }
    return results;
  }

  function discard(identity) {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    const state = states.get(key);
    if (!state) return false;
    invalidateState(state);
    states.delete(key);
    return true;
  }

  return {
    schedule,
    flush,
    flushAll,
    discard,
    isDirty: identity => stateFor(identity).dirty,
    hasPending: () => [...states.values()].some(state => state.dirty || state.running || state.lastError),
    getState(identity) {
      const state = stateFor(identity);
      return { dirty: state.dirty, running: Boolean(state.running), error: state.lastError };
    },
    reset() {
      states.forEach(invalidateState);
      states.clear();
    }
  };
}
