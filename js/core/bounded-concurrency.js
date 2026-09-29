// Runs `worker(item, index)` for every item with at most `limit` in flight.
// After the first failure no new items are started, every started worker is
// allowed to settle (so callers can compensate for all completed work), and
// the first error is rethrown.
export async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let nextIndex = 0;
  let failure = null;
  let failed = false;
  const runner = async () => {
    while (!failed && nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(list[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: width }, runner));
  if (failed) throw failure;
}

// Runs tasks as they are produced, at most `concurrency` at a time. `add()`
// resolves once the task has started or waits behind fewer than `capacity`
// queued tasks, so a producer awaiting it stays at most that far ahead of the
// running tasks. After the first failure no queued or later task starts,
// `add()` rejects with that error, and `drain()` rethrows it once every
// started task has settled. `settle()` waits the same way without throwing.
export function createTaskQueue({ concurrency = 1, capacity = 0 } = {}) {
  const width = Math.max(1, Math.floor(Number(concurrency)) || 1);
  const room = Math.max(0, Math.floor(Number(capacity)) || 0);
  const queued = [];
  const running = new Set();
  const waiters = new Set();
  let failed = false;
  let failure = null;

  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const until = condition => new Promise(resolve => {
    if (condition()) {
      resolve();
      return;
    }
    const waiter = () => {
      if (!condition()) return;
      waiters.delete(waiter);
      resolve();
    };
    waiters.add(waiter);
  });
  const pump = () => {
    while (!failed && running.size < width && queued.length) {
      const task = queued.shift();
      const run = Promise.resolve()
        .then(task)
        .catch(error => {
          if (failed) return;
          failed = true;
          failure = error;
          queued.length = 0;
        })
        .finally(() => {
          running.delete(run);
          pump();
          notify();
        });
      running.add(run);
    }
  };
  const settle = () => until(() => running.size === 0 && (failed || queued.length === 0));

  return {
    async add(task) {
      if (failed) throw failure;
      queued.push(task);
      pump();
      await until(() => failed || queued.length <= room);
      if (failed) throw failure;
    },
    settle,
    async drain() {
      await settle();
      if (failed) throw failure;
    },
    get pending() {
      return running.size + queued.length;
    }
  };
}
