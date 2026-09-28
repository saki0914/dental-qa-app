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
