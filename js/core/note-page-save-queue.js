export function createNotePageSaveQueue() {
  const tails = new Map();

  function enqueue(key, task) {
    if (!key) throw new TypeError("ページ保存キューのキーが必要です。");
    if (typeof task !== "function") throw new TypeError("ページ保存処理が必要です。");

    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  return {
    enqueue,
    has: key => tails.has(key),
    get size() { return tails.size; }
  };
}
