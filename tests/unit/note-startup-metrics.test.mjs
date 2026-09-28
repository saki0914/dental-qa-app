import assert from "node:assert/strict";
import test from "node:test";
import { createNoteStartupMetrics } from "../../js/core/note-startup-metrics.js";

test("ノート起動計測はタップからnavigationまでと各phaseを分離する", () => {
  let clock = 25;
  let published;
  const metrics = createNoteStartupMetrics({
    now: () => clock,
    timeOrigin: 1_000,
    launchAtEpochMs: 900,
    navigationType: "navigate",
    publish: value => { published = value; }
  });
  metrics.mark("app-module-evaluated");
  const end = metrics.startSpan("firebase-initialization", { emulator: false });
  clock = 75.26;
  end({ connected: true });
  metrics.increment("conflicts-detected", 2);
  metrics.setContext({ noteType: "pdf-imported", pageCount: 40 });

  assert.equal(published.launchToNavigationMs, 100);
  assert.equal(published.marks[0].atMs, 25);
  assert.equal(published.marks[0].sinceLaunchMs, 125);
  assert.equal(published.spans[0].durationMs, 50.3);
  assert.deepEqual(published.spans[0].details, { emulator: false, connected: true });
  assert.equal(published.counters["conflicts-detected"], 2);
  assert.deepEqual(published.context, { noteType: "pdf-imported", pageCount: 40 });
});

test("reloadと古いURL timestampはタップ時刻として採用しない", () => {
  const reload = createNoteStartupMetrics({
    now: () => 10,
    timeOrigin: 1_000,
    launchAtEpochMs: 900,
    navigationType: "reload"
  });
  const stale = createNoteStartupMetrics({
    now: () => 10,
    timeOrigin: 1_000_000,
    launchAtEpochMs: 1,
    navigationType: "navigate"
  });
  assert.equal(reload.snapshot().launchToNavigationMs, 0);
  assert.equal(stale.snapshot().launchToNavigationMs, 0);
});

test("無効化した計測は呼び出し側の分岐なしで使える", () => {
  const metrics = createNoteStartupMetrics({ enabled: false });
  const end = metrics.startSpan("ignored");
  assert.equal(metrics.mark("ignored"), null);
  assert.equal(end(), null);
  assert.deepEqual(metrics.snapshot().marks, []);
  assert.deepEqual(metrics.snapshot().spans, []);
});
