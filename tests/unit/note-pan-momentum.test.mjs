import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_PAN_MOMENTUM_DEFAULTS,
  createPanMomentum,
  momentumStep,
  panReleaseVelocity
} from "../../js/core/note-pan-momentum.js";

function createViewport({ maxLeft = 0, maxTop = 2000, left = 0, top = 0 } = {}) {
  let scrollLeft = left;
  let scrollTop = top;
  return {
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(value) { scrollLeft = Math.round(Math.max(0, Math.min(maxLeft, value))); },
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.round(Math.max(0, Math.min(maxTop, value))); }
  };
}

function createFrames() {
  const queue = [];
  let clock = 0;
  return {
    now: () => clock,
    requestFrame: callback => { queue.push(callback); return queue.length; },
    cancelFrame: () => { queue.length = 0; },
    // Runs frames 16 ms apart until the motion stops (or `limit` frames).
    run(limit = 2000) {
      let frames = 0;
      while (queue.length && frames < limit) {
        clock += 16;
        queue.shift()(clock);
        frames += 1;
      }
      return frames;
    },
    get pending() { return queue.length; }
  };
}

test("指を離す直前の速度を最後の100ms分の移動から求める", () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 0, y: 40, t: 100 },
    { x: 0, y: 140, t: 150 },
    { x: 0, y: 240, t: 200 }
  ];
  const velocity = panReleaseVelocity(samples);
  assert.equal(velocity.x, 0);
  assert.equal(velocity.y, 2);
  // A finger that rested before lifting has almost no speed left.
  const rested = panReleaseVelocity([...samples, { x: 0, y: 241, t: 400 }]);
  assert.ok(Math.abs(rested.y) < 0.01);
  assert.deepEqual(panReleaseVelocity([{ x: 1, y: 1, t: 0 }]), { x: 0, y: 0 });
});

test("慣性は1msごとに一定の割合で減速し、移動量は速度の積分に一致する", () => {
  const { dx, dy, velocity } = momentumStep({ x: 1, y: -2 }, 100);
  const decay = NOTE_PAN_MOMENTUM_DEFAULTS.deceleration ** 100;
  assert.ok(Math.abs(velocity.x - decay) < 1e-12);
  assert.ok(Math.abs(velocity.y + 2 * decay) < 1e-12);
  // About 90 px in the first 100 ms at 1 px/ms with this deceleration.
  assert.ok(dx > 85 && dx < 100, String(dx));
  assert.ok(Math.abs(dy + 2 * dx) < 1e-9);
});

test("指を上へはじくとページは下へ流れて減速しながら止まり、端では止まる", () => {
  const frames = createFrames();
  const viewport = createViewport({ maxTop: 5000, top: 1000 });
  const momentum = createPanMomentum({ viewport, ...frames });

  assert.equal(momentum.start({ x: 0, y: -2 }), true);
  assert.equal(momentum.active, true);
  frames.run();
  assert.equal(momentum.active, false);
  // 2 px/ms at 0.998/ms carries the page about 2 / -ln(0.998) ≈ 1000 px.
  assert.ok(viewport.scrollTop > 1900 && viewport.scrollTop < 2050, String(viewport.scrollTop));

  // Near the end of the content the motion stops at the edge.
  const nearEnd = createViewport({ maxTop: 300, top: 250 });
  const edge = createPanMomentum({ viewport: nearEnd, ...frames });
  edge.start({ x: 0, y: -3 });
  const used = frames.run();
  assert.equal(nearEnd.scrollTop, 300);
  assert.equal(edge.active, false);
  assert.ok(used < 10, String(used));
});

test("遅い指の離し方では慣性を始めず、新しい操作で慣性を止める", () => {
  const frames = createFrames();
  const viewport = createViewport({ maxTop: 5000, top: 1000 });
  const momentum = createPanMomentum({ viewport, ...frames });

  assert.equal(momentum.start({ x: 0, y: -0.05 }), false);
  assert.equal(frames.pending, 0);
  assert.equal(viewport.scrollTop, 1000);

  momentum.start({ x: 0, y: -2 });
  frames.run(3);
  const stoppedAt = viewport.scrollTop;
  momentum.stop();
  assert.equal(momentum.active, false);
  frames.run();
  assert.equal(viewport.scrollTop, stoppedAt);
});

test("小数の移動量もためて反映し、ゆっくりした慣性でも途中で止まらない", () => {
  const frames = createFrames();
  const viewport = createViewport({ maxLeft: 4000, left: 100, maxTop: 0 });
  const momentum = createPanMomentum({ viewport, ...frames });
  momentum.start({ x: -0.2, y: 0 });
  frames.run();
  // 0.2 px/ms moves about 100 px in all, although each frame moves < 4 px.
  assert.ok(viewport.scrollLeft > 180 && viewport.scrollLeft < 205, String(viewport.scrollLeft));
});
