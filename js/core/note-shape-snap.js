// What a pen or highlighter stroke held still at its end becomes (revision 17;
// the hold itself is note-straightener.js). Holding used to make every stroke
// a straight line. Now a stroke that goes round and closes becomes a circle
// (an ellipse when it is clearly longer one way), one with sharp corners a
// polyline such as an L (closed: a triangle, a rectangle or another polygon)
// and a roughly straight one a straight line; any other stroke, such as
// writing, is left as it was written.
//
// Shapes are measured in CSS pixels of the page as it was shown while writing
// (as the smoothing of strokes is), where a circle is round.

import { LEGACY_NOTE_PAGE_SIZE } from "./note-page-metrics.js";

// A corner of a polyline turns the stroke at least this much (degrees); a
// gentler bend is part of a line. Polygons (closed) turn less at a corner.
export const SHAPE_SNAP_CORNER_DEGREES = 45;
export const SHAPE_SNAP_POLYGON_CORNER_DEGREES = 30;
// Sides of polylines and polygons this close to horizontal or vertical
// (degrees) are made exactly so.
export const SHAPE_SNAP_AXIS_DEGREES = 8;
// An ellipse at least this round (short / long radius) is drawn as a circle;
// one tilted this little from upright (degrees) is drawn upright.
export const SHAPE_SNAP_CIRCLE_RATIO = 0.85;
export const SHAPE_SNAP_ELLIPSE_AXIS_DEGREES = 15;
// A straight line strays from its chord at most this share of its length.
export const SHAPE_SNAP_LINE_DEVIATION = 0.2;

const RADIANS = Math.PI / 180;
const COORDINATE_SCALE = 1e5;
const PRESSURE = 0.5;

const finitePoint = point => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = value => Math.min(1, Math.max(0, value));
const roundCoordinate = value => Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;

function pixelScale({ pixelWidth, pixelHeight } = {}) {
  return {
    width: Number(pixelWidth) > 0 ? Number(pixelWidth) : LEGACY_NOTE_PAGE_SIZE.width,
    height: Number(pixelHeight) > 0 ? Number(pixelHeight) : LEGACY_NOTE_PAGE_SIZE.height
  };
}

function toPixels(points, scale) {
  const result = [];
  for (const point of Array.isArray(points) ? points : []) {
    if (!finitePoint(point)) continue;
    const next = { x: Number(point.x) * scale.width, y: Number(point.y) * scale.height };
    const last = result[result.length - 1];
    if (!last || distance(last, next) > 1e-6) result.push(next);
  }
  return result;
}

function cumulativeLengths(path) {
  const lengths = [0];
  for (let index = 1; index < path.length; index += 1) lengths.push(lengths[index - 1] + distance(path[index - 1], path[index]));
  return lengths;
}

// Points every `spacing` px along the path (its first and last point kept).
function resample(path, spacing) {
  const lengths = cumulativeLengths(path);
  const total = lengths[lengths.length - 1];
  const count = Math.max(2, Math.round(total / spacing) + 1);
  const step = total / (count - 1);
  const result = [];
  let segment = 1;
  for (let index = 0; index < count; index += 1) {
    const target = index * step;
    while (segment < path.length - 1 && lengths[segment] < target) segment += 1;
    const from = path[segment - 1];
    const to = path[segment];
    const span = lengths[segment] - lengths[segment - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (target - lengths[segment - 1]) / span)) : 0;
    result.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  result[0] = { ...path[0] };
  result[result.length - 1] = { ...path[path.length - 1] };
  return result;
}

function distanceToSegment(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 0)) return distance(point, from);
  const t = Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

// Ramer–Douglas–Peucker: the indices of the points that keep the path within
// `epsilon` px.
function simplify(path, epsilon) {
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let farthest = epsilon;
    let index = -1;
    for (let candidate = first + 1; candidate < last; candidate += 1) {
      const gap = distanceToSegment(path[candidate], path[first], path[last]);
      if (gap > farthest) {
        farthest = gap;
        index = candidate;
      }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const indices = [];
  keep.forEach((kept, index) => { if (kept) indices.push(index); });
  return indices;
}

// How much the direction turns at `at` (degrees, 0–180).
function turnDegrees(from, at, to) {
  const before = Math.atan2(at.y - from.y, at.x - from.x);
  const after = Math.atan2(to.y - at.y, to.x - at.x);
  let turn = Math.abs(after - before) % (2 * Math.PI);
  if (turn > Math.PI) turn = 2 * Math.PI - turn;
  return turn / RADIANS;
}

// Path points from index `from` to `to` (going on past the end of a loop).
function pathBetween(path, from, to, cyclic) {
  if (!cyclic || to >= from) return path.slice(from, to + 1);
  return [...path.slice(from), ...path.slice(0, to + 1)];
}

function arcLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

// The corners of a simplified path: vertices where the stroke turns sharply,
// with the gentler vertices removed one at a time, and those of sides too
// short to be meant (a hook where the pen landed). At a corner the halves of
// the two sides next to it turn almost as much as the whole sides; along a
// curve they turn half as much (and noise hardly moves halves of sides).
// Each vertex is first moved to where those halves turn most: the
// simplification may keep a point just before a (slightly rounded) corner.
function cornerVertices(path, indices, { cyclic, minTurn, total }) {
  let vertices = cyclic ? indices.slice(0, -1) : [...indices];
  const minimumSide = Math.max(8, total * (cyclic ? 0.035 : 0.08));
  const sideLength = (from, to) => arcLength(pathBetween(path, from, to, cyclic));
  const wrap = index => ((index % path.length) + path.length) % path.length;
  const steps = (from, to) => cyclic ? wrap(to - from) : to - from;
  // The turn between the halves of the sides at `at`, between `previous`
  // and `next`.
  const halvesTurn = (previous, at, next) => {
    const reach = Math.floor(Math.min(steps(previous, at), steps(at, next)) / 2);
    if (reach < 1) return 0;
    const point = index => path[cyclic ? wrap(index) : index];
    return turnDegrees(point(at - reach), path[at], point(at + reach));
  };
  for (let position = cyclic ? 0 : 1; position < (cyclic ? vertices.length : vertices.length - 1); position += 1) {
    const count = vertices.length;
    const previous = vertices[(position - 1 + count) % count];
    const current = vertices[position];
    const next = vertices[(position + 1) % count];
    const reach = Math.max(1, Math.round(Math.min(steps(previous, current), steps(current, next)) * 0.3));
    let best = current;
    let bestTurn = halvesTurn(previous, current, next);
    for (let offset = -reach; offset <= reach; offset += 1) {
      const candidate = cyclic ? wrap(current + offset) : current + offset;
      if (steps(previous, candidate) < 1 || steps(candidate, next) < 1) continue;
      if (!cyclic && (candidate <= previous || candidate >= next)) continue;
      const turn = halvesTurn(previous, candidate, next);
      if (turn > bestTurn) {
        best = candidate;
        bestTurn = turn;
      }
    }
    vertices[position] = best;
  }
  const isCorner = position => {
    const count = vertices.length;
    const previous = vertices[(position - 1 + count) % count];
    const current = vertices[position];
    const next = vertices[(position + 1) % count];
    const turn = turnDegrees(path[previous], path[current], path[next]);
    return { corner: turn >= minTurn && halvesTurn(previous, current, next) >= turn * 0.75, turn };
  };
  for (;;) {
    const count = vertices.length;
    if (count < 3) break;
    let weakest = -1;
    let weakestTurn = Infinity;
    const first = cyclic ? 0 : 1;
    const last = cyclic ? count - 1 : count - 2;
    for (let position = first; position <= last; position += 1) {
      const { corner, turn } = isCorner(position);
      if (!corner && turn < weakestTurn) {
        weakest = position;
        weakestTurn = turn;
      }
    }
    if (weakest < 0) {
      // Sides too short: the first or last side of an open path goes with
      // its outer vertex; other short sides with their gentler vertex. A
      // short end that turns back is a hook of the pen landing or stopping.
      const tooShort = position => {
        const length = sideLength(vertices[position], vertices[(position + 1) % count]);
        if (length < minimumSide) return true;
        if (cyclic || (position !== 0 && position !== count - 2) || length >= total * 0.15) return false;
        return isCorner(position === 0 ? 1 : count - 2).turn >= 110;
      };
      let short = -1;
      for (let position = 0; position < (cyclic ? count : count - 1); position += 1) {
        if (tooShort(position)) {
          short = position;
          break;
        }
      }
      if (short < 0) break;
      if (!cyclic && short === 0) vertices.splice(1, 1);
      else if (!cyclic && short === count - 2) vertices.splice(count - 2, 1);
      else {
        const a = short;
        const b = (short + 1) % count;
        const turnAt = position => isCorner(position).turn;
        vertices.splice(turnAt(a) <= turnAt(b) ? a : b, 1);
      }
      continue;
    }
    vertices.splice(weakest, 1);
  }
  return vertices;
}

// The straight line through `points` (total least squares), or null.
function fitLine(points) {
  if (points.length < 2) return null;
  let x = 0;
  let y = 0;
  points.forEach(point => { x += point.x; y += point.y; });
  x /= points.length;
  y /= points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  points.forEach(point => {
    xx += (point.x - x) ** 2;
    yy += (point.y - y) ** 2;
    xy += (point.x - x) * (point.y - y);
  });
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { point: { x, y }, direction: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function intersectLines(first, second) {
  const cross = first.direction.x * second.direction.y - first.direction.y * second.direction.x;
  if (Math.abs(cross) < Math.sin(10 * RADIANS)) return null;
  const dx = second.point.x - first.point.x;
  const dy = second.point.y - first.point.y;
  const t = (dx * second.direction.y - dy * second.direction.x) / cross;
  return { x: first.point.x + first.direction.x * t, y: first.point.y + first.direction.y * t };
}

// Each side's points, without the ends near the corners.
function sideLine(path, from, to, cyclic) {
  const points = pathBetween(path, from, to, cyclic);
  const trim = Math.floor(points.length * 0.15);
  const middle = points.length - 2 * trim >= 3 ? points.slice(trim, points.length - trim) : points;
  return fitLine(middle);
}

// Sides close to horizontal or vertical are made exactly so (both ends meet
// halfway).
function snapSidesToAxes(vertices, cyclic) {
  const snapped = vertices.map(vertex => ({ ...vertex }));
  const sides = cyclic ? snapped.length : snapped.length - 1;
  for (let side = 0; side < sides; side += 1) {
    const from = snapped[side];
    const to = snapped[(side + 1) % snapped.length];
    const angle = Math.abs(Math.atan2(to.y - from.y, to.x - from.x)) / RADIANS;
    const fromHorizontal = Math.min(angle, 180 - angle);
    if (fromHorizontal <= SHAPE_SNAP_AXIS_DEGREES) {
      const y = (from.y + to.y) / 2;
      from.y = y;
      to.y = y;
    } else if (Math.abs(angle - 90) <= SHAPE_SNAP_AXIS_DEGREES) {
      const x = (from.x + to.x) / 2;
      from.x = x;
      to.x = x;
    }
  }
  return snapped;
}

function polygonalShape(path, { cyclic, total, diagonal }) {
  const epsilon = Math.max(5, diagonal * (cyclic ? 0.05 : 0.04));
  const indices = simplify(path, epsilon);
  const vertices = cornerVertices(path, indices, {
    cyclic,
    minTurn: cyclic ? SHAPE_SNAP_POLYGON_CORNER_DEGREES : SHAPE_SNAP_CORNER_DEGREES,
    total
  });
  const count = vertices.length;
  if (cyclic ? count < 3 || count > 6 : count < 3 || count > 7) return null;
  const sides = cyclic ? count : count - 1;
  const lines = [];
  for (let side = 0; side < sides; side += 1) lines.push(sideLine(path, vertices[side], vertices[(side + 1) % count], cyclic));
  // Corners where the sides meet (a rounded corner of the hand becomes sharp).
  const corners = vertices.map((index, position) => {
    const original = path[index];
    if (!cyclic && (position === 0 || position === count - 1)) return { ...original };
    const before = lines[(position - 1 + sides) % sides];
    const after = lines[position % sides];
    const meeting = before && after ? intersectLines(before, after) : null;
    return meeting && distance(meeting, original) <= Math.max(epsilon * 2, 12) ? meeting : { ...original };
  });
  // Every side has to be straight: within its tolerance of the corners' line.
  for (let side = 0; side < sides; side += 1) {
    const from = corners[side];
    const to = corners[(side + 1) % count];
    const tolerance = Math.max(epsilon, distance(from, to) * 0.12);
    const points = pathBetween(path, vertices[side], vertices[(side + 1) % count], cyclic);
    if (points.some(point => distanceToSegment(point, from, to) > tolerance)) return null;
  }
  return { kind: cyclic ? "polygon" : "polyline", vertices: snapSidesToAxes(corners, cyclic) };
}

// The ellipse with the area moments of the closed path (a filled ellipse of
// radii a, b has mean squares a²/4 and b²/4 along its axes), or null.
function momentEllipse(loop) {
  const origin = loop[0];
  let doubleArea = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = { x: loop[index].x - origin.x, y: loop[index].y - origin.y };
    const next = loop[(index + 1) % loop.length];
    const b = { x: next.x - origin.x, y: next.y - origin.y };
    const cross = a.x * b.y - b.x * a.y;
    doubleArea += cross;
    sumX += (a.x + b.x) * cross;
    sumY += (a.y + b.y) * cross;
    sumXX += (a.x * a.x + a.x * b.x + b.x * b.x) * cross;
    sumYY += (a.y * a.y + a.y * b.y + b.y * b.y) * cross;
    sumXY += (a.x * b.y + 2 * a.x * a.y + 2 * b.x * b.y + b.x * a.y) * cross;
  }
  const area = doubleArea / 2;
  if (!(Math.abs(area) > 1)) return null;
  const centerX = sumX / (6 * area);
  const centerY = sumY / (6 * area);
  const xx = sumXX / (12 * area) - centerX * centerX;
  const yy = sumYY / (12 * area) - centerY * centerY;
  const xy = sumXY / (24 * area) - centerX * centerY;
  const half = (xx + yy) / 2;
  const spread = Math.sqrt(Math.max(0, ((xx - yy) / 2) ** 2 + xy * xy));
  const major = half + spread;
  const minor = half - spread;
  if (!(minor > 0)) return null;
  return {
    center: { x: origin.x + centerX, y: origin.y + centerY },
    radiusX: 2 * Math.sqrt(major),
    radiusY: 2 * Math.sqrt(minor),
    angle: 0.5 * Math.atan2(2 * xy, xx - yy),
    area: Math.abs(area)
  };
}

// The parametric angle of `point` on `ellipse`.
function ellipseAngleOf(ellipse, point) {
  const dx = point.x - ellipse.center.x;
  const dy = point.y - ellipse.center.y;
  const cos = Math.cos(ellipse.angle);
  const sin = Math.sin(ellipse.angle);
  return Math.atan2((-dx * sin + dy * cos) / ellipse.radiusY, (dx * cos + dy * sin) / ellipse.radiusX);
}

function ellipticalShape(loop) {
  const fitted = momentEllipse(loop);
  if (!fitted) return null;
  const cos = Math.cos(fitted.angle);
  const sin = Math.sin(fitted.angle);
  let sum = 0;
  let worst = 0;
  for (const point of loop) {
    const dx = point.x - fitted.center.x;
    const dy = point.y - fitted.center.y;
    const u = (dx * cos + dy * sin) / fitted.radiusX;
    const v = (-dx * sin + dy * cos) / fitted.radiusY;
    const error = Math.abs(Math.hypot(u, v) - 1);
    sum += error;
    worst = Math.max(worst, error);
  }
  const meanError = sum / loop.length;
  if (meanError > 0.075 || worst > 0.25) return null;
  let { radiusX, radiusY, angle } = fitted;
  if (radiusY / radiusX >= SHAPE_SNAP_CIRCLE_RATIO) {
    radiusX = radiusY = (radiusX + radiusY) / 2;
    angle = 0;
  } else {
    // Upright or lying when it nearly is.
    const degrees = angle / RADIANS;
    if (Math.abs(degrees) <= SHAPE_SNAP_ELLIPSE_AXIS_DEGREES) angle = 0;
    else if (Math.abs(Math.abs(degrees) - 90) <= SHAPE_SNAP_ELLIPSE_AXIS_DEGREES) angle = Math.PI / 2;
  }
  const ellipse = { center: fitted.center, radiusX, radiusY, angle };
  // Drawn from where the stroke started, the way it went round.
  const startAngle = ellipseAngleOf(ellipse, loop[0]);
  const ahead = loop[Math.min(loop.length - 1, Math.max(1, Math.round(loop.length / 12)))];
  let turn = ellipseAngleOf(ellipse, ahead) - startAngle;
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  return {
    kind: radiusX === radiusY ? "circle" : "ellipse",
    ...ellipse,
    startAngle,
    direction: turn < 0 ? -1 : 1,
    meanError
  };
}

// Where a stroke going round comes back to its start: the point (in the last
// part of the stroke) nearest to the start when it is close enough.
function closingIndex(path, lengths, total, diagonal) {
  let best = -1;
  let bestGap = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    if (lengths[index] < total * 0.6) continue;
    const gap = distance(path[index], path[0]);
    if (gap < bestGap) {
      best = index;
      bestGap = gap;
    }
  }
  if (best < 0 || bestGap > Math.max(14, diagonal * 0.25)) return -1;
  // It has to go round something: long enough, with an area. What it draws
  // past its start is no more than a little overshoot (a loop with a tail is
  // not a shape).
  if (lengths[best] < diagonal * 1.6 || total - lengths[best] > lengths[best] * 0.25) return -1;
  return best;
}

function straightLine(path, total) {
  const start = path[0];
  const end = path[path.length - 1];
  const chord = distance(start, end);
  if (!(chord > 0) || total > chord * 1.3) return null;
  const tolerance = Math.max(6, chord * SHAPE_SNAP_LINE_DEVIATION);
  if (path.some(point => distanceToSegment(point, start, end) > tolerance)) return null;
  // A wave swings from side to side of its line again and again; a wobbly
  // line does not.
  const fitted = fitLine(path);
  const offsets = path.map(point =>
    fitted.direction.x * (point.y - fitted.point.y) - fitted.direction.y * (point.x - fitted.point.x));
  const swing = Math.max(4, chord * 0.02, Math.max(...offsets.map(Math.abs)) * 0.5);
  let side = 0;
  let crossings = 0;
  for (const offset of offsets) {
    if (Math.abs(offset) < swing) continue;
    const next = Math.sign(offset);
    if (side && next !== side) crossings += 1;
    side = next;
  }
  if (crossings >= 4) return null;
  return { kind: "line", vertices: [{ ...start }, { ...end }] };
}

// The shape a held stroke (points as shares of the page) is meant to be, or
// null to leave it as written. `pixelWidth` and `pixelHeight` are the size
// of the page on the screen while it was written.
export function recognizeStrokeShape(points, options = {}) {
  const scale = pixelScale(options);
  const raw = toPixels(points, scale);
  if (raw.length < 2) return null;
  const rawLength = arcLength(raw);
  const xs = raw.map(point => point.x);
  const ys = raw.map(point => point.y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(diagonal >= 4) || !(rawLength > 0)) return null;
  const spacing = Math.max(1, rawLength / 200);
  const path = resample(raw, spacing);
  const lengths = cumulativeLengths(path);
  const total = lengths[lengths.length - 1];
  let shape = null;
  const closing = closingIndex(path, lengths, total, diagonal);
  if (closing > 0) {
    const loop = path.slice(0, closing + 1);
    const loopLength = lengths[closing];
    const xsLoop = loop.map(point => point.x);
    const ysLoop = loop.map(point => point.y);
    const boxArea = (Math.max(...xsLoop) - Math.min(...xsLoop)) * (Math.max(...ysLoop) - Math.min(...ysLoop));
    const ellipse = momentEllipse(loop);
    // Going over the same line and back encloses next to nothing.
    if (ellipse && ellipse.area >= boxArea * 0.15 && ellipse.radiusY >= Math.max(4, ellipse.radiusX * 0.08)) {
      // A stroke this close to an ellipse is one, however its jitter turns;
      // otherwise sharp corners make a polygon.
      const elliptical = ellipticalShape(loop);
      shape = elliptical && elliptical.meanError <= 0.04
        ? elliptical
        : polygonalShape(loop, { cyclic: true, total: loopLength, diagonal }) || elliptical;
    }
  } else {
    shape = polygonalShape(path, { cyclic: false, total, diagonal }) || straightLine(path, total);
  }
  return shape ? { ...shape, scale } : null;
}

function toPagePoint(point) {
  return { x: roundCoordinate(clamp01(point.x)), y: roundCoordinate(clamp01(point.y)), pressure: PRESSURE };
}

// The pen's end (a share of the page) moved after the shape was made: lines
// and polylines follow it with their last corner (a last side close to
// horizontal or vertical stays so); closed shapes keep their form.
function withMovedEnd(shape, end) {
  if (!end || !finitePoint(end) || !["line", "polyline"].includes(shape.kind)) return shape.vertices;
  const vertices = shape.vertices.map(vertex => ({ ...vertex }));
  const moved = { x: Number(end.x) * shape.scale.width, y: Number(end.y) * shape.scale.height };
  if (shape.kind === "polyline") {
    const previous = vertices[vertices.length - 2];
    const angle = Math.abs(Math.atan2(moved.y - previous.y, moved.x - previous.x)) / RADIANS;
    if (Math.min(angle, 180 - angle) <= SHAPE_SNAP_AXIS_DEGREES) moved.y = previous.y;
    else if (Math.abs(angle - 90) <= SHAPE_SNAP_AXIS_DEGREES) moved.x = previous.x;
  }
  vertices[vertices.length - 1] = moved;
  return vertices;
}

// The stroke's points (shares of the page) that draw `shape`: corners are
// given twice, which keeps them sharp in the curve every surface draws
// through the midpoints of the points (note-stroke.js).
export function shapeStrokePoints(shape, end = null) {
  if (!shape?.scale) return [];
  const { width, height } = shape.scale;
  const toPage = point => toPagePoint({ x: point.x / width, y: point.y / height });
  if (shape.kind === "circle" || shape.kind === "ellipse") {
    const { center, radiusX, radiusY, angle, startAngle, direction } = shape;
    const perimeter = Math.PI * (3 * (radiusX + radiusY) - Math.sqrt((3 * radiusX + radiusY) * (radiusX + 3 * radiusY)));
    const count = Math.min(144, Math.max(36, Math.round(perimeter / 8)));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points = [];
    for (let index = 0; index <= count; index += 1) {
      const t = startAngle + direction * 2 * Math.PI * (index % count) / count;
      const u = radiusX * Math.cos(t);
      const v = radiusY * Math.sin(t);
      points.push(toPage({ x: center.x + u * cos - v * sin, y: center.y + u * sin + v * cos }));
    }
    return points;
  }
  const vertices = withMovedEnd(shape, end);
  if (shape.kind === "line") return vertices.map(toPage);
  const points = [toPage(vertices[0])];
  for (let index = 1; index < vertices.length; index += 1) {
    const vertex = toPage(vertices[index]);
    points.push(vertex);
    if (index < vertices.length - 1) points.push({ ...vertex });
  }
  if (shape.kind === "polygon") {
    points.push({ ...points[points.length - 1] });
    points.push({ ...points[0] });
  }
  return points;
}
