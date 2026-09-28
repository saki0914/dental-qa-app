import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_WORK_TIMING,
  cloudSaveHoldDelay,
  strokeFlushDelay,
  thumbnailRefreshDelay
} from "../../js/core/note-work-timing.js";

const timing = NOTE_WORK_TIMING;

test("書き続けている間はstrokeのflushを待ち、書込みが止まってから実行する", () => {
  const base = { now: 10_000, lastInputAt: 10_000, pendingSince: 9_000, pendingStrokes: 3 };
  assert.equal(strokeFlushDelay({ ...base, afterLift: true }), timing.strokeFlushQuietMs, "ペンを離した直後は次の画を待つ");
  assert.equal(strokeFlushDelay({ ...base, now: 10_400 }), timing.strokeFlushQuietMs - 400);
  assert.equal(strokeFlushDelay({ ...base, now: 10_000 + timing.strokeFlushQuietMs }), 0, "十分な休止で実行する");
  assert.equal(strokeFlushDelay({ ...base, now: 12_000, gestureActive: true }), timing.strokeFlushQuietMs, "筆記中は実行しない");
});

test("長く書き続けたstrokeはペンを離した直後に1回まとめてflushする", () => {
  const writing = { now: 20_000, lastInputAt: 20_000, pendingSince: 20_000 - timing.strokeFlushMaxPendingMs, pendingStrokes: 12 };
  assert.equal(strokeFlushDelay({ ...writing, afterLift: true }), timing.strokeFlushAfterLiftMs);
  assert.equal(strokeFlushDelay(writing), 0, "予約時刻に筆記していなければそのまま実行する");
  assert.equal(strokeFlushDelay({ ...writing, gestureActive: true }), timing.strokeFlushQuietMs, "次の画の途中には割り込まない");
  const manyStrokes = { now: 20_000, lastInputAt: 20_000, pendingSince: 19_000, pendingStrokes: timing.strokeFlushMaxPendingStrokes };
  assert.equal(strokeFlushDelay({ ...manyStrokes, afterLift: true }), timing.strokeFlushAfterLiftMs);
});

test("クラウド保存は書込みの休止まで保留し、長時間保留したらペンが離れている時に保存する", () => {
  const base = { now: 50_000, lastInputAt: 49_500, heldMs: 1_000 };
  assert.equal(cloudSaveHoldDelay(base), timing.cloudSaveQuietMs - 500);
  assert.equal(cloudSaveHoldDelay({ ...base, lastInputAt: 50_000 - timing.cloudSaveQuietMs }), 0);
  assert.equal(cloudSaveHoldDelay({ ...base, gestureActive: true }), timing.cloudSaveQuietMs);
  assert.equal(cloudSaveHoldDelay({ ...base, heldMs: timing.cloudSaveMaxHoldMs }), 0, "保留上限を超えたら保存する");
  assert.equal(
    cloudSaveHoldDelay({ ...base, heldMs: timing.cloudSaveMaxHoldMs, gestureActive: true }),
    timing.cloudSaveQuietMs,
    "保留上限を超えても画の途中には始めない"
  );
  assert.equal(cloudSaveHoldDelay({ now: 5_000, lastInputAt: 0 }), 0, "書込み履歴がなければすぐ保存する");
});

test("編集中ページのサムネイル更新は未確定strokeがなく十分に休止してから行う", () => {
  const base = { now: 30_000, lastInputAt: 30_000 - timing.thumbnailQuietMs };
  assert.equal(thumbnailRefreshDelay(base), 0);
  assert.equal(thumbnailRefreshDelay({ ...base, strokesPending: true }), timing.thumbnailQuietMs);
  assert.equal(thumbnailRefreshDelay({ ...base, gestureActive: true }), timing.thumbnailQuietMs);
  assert.equal(thumbnailRefreshDelay({ ...base, lastInputAt: 29_000 }), timing.thumbnailQuietMs - 1_000);
});

test("書込み中の保存・再描画は休止判定の順にflush、クラウド保存、サムネイルとなる", () => {
  assert.ok(timing.strokeFlushQuietMs < timing.cloudSaveQuietMs);
  assert.ok(timing.cloudSaveQuietMs < timing.thumbnailQuietMs);
  assert.ok(timing.strokeFlushAfterLiftMs < 50, "ペンを離した直後の短い間に収める");
});
