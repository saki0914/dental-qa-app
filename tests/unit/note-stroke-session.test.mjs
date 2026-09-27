import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPointerSamples,
  copyStrokePointsForCommit,
  createStrokeSession,
  flushStrokePoints
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

test("確定ストロークはgestureの点配列と各点を共有しない", () => {
  const gesturePoints = [
    { x: .1, y: .2, pressure: .4 },
    { x: .7, y: .8, pressure: .6 }
  ];
  const committedPoints = copyStrokePointsForCommit(gesturePoints);

  gesturePoints.push({ x: .9, y: .9, pressure: .5 });
  gesturePoints[0].x = .5;

  assert.deepEqual(committedPoints, [
    { x: .1, y: .2, pressure: .4 },
    { x: .7, y: .8, pressure: .6 }
  ]);
});
