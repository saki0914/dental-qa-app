export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));

export function clientPointToNormalized(clientX, clientY, pageRect) {
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) {
    throw new Error("ページ表示領域を取得できません。");
  }
  return {
    x: clamp((clientX - pageRect.left) / pageRect.width),
    y: clamp((clientY - pageRect.top) / pageRect.height)
  };
}

export function normalizedBoundsFromPoints(start, end, minimum = 0.002) {
  const x = clamp(Math.min(start.x, end.x));
  const y = clamp(Math.min(start.y, end.y));
  return {
    x,
    y,
    width: Math.max(minimum, Math.min(1 - x, Math.abs(end.x - start.x))),
    height: Math.max(minimum, Math.min(1 - y, Math.abs(end.y - start.y)))
  };
}

export function clampBounds(bounds) {
  const width = clamp(bounds?.width, 0.001, 1);
  const height = clamp(bounds?.height, 0.001, 1);
  return {
    x: clamp(bounds?.x, 0, 1 - width),
    y: clamp(bounds?.y, 0, 1 - height),
    width,
    height
  };
}

export function translateBounds(bounds, dx, dy) {
  return clampBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy });
}

export function boundsIntersect(a, b) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function elementBounds(element) {
  if (element?.bounds) return clampBounds(element.bounds);
  const points = Array.isArray(element?.points) ? element.points : [];
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(0.001, Math.max(...xs) - x), height: Math.max(0.001, Math.max(...ys) - y) };
}

export function translateElement(element, dx, dy) {
  if (element.bounds) return { ...element, bounds: translateBounds(element.bounds, dx, dy) };
  if (Array.isArray(element.points)) {
    const bounds = elementBounds(element);
    const limited = translateBounds(bounds, dx, dy);
    const actualX = limited.x - bounds.x;
    const actualY = limited.y - bounds.y;
    return {
      ...element,
      points: element.points.map(point => ({
        ...point,
        x: clamp(point.x + actualX),
        y: clamp(point.y + actualY)
      }))
    };
  }
  return element;
}

export function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pointTouchesEraser(point, eraserPoints, radius) {
  if (!eraserPoints.length) return false;
  if (eraserPoints.length === 1) return Math.hypot(point.x - eraserPoints[0].x, point.y - eraserPoints[0].y) <= radius;
  for (let index = 1; index < eraserPoints.length; index += 1) {
    if (distanceToSegment(point, eraserPoints[index - 1], eraserPoints[index]) <= radius) return true;
  }
  return false;
}

function interpolateStrokePoint(start, end, ratio) {
  const point = {
    ...start,
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio
  };
  if (Number.isFinite(start.pressure) || Number.isFinite(end.pressure)) {
    const from = Number.isFinite(start.pressure) ? start.pressure : end.pressure;
    const to = Number.isFinite(end.pressure) ? end.pressure : start.pressure;
    point.pressure = from + (to - from) * ratio;
  }
  return point;
}

function densifyStrokePoints(points, radius) {
  if (points.length < 2) return points;
  const dense = [points[0]];
  const maximumStep = Math.max(0.0005, radius / 2);
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.min(
      1024,
      Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / maximumStep))
    );
    for (let step = 1; step <= steps; step += 1) {
      dense.push(step === steps ? end : interpolateStrokePoint(start, end, step / steps));
    }
  }
  return dense;
}

export function splitStrokeByEraser(stroke, eraserPoints, radius, createId = () => crypto.randomUUID()) {
  const sourcePoints = Array.isArray(stroke?.points) ? stroke.points : [];
  const normalizedRadius = Math.max(0.0001, Number(radius) || 0.0001);
  const points = densifyStrokePoints(sourcePoints, normalizedRadius);
  const groups = [];
  let current = [];
  points.forEach(point => {
    if (pointTouchesEraser(point, eraserPoints, normalizedRadius)) {
      if (current.length > 1) groups.push(current);
      current = [];
      return;
    }
    current.push(point);
  });
  if (current.length > 1) groups.push(current);
  return groups.map(pointsGroup => ({ ...structuredClone(stroke), id: createId(), points: pointsGroup }));
}

export function rotatePoint(point, center, angleDegrees) {
  const angle = angleDegrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}
