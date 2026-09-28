import { LEGACY_NOTE_PAGE_SIZE } from "./note-page-metrics.js";

function normalizedPressure(value) {
  const pressure = Number(value);
  return Number.isFinite(pressure) && pressure > 0 ? Math.min(1, Math.max(0.05, pressure)) : 0.5;
}

export function strokeSegments(points, baseWidth, pressureEnabled = false) {
  const source = Array.isArray(points) ? points : [];
  const width = Math.max(0.0001, Number(baseWidth) || 0.0001);
  if (source.length === 1) return [{ start: source[0], end: source[0], width, dot: true }];
  return source.slice(1).map((end, index) => {
    const start = source[index];
    const pressure = pressureEnabled
      ? (normalizedPressure(start.pressure) + normalizedPressure(end.pressure)) / 2
      : 0.5;
    return {
      start,
      end,
      width: pressureEnabled ? width * Math.max(0.35, pressure * 1.7) : width
    };
  });
}

export function strokeSvgNodes(svgFactory, points, baseWidth, options = {}) {
  const {
    pressureEnabled = false,
    scaleX = 1000,
    scaleY = 1414,
    attributes = {}
  } = options;
  return strokeSegments(points, baseWidth, pressureEnabled).map(segment => segment.dot
    ? svgFactory("circle", {
      cx: segment.start.x * scaleX,
      cy: segment.start.y * scaleY,
      r: Math.max(0.5, segment.width * scaleX / 2),
      fill: attributes.stroke || attributes.fill || "currentColor",
      "fill-opacity": attributes["stroke-opacity"] ?? attributes["fill-opacity"] ?? 1,
      ...Object.fromEntries(Object.entries(attributes).filter(([key]) => !["fill", "fill-opacity", "stroke", "stroke-opacity"].includes(key)))
    })
    : svgFactory("line", {
      x1: segment.start.x * scaleX,
      y1: segment.start.y * scaleY,
      x2: segment.end.x * scaleX,
      y2: segment.end.y * scaleY,
      "stroke-width": Math.max(1, segment.width * scaleX),
      "stroke-linecap": "round",
      ...attributes
    }));
}

export function drawStrokeSegments(context, points, baseWidth, width, height, options = {}) {
  const { pressureEnabled = false } = options;
  for (const segment of strokeSegments(points, baseWidth, pressureEnabled)) {
    context.beginPath();
    context.lineWidth = Math.max(1, segment.width * width);
    if (segment.dot) {
      context.arc(segment.start.x * width, segment.start.y * height, context.lineWidth / 2, 0, Math.PI * 2);
      const previousFill = context.fillStyle;
      context.fillStyle = context.strokeStyle;
      context.fill();
      context.fillStyle = previousFill;
    } else {
      context.moveTo(segment.start.x * width, segment.start.y * height);
      context.lineTo(segment.end.x * width, segment.end.y * height);
      context.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Stroke geometry
//
// Apple Pencil delivers up to 240 samples per second. Drawn as straight
// segments, digitizer and hand jitter between neighbouring samples shows up as
// a slightly shaky line, and stored raw (17 significant digits per value) the
// samples make every save, clone and render of a written page heavier.
// Strokes are therefore smoothed along their length (the draft and the
// committed stroke alike), thinned and rounded when they are committed, and
// every surface (draft, SVG page, thumbnail, PDF) draws the same quadratic
// curve through the midpoints of consecutive points.
//
// The jitter comes from the screen, so smoothing and thinning are measured in
// CSS pixels of the page as it was shown while writing (pixelWidth and
// pixelHeight of the page rectangle). Without them one page unit counts as one
// pixel.

// 1e-5 of the page is about 0.01 px on a 1240 px wide page.
const COORDINATE_SCALE = 1e5;
const PRESSURE_SCALE = 1e2;
export const STROKE_SMOOTHING_SIGMA_PX = 0.9;
export const STROKE_MIN_POINT_SPACING_PX = 1;
const LENGTH_EPSILON = 1e-9;

const roundTo = (value, scale) => Math.round(Number(value) * scale) / scale;
const finitePoint = point => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));

function strokePixelScale({ pixelWidth, pixelHeight } = {}) {
  return {
    width: Number(pixelWidth) > 0 ? Number(pixelWidth) : LEGACY_NOTE_PAGE_SIZE.width,
    height: Number(pixelHeight) > 0 ? Number(pixelHeight) : LEGACY_NOTE_PAGE_SIZE.height
  };
}

function roundStrokePoint(point) {
  const rounded = { ...point, x: roundTo(point.x, COORDINATE_SCALE), y: roundTo(point.y, COORDINATE_SCALE) };
  if (point.pressure != null && Number.isFinite(Number(point.pressure))) {
    rounded.pressure = roundTo(point.pressure, PRESSURE_SCALE);
  }
  return rounded;
}

// Gaussian smoothing along the arc length of the stroke (sigmaPx in pixels).
// Each neighbour is weighted by the length of stroke it stands for, so the
// dense samples of a slowing pen do not pull the average. The window stays
// symmetric and shrinks towards the ends, which keeps the first and last
// point in place and the stroke from shortening. Samples spaced wider than
// about three sigma (a fast stroke) are left as they are, so shapes and
// corners written at speed keep their form.
export function smoothStrokePoints(points, {
  pixelWidth,
  pixelHeight,
  sigmaPx = STROKE_SMOOTHING_SIGMA_PX
} = {}) {
  const source = Array.isArray(points) ? points.filter(finitePoint) : [];
  const count = source.length;
  const sigma = Number(sigmaPx);
  if (count < 3 || !(sigma > 0)) return source.map(point => ({ ...point }));
  const scale = strokePixelScale({ pixelWidth, pixelHeight });
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const lengths = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    xs[index] = Number(source[index].x);
    ys[index] = Number(source[index].y);
    if (index) {
      lengths[index] = lengths[index - 1] +
        Math.hypot((xs[index] - xs[index - 1]) * scale.width, (ys[index] - ys[index - 1]) * scale.height);
    }
  }
  const total = lengths[count - 1];
  const radius = 3 * sigma;
  const falloff = 1 / (2 * sigma * sigma);
  const smoothed = new Array(count);
  smoothed[0] = { ...source[0] };
  smoothed[count - 1] = { ...source[count - 1] };
  // Both window bounds only move forward along the stroke.
  let low = 0;
  let high = 0;
  for (let index = 1; index < count - 1; index += 1) {
    const reach = Math.min(radius, lengths[index], total - lengths[index]);
    if (!(reach > 0)) {
      smoothed[index] = { ...source[index] };
      continue;
    }
    while (lengths[low] < lengths[index] - reach - LENGTH_EPSILON) low += 1;
    if (high < index) high = index;
    while (high + 1 < count && lengths[high + 1] <= lengths[index] + reach + LENGTH_EPSILON) high += 1;
    let weightSum = 0;
    let x = 0;
    let y = 0;
    for (let neighbour = low; neighbour <= high; neighbour += 1) {
      const offset = lengths[neighbour] - lengths[index];
      const span = (lengths[Math.min(count - 1, neighbour + 1)] - lengths[Math.max(0, neighbour - 1)]) / 2;
      const weight = Math.exp(-offset * offset * falloff) * span;
      weightSum += weight;
      x += weight * xs[neighbour];
      y += weight * ys[neighbour];
    }
    smoothed[index] = weightSum > 0
      ? { ...source[index], x: x / weightSum, y: y / weightSum }
      : { ...source[index] };
  }
  return smoothed;
}

// Smooths the stroke, drops points closer than minSpacingPx to the last kept
// one (the final point always survives) and rounds what remains for storage.
export function prepareStrokePointsForCommit(points, {
  pixelWidth,
  pixelHeight,
  sigmaPx = STROKE_SMOOTHING_SIGMA_PX,
  minSpacingPx = STROKE_MIN_POINT_SPACING_PX
} = {}) {
  const source = Array.isArray(points) ? points.filter(finitePoint) : [];
  if (source.length <= 2) return source.map(roundStrokePoint);
  const scale = strokePixelScale({ pixelWidth, pixelHeight });
  const smoothed = smoothStrokePoints(source, { pixelWidth: scale.width, pixelHeight: scale.height, sigmaPx });
  const spacing = Math.max(0, Number(minSpacingPx) || 0);
  const distance = (a, b) => Math.hypot((a.x - b.x) * scale.width, (a.y - b.y) * scale.height);
  const kept = [smoothed[0]];
  for (let index = 1; index < smoothed.length - 1; index += 1) {
    if (distance(smoothed[index], kept[kept.length - 1]) >= spacing) kept.push(smoothed[index]);
  }
  const final = smoothed[smoothed.length - 1];
  if (kept.length > 1 && distance(final, kept[kept.length - 1]) < spacing) kept[kept.length - 1] = final;
  else kept.push(final);
  const rounded = [];
  for (const point of kept.map(roundStrokePoint)) {
    const previous = rounded[rounded.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    rounded.push(point);
  }
  return rounded;
}

// Path commands (in page coordinates) of the smooth curve through the
// midpoints of consecutive points. Two points stay a straight line.
export function strokeCurveCommands(points, scaleX = 1, scaleY = 1) {
  const source = (Array.isArray(points) ? points : []).filter(finitePoint)
    .map(point => ({ x: Number(point.x) * scaleX, y: Number(point.y) * scaleY }));
  if (!source.length) return [];
  const commands = [{ type: "M", x: source[0].x, y: source[0].y }];
  if (source.length === 1) return commands;
  if (source.length === 2) {
    commands.push({ type: "L", x: source[1].x, y: source[1].y });
    return commands;
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const first = mid(source[0], source[1]);
  commands.push({ type: "L", x: first.x, y: first.y });
  for (let index = 1; index < source.length - 1; index += 1) {
    const end = mid(source[index], source[index + 1]);
    commands.push({ type: "Q", cx: source[index].x, cy: source[index].y, x: end.x, y: end.y });
  }
  const last = source[source.length - 1];
  commands.push({ type: "L", x: last.x, y: last.y });
  return commands;
}

const formatCoordinate = value => String(Math.round(value * 1000) / 1000);

export function strokePathData(points, scaleX = 1, scaleY = 1) {
  return strokeCurveCommands(points, scaleX, scaleY).map(command => command.type === "Q"
    ? `Q ${formatCoordinate(command.cx)} ${formatCoordinate(command.cy)} ${formatCoordinate(command.x)} ${formatCoordinate(command.y)}`
    : `${command.type} ${formatCoordinate(command.x)} ${formatCoordinate(command.y)}`).join(" ");
}

export function traceStrokePath(context, points, width, height) {
  for (const command of strokeCurveCommands(points, width, height)) {
    if (command.type === "M") context.moveTo(command.x, command.y);
    else if (command.type === "L") context.lineTo(command.x, command.y);
    else context.quadraticCurveTo(command.cx, command.cy, command.x, command.y);
  }
}

// Canvas counterpart of the SVG stroke: one smooth path for uniform-width
// strokes (a translucent highlighter no longer darkens at every joint where
// separately stroked segments overlapped); pressure strokes keep per-segment
// widths.
export function drawStrokeOnCanvas(context, points, baseWidth, width, height, { pressureEnabled = false } = {}) {
  const source = (Array.isArray(points) ? points : []).filter(finitePoint);
  if (!source.length) return;
  if (pressureEnabled || source.length === 1) {
    drawStrokeSegments(context, source, baseWidth, width, height, { pressureEnabled });
    return;
  }
  context.beginPath();
  context.lineWidth = Math.max(1, Math.max(0.0001, Number(baseWidth) || 0.0001) * width);
  traceStrokePath(context, source, width, height);
  context.stroke();
}
