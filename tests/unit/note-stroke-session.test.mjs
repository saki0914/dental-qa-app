import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPointerSamples,
  createStrokeRecoveryCooldown,
  createStrokeSession,
  delayedPointerdownJoinsRecoveredSession,
  flushStrokePoints,
  recoverableStrokeMove,
  strokeSessionOwnsPointer
} from "../../js/core/note-stroke-session.js";
import { cancelledStrokeCanBeCommitted } from "../../js/core/note-transient-ui.js";

const point = event => ({ x: event.clientX / 100, y: event.clientY / 100, pressure: event.pressure });

test("coalesced events and the terminal pointer event are kept once in timestamp order", () => {
  const session = createStrokeSession({
    id: "stroke-1", pointerId: 7, pointerType: "pen", tool: "pen",
    firstPoint: { x: .1, y: .1, pressure: .5 }, startedAt: 1
  });
  const middle = { clientX: 20, clientY: 20, pressure: .4, timeStamp: 2 };
  const terminal = {
    clientX: 30, clientY: 30, pressure: .6, timeStamp: 3,
    getCoalescedEvents: () => [middle, middle]
  };
  appendPointerSamples(session, terminal, point);
  const points = flushStrokePoints(session);
  assert.equal(points.length, 3);
  assert.deepEqual(points.map(value => [value.x, value.y]), [[.1, .1], [.2, .2], [.3, .3]]);
  assert.equal(session.coalescedPointCount, 2);
});

test("pointermoveなしでもpointerup終端を採取して短い1画を描画可能にする", () => {
  const session = createStrokeSession({
    id: "stroke-2", pointerId: 8, pointerType: "pen", tool: "pen",
    firstPoint: { x: .4, y: .4, pressure: .5 }, startedAt: 1
  });
  appendPointerSamples(session, {
    pointerId: 8, clientX: 44, clientY: 43, pressure: 0, timeStamp: 2
  }, point);
  const points = flushStrokePoints(session);
  assert.equal(points.length, 2);
  assert.deepEqual(points.map(value => [value.x, value.y]), [[.4, .4], [.44, .43]]);
});

test("同一session内でpointermoveが同じ座標を再通知しても1点だけ保持する", () => {
  const session = createStrokeSession({
    id: "stroke-dot", pointerId: 18, pointerType: "pen", tool: "pen",
    firstPoint: { x: .4, y: .4, pressure: .5 }, startedAt: 1
  });
  appendPointerSamples(session, {
    pointerId: 18, clientX: 40, clientY: 40, pressure: .5, timeStamp: 2
  }, point);
  assert.equal(flushStrokePoints(session).length, 1);
});

test("pointercancel終端のcoalesced点を既存の安全判定へ渡す", () => {
  const session = createStrokeSession({
    id: "stroke-3", pointerId: 9, pointerType: "pen", tool: "pen",
    firstPoint: { x: .5, y: .5, pressure: .5 }, startedAt: 1
  });
  appendPointerSamples(session, {
    pointerId: 9, clientX: 54, clientY: 54, pressure: 0, timeStamp: 3,
    getCoalescedEvents: () => [{ pointerId: 9, clientX: 52, clientY: 51, pressure: .4, timeStamp: 2 }]
  }, point);
  const points = flushStrokePoints(session);
  assert.equal(cancelledStrokeCanBeCommitted({
    type: "pen", pointerType: "pen", reason: "pointercancel", points
  }), true);
});

test("別sessionの同一座標・同一timestampは別strokeの最初の点として保持する", () => {
  const first = createStrokeSession({
    id: "same-1", pointerId: 20, pointerType: "pen", tool: "pen",
    firstPoint: { x: .25, y: .4, pressure: .5 }, startedAt: 100
  });
  const second = createStrokeSession({
    id: "same-2", pointerId: 20, pointerType: "pen", tool: "pen",
    firstPoint: { x: .25, y: .4, pressure: .5 }, startedAt: 100
  });
  assert.equal(first.points.length, 1);
  assert.equal(second.points.length, 1);
  assert.notEqual(first.acceptedSamples, second.acceptedSamples);
});

test("pointermove先着で復元したsessionへ遅延pointerdownを同じpointerId・sessionIdのまま合流する", () => {
  const move = {
    type: "pointermove", pointerId: 31, pointerType: "pen", pressure: .5, buttons: 1
  };
  assert.equal(recoverableStrokeMove(move), true);
  assert.equal(recoverableStrokeMove({ ...move, pressure: 0 }), true, "buttonsのprimary bitを接触の一次シグナルにする");
  assert.equal(recoverableStrokeMove({ ...move, buttons: 0 }), true, "pressureはbuttons欠落時の補助シグナルにする");
  assert.equal(recoverableStrokeMove({ ...move, pressure: 0, buttons: 0 }), false, "hoverは復元しない");
  assert.equal(recoverableStrokeMove({ ...move, type: "pointerrawupdate" }), false, "rawupdateは確定sessionを復元しない");

  const session = createStrokeSession({
    id: "recovered-session", pointerId: 31, pointerType: "pen", tool: "pen",
    firstPoint: { x: .2, y: .3, pressure: .5 }, startedAt: 10,
    recoveredFromEvent: "pointermove"
  });
  const delayedDown = { type: "pointerdown", pointerId: 31, pointerType: "pen" };
  assert.equal(strokeSessionOwnsPointer(session, delayedDown), true);
  assert.equal(delayedPointerdownJoinsRecoveredSession(session, delayedDown), true);
  assert.equal(session.strokeSessionId, "recovered-session");
  assert.equal(session.pointerdownObserved, true);
  assert.equal(delayedPointerdownJoinsRecoveredSession(session, delayedDown), true, "重複downも新sessionを作らない");
  assert.equal(delayedPointerdownJoinsRecoveredSession(session, { ...delayedDown, pointerId: 32 }), false);
});

test("終了済みtimestamp以前の残留moveだけを拒否し、同一pointerIdの新しいcontact moveは直ちに許可する", () => {
  let clock = 100;
  const cooldown = createStrokeRecoveryCooldown({ now: () => clock });
  cooldown.notePointerEnd(31, 100);
  assert.equal(cooldown.blocks({ pointerId: 31, timeStamp: 99 }), true);
  assert.equal(cooldown.blocks({ pointerId: 32, timeStamp: 99 }), false);
  cooldown.notePointerdown(31);
  assert.equal(cooldown.blocks({ pointerId: 31, timeStamp: 99 }), false, "次の明示pointerdownは同じpointerIdを再利用できる");
  cooldown.notePointerEnd(31, 100);
  assert.equal(cooldown.blocks({ pointerId: 31, timeStamp: 101 }), false, "新しい物理接触のmove先着をwall-clockで拒否しない");
  cooldown.notePointerEnd(31, 110);
  clock = 101;
  assert.equal(cooldown.blocks({ pointerId: 31, timeStamp: 111 }), false, "同一pointerIdを使う高速な次strokeも復元できる");
});

test("新しいpointermove後に遅れて届いた古いsampleは点列を逆行させない", () => {
  const session = createStrokeSession({
    id: "ordered", pointerId: 41, pointerType: "pen", tool: "pen",
    firstPoint: { x: .1, y: .1, pressure: .5 }, startedAt: 10
  });
  appendPointerSamples(session, {
    pointerId: 41, clientX: 40, clientY: 40, pressure: .5, timeStamp: 30
  }, point);
  appendPointerSamples(session, {
    pointerId: 41, clientX: 20, clientY: 20, pressure: .5, timeStamp: 20
  }, point);
  const points = flushStrokePoints(session);
  assert.deepEqual(points.map(value => [value.x, value.y]), [[.1, .1], [.4, .4]]);
});

test("1点だけ受信したPencil strokeもcancel・lost capture時に確定対象となる", () => {
  const session = createStrokeSession({
    id: "stroke-dot", pointerId: 21, pointerType: "pen", tool: "pen",
    firstPoint: { x: .4, y: .6, pressure: .5 }, startedAt: 1
  });
  const points = flushStrokePoints(session, { ensureRenderable: true });
  assert.equal(points.length, 1);
  assert.equal(cancelledStrokeCanBeCommitted({
    type: "pen", pointerType: "pen", reason: "pointercancel", points
  }), true);
  assert.equal(cancelledStrokeCanBeCommitted({
    type: "pen", pointerType: "pen", reason: "lostpointercapture", points
  }), true);
  for (const reason of ["tool-change", "page-change", "close", "pagezoomstart"]) {
    assert.equal(cancelledStrokeCanBeCommitted({
      type: "pen", pointerType: "pen", reason, points
    }), false, `${reason}は1点strokeを確定しない`);
  }
  assert.equal(cancelledStrokeCanBeCommitted({
    type: "pen", pointerType: "pen", reason: "explicit-discard", points
  }), false);
});
