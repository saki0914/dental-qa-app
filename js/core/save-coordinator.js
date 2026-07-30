import { cloneCloudState } from "./cloud-sync-state.js";

function mergeSaveOptions(previous = {}, next = {}) {
  return {
    ...previous,
    ...next,
    allowEmptyQuestions: previous.allowEmptyQuestions === true || next.allowEmptyQuestions === true,
    allowEmptyPdfMaterials:
      previous.allowEmptyPdfMaterials === true || next.allowEmptyPdfMaterials === true,
    allowEmptyProgress: previous.allowEmptyProgress === true || next.allowEmptyProgress === true,
    allowEmptySettings: previous.allowEmptySettings === true || next.allowEmptySettings === true,
    showAlerts: previous.showAlerts === true || next.showAlerts === true
  };
}

export function createSaveCoordinator({
  persist,
  onTransition = () => {},
  debounceMs = 600,
  clone = cloneCloudState
}) {
  if (typeof persist !== "function") {
    throw new TypeError("persist is required");
  }

  let activeSession = null;
  let generation = 0;
  let timer = null;
  let pending = null;
  let running = null;
  let dirty = false;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function settleWaiters(item, result) {
    (item?.waiters || []).forEach(resolve => resolve(result));
  }

  function setSession(session) {
    clearTimer();
    if (pending) settleWaiters(pending, false);
    pending = null;
    activeSession = session || null;
    generation = 0;
    dirty = false;
  }

  async function drain() {
    if (running) {
      await running;
      if (pending) return drain();
      return !dirty;
    }

    if (!pending) return !dirty;

    clearTimer();
    const item = pending;
    pending = null;

    if (item.session !== activeSession) {
      settleWaiters(item, false);
      return drain();
    }

    onTransition({
      type: "saving",
      session: item.session,
      generation: item.generation
    });

    let persisted = false;
    let failure = null;
    running = (async () => {
      try {
        persisted = await persist({
          session: item.session,
          generation: item.generation,
          snapshot: item.snapshot,
          options: item.options
        }) !== false;
      } catch (error) {
        failure = error;
        persisted = false;
      }
    })();

    await running;
    running = null;

    const sessionIsCurrent = item.session === activeSession;
    settleWaiters(item, sessionIsCurrent && persisted);

    if (!sessionIsCurrent) {
      if (pending) return drain();
      return false;
    }

    if (!persisted) {
      dirty = true;
      onTransition({
        type: "error",
        session: item.session,
        generation: item.generation,
        error: failure
      });
      if (failure?.stopQueuedSaves === true && pending) {
        settleWaiters(pending, false);
        pending = null;
        return false;
      }
      if (pending) return drain();
      return false;
    }

    if (pending) return drain();

    dirty = false;
    onTransition({
      type: "saved",
      session: item.session,
      generation: item.generation
    });
    return true;
  }

  function scheduleDrain(delay) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delay);
  }

  function request({ session, snapshot, options = {}, immediate = false }) {
    if (!session || session !== activeSession) return Promise.resolve(false);

    generation += 1;
    const requestGeneration = generation;
    const requestSnapshot = clone(snapshot);

    let resolveRequest;
    const result = new Promise(resolve => {
      resolveRequest = resolve;
    });

    if (pending?.session === session) {
      pending = {
        session,
        generation: requestGeneration,
        snapshot: requestSnapshot,
        options: mergeSaveOptions(pending.options, options),
        waiters: [...pending.waiters, resolveRequest]
      };
    } else {
      pending = {
        session,
        generation: requestGeneration,
        snapshot: requestSnapshot,
        options: mergeSaveOptions({}, options),
        waiters: [resolveRequest]
      };
    }

    dirty = true;
    onTransition({
      type: "waiting",
      session,
      generation: requestGeneration
    });

    if (immediate) {
      clearTimer();
      void drain();
    } else {
      scheduleDrain(debounceMs);
    }

    return result;
  }

  async function flush(session = activeSession) {
    if (!session || session !== activeSession) return false;
    clearTimer();

    while (session === activeSession) {
      if (running) {
        await running;
        continue;
      }
      if (pending) {
        await drain();
        continue;
      }
      return !dirty;
    }

    return false;
  }

  return {
    setSession,
    request,
    flush,
    isDirty: session => !!session && session === activeSession && dirty,
    getState: () => ({
      activeSession,
      dirty,
      hasPending: !!pending,
      isRunning: !!running,
      generation
    })
  };
}
