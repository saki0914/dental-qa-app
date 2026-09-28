import { randomId } from "./id.js";
import { LEGACY_NOTE_PAGE_SIZE, notePageMetrics } from "./note-page-metrics.js";

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

export function normalizedPointToClient(point, pageRect) {
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) {
    throw new Error("ページ表示領域を取得できません。");
  }
  return {
    x: pageRect.left + Number(point?.x || 0) * pageRect.width,
    y: pageRect.top + Number(point?.y || 0) * pageRect.height
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

export function elementBounds(element, pageSize) {
  if (element?.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
    const points = lineEndpoints(element, pageSize);
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(0.001, Math.max(...xs) - x), height: Math.max(0.001, Math.max(...ys) - y) };
  }
  if (element?.bounds) {
    const bounds = clampBounds(element.bounds);
    const rotation = Number(element.rotation || 0);
    if (!rotation) return bounds;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const corners = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      { x: bounds.x, y: bounds.y + bounds.height }
    ].map(point => rotateNormalizedPoint(point, center, rotation, pageSize));
    const xs = corners.map(point => point.x);
    const ys = corners.map(point => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(0.001, Math.max(...xs) - x), height: Math.max(0.001, Math.max(...ys) - y) };
  }
  const points = Array.isArray(element?.points) ? element.points : [];
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(0.001, Math.max(...xs) - x), height: Math.max(0.001, Math.max(...ys) - y) };
}

export function translateElement(element, dx, dy, pageSize) {
  if (element?.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
    const points = lineEndpoints(element, pageSize);
    const minimumX = Math.min(...points.map(point => point.x));
    const maximumX = Math.max(...points.map(point => point.x));
    const minimumY = Math.min(...points.map(point => point.y));
    const maximumY = Math.max(...points.map(point => point.y));
    const actualX = clamp(dx, -minimumX, 1 - maximumX);
    const actualY = clamp(dy, -minimumY, 1 - maximumY);
    return normalizeLineElement({
      ...structuredClone(element),
      start: { ...points[0], x: clamp(points[0].x + actualX), y: clamp(points[0].y + actualY) },
      end: { ...points[1], x: clamp(points[1].x + actualX), y: clamp(points[1].y + actualY) }
    }, pageSize);
  }
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

function scaledDistanceToSegment(point, start, end, yScale = 1) {
  const dx = end.x - start.x;
  const dy = (end.y - start.y) * yScale;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, (point.y - start.y) * yScale);
  const pointDx = point.x - start.x;
  const pointDy = (point.y - start.y) * yScale;
  const t = clamp((pointDx * dx + pointDy * dy) / lengthSquared);
  return Math.hypot(pointDx - t * dx, pointDy - t * dy);
}

export function distanceToSegment(point, start, end, pageSize) {
  const metrics = notePageMetrics(pageSize);
  return scaledDistanceToSegment(point, start, end, pageSize ? metrics.height / metrics.width : 1);
}

export function pageWidthRadiusToNormalizedAxes(radius, pageSize) {
  const normalizedRadius = Math.max(0, Number(radius) || 0);
  const metrics = notePageMetrics(pageSize);
  return {
    x: normalizedRadius,
    y: normalizedRadius * metrics.width / metrics.height
  };
}

function pointTouchesEraser(point, eraserPoints, radius, yScale) {
  if (!eraserPoints.length) return false;
  if (eraserPoints.length === 1) {
    return scaledDistanceToSegment(point, eraserPoints[0], eraserPoints[0], yScale) <= radius;
  }
  for (let index = 1; index < eraserPoints.length; index += 1) {
    if (scaledDistanceToSegment(point, eraserPoints[index - 1], eraserPoints[index], yScale) <= radius) return true;
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

function densifyStrokePoints(points, radius, yScale) {
  if (points.length < 2) return points;
  const dense = [points[0]];
  const maximumStep = Math.max(0.0005, radius / 2);
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.min(
      1024,
      Math.max(1, Math.ceil(Math.hypot(end.x - start.x, (end.y - start.y) * yScale) / maximumStep))
    );
    for (let step = 1; step <= steps; step += 1) {
      dense.push(step === steps ? end : interpolateStrokePoint(start, end, step / steps));
    }
  }
  return dense;
}

export function splitStrokeByEraser(stroke, eraserPoints, radius, createId = randomId, pageSize) {
  const sourcePoints = Array.isArray(stroke?.points) ? stroke.points : [];
  const normalizedRadius = Math.max(0.0001, Number(radius) || 0.0001);
  const metrics = notePageMetrics(pageSize);
  const yScale = pageSize ? metrics.height / metrics.width : 1;
  const points = densifyStrokePoints(sourcePoints, normalizedRadius, yScale);
  const groups = [];
  let current = [];
  points.forEach(point => {
    if (pointTouchesEraser(point, eraserPoints, normalizedRadius, yScale)) {
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

const DEFAULT_PAGE_SIZE = LEGACY_NOTE_PAGE_SIZE;

function pageSizeOrDefault(pageSize) {
  const { width, height } = notePageMetrics(pageSize);
  return { width, height };
}

function rotateNormalizedPoint(point, center, angleDegrees, pageSize) {
  const size = pageSizeOrDefault(pageSize);
  const rotated = rotatePoint(
    { x: point.x * size.width, y: point.y * size.height },
    { x: center.x * size.width, y: center.y * size.height },
    angleDegrees
  );
  return { x: rotated.x / size.width, y: rotated.y / size.height };
}

/**
 * Returns the displayed endpoints for both the canonical points model and the
 * legacy bounds/rotation model. Legacy arrows always point to the local (w, 0)
 * corner, matching the pre-migration renderer.
 */
export function lineEndpoints(element, pageSize = DEFAULT_PAGE_SIZE) {
  if (element?.start && element?.end) {
    return [structuredClone(element.start), structuredClone(element.end)];
  }
  if (Array.isArray(element?.points) && element.points.length >= 2) {
    return [structuredClone(element.points[0]), structuredClone(element.points[1])];
  }
  const bounds = element?.bounds;
  if (!bounds) return [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return [
    rotateNormalizedPoint({ x: bounds.x, y: bounds.y + bounds.height }, center, Number(element.rotation || 0), pageSize),
    rotateNormalizedPoint({ x: bounds.x + bounds.width, y: bounds.y }, center, Number(element.rotation || 0), pageSize)
  ];
}

/**
 * Produces the compatibility fields consumed by older clients. The legacy
 * renderer draws from the local bottom-left to top-right corner, then rotates
 * around the bounds center. Absolute endpoint deltas are used for the bounds,
 * while rotation carries the direction, which keeps the compatibility bounds
 * inside the page whenever both canonical endpoints are inside it.
 */
export function legacyLineFieldsFromEndpoints(points, pageSize = DEFAULT_PAGE_SIZE) {
  const [start, end] = points || [];
  if (!start || !end) throw new TypeError("直線の始点と終点が必要です。");
  const size = pageSizeOrDefault(pageSize);
  const normalizedWidth = Math.abs(end.x - start.x);
  const normalizedHeight = Math.abs(end.y - start.y);
  const dx = (end.x - start.x) * size.width;
  const dy = (end.y - start.y) * size.height;
  const localDx = normalizedWidth * size.width;
  const localDy = -normalizedHeight * size.height;
  const physicalLength = Math.hypot(dx, dy);
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return {
    bounds: {
      x: center.x - normalizedWidth / 2,
      y: center.y - normalizedHeight / 2,
      width: normalizedWidth,
      height: normalizedHeight
    },
    rotation: physicalLength
      ? (Math.atan2(dy, dx) - Math.atan2(localDy, localDx)) * 180 / Math.PI
      : 0
  };
}

export function normalizeLineElement(element, pageSize = DEFAULT_PAGE_SIZE) {
  if (element?.type !== "shape" || !["line", "arrow"].includes(element.shapeType)) return structuredClone(element);
  const points = lineEndpoints(element, pageSize);
  const normalized = structuredClone(element);
  delete normalized.points;
  return {
    ...normalized,
    start: points[0],
    end: points[1],
    ...legacyLineFieldsFromEndpoints(points, pageSize)
  };
}

export function normalizeNoteLineElements(content, pageSize = DEFAULT_PAGE_SIZE) {
  const normalized = structuredClone(content);
  normalized.elements = (normalized.elements || []).map(element => normalizeLineElement(element, pageSize));
  return normalized;
}

export function selectionBounds(items, pageSize = DEFAULT_PAGE_SIZE) {
  const boundsList = (items || []).map(item => {
    if (item?.type === "shape" && ["line", "arrow"].includes(item.shapeType)) {
      const points = lineEndpoints(item, pageSize);
      const xs = points.map(point => point.x);
      const ys = points.map(point => point.y);
      return {
        x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(0.001, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(0.001, Math.max(...ys) - Math.min(...ys))
      };
    }
    if (!item?.type && Number.isFinite(item?.x)) {
      return { x: item.x, y: item.y, width: item.width, height: item.height };
    }
    return elementBounds(item, pageSize);
  });
  if (!boundsList.length) return null;
  const left = Math.min(...boundsList.map(bounds => bounds.x));
  const top = Math.min(...boundsList.map(bounds => bounds.y));
  const right = Math.max(...boundsList.map(bounds => bounds.x + bounds.width));
  const bottom = Math.max(...boundsList.map(bounds => bounds.y + bounds.height));
  return { x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) };
}

export function resizeBoundsFromHandle(bounds, handle, point, minimum = 0.005) {
  let left = bounds.x;
  let right = bounds.x + bounds.width;
  let top = bounds.y;
  let bottom = bounds.y + bounds.height;
  if (handle.includes("w")) left = Math.min(point.x, right - minimum);
  if (handle.includes("e")) right = Math.max(point.x, left + minimum);
  if (handle.includes("n")) top = Math.min(point.y, bottom - minimum);
  if (handle.includes("s")) bottom = Math.max(point.y, top + minimum);
  left = clamp(left); top = clamp(top); right = clamp(right); bottom = clamp(bottom);
  if (right - left < minimum) right = Math.min(1, left + minimum);
  if (bottom - top < minimum) bottom = Math.min(1, top + minimum);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function mapPointBetweenBounds(point, source, target, scaleX, scaleY) {
  return {
    ...point,
    x: target.x + (point.x - source.x) * scaleX,
    y: target.y + (point.y - source.y) * scaleY
  };
}

function resizeBoundedElement(element, sourceBounds, targetBounds, scaleX, scaleY, {
  scaleText = false
} = {}) {
  const center = {
    x: element.bounds.x + element.bounds.width / 2,
    y: element.bounds.y + element.bounds.height / 2
  };
  const nextCenter = mapPointBetweenBounds(center, sourceBounds, targetBounds, scaleX, scaleY);
  const normalizedRotation = ((Number(element.rotation || 0) % 180) + 180) % 180;
  const quarterTurn = Math.abs(normalizedRotation - 90) <= 0.001;
  const axisAligned = normalizedRotation <= 0.001 || Math.abs(normalizedRotation - 180) <= 0.001;
  let localScaleX = quarterTurn ? scaleY : scaleX;
  let localScaleY = quarterTurn ? scaleX : scaleY;
  if (element.aspectLocked === true || (!axisAligned && !quarterTurn)) {
    const uniform = Math.min(scaleX, scaleY);
    localScaleX = uniform;
    localScaleY = uniform;
  }
  element.bounds = {
    x: nextCenter.x - element.bounds.width * localScaleX / 2,
    y: nextCenter.y - element.bounds.height * localScaleY / 2,
    width: element.bounds.width * localScaleX,
    height: element.bounds.height * localScaleY
  };
  if (scaleText) {
    element.style = {
      ...(element.style || {}),
      fontSizeRatio: Number(element.style?.fontSizeRatio || 0.025) * Math.min(localScaleX, localScaleY)
    };
  }
  return element;
}

export function resizeElements(elements, sourceBounds, targetBounds, pageSize = DEFAULT_PAGE_SIZE) {
  if (!sourceBounds || !targetBounds) return structuredClone(elements || []);
  const scaleX = targetBounds.width / sourceBounds.width;
  const scaleY = targetBounds.height / sourceBounds.height;
  return (elements || []).map(original => {
    const element = structuredClone(original);
    if (element.locked) return element;
    if (element.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
      const points = lineEndpoints(element, pageSize).map(point =>
        mapPointBetweenBounds(point, sourceBounds, targetBounds, scaleX, scaleY)
      );
      return normalizeLineElement({ ...element, start: points[0], end: points[1] }, pageSize);
    }
    if (["stroke", "highlighter"].includes(element.type)) {
      element.points = element.points.map(point =>
        mapPointBetweenBounds(point, sourceBounds, targetBounds, scaleX, scaleY)
      );
      return element;
    }
    if (element.type === "image" && element.bounds) {
      return resizeBoundedElement(element, sourceBounds, targetBounds, scaleX, scaleY);
    }
    if (element.type === "text" && element.bounds) {
      return resizeBoundedElement(element, sourceBounds, targetBounds, scaleX, scaleY, { scaleText: true });
    }
    if (element.type === "shape" && element.bounds) {
      return resizeBoundedElement(element, sourceBounds, targetBounds, scaleX, scaleY);
    }
    return element;
  });
}

/**
 * Crops an image while preserving its current source-pixel-to-page zoom. The
 * ratio can be derived from bounds/crop, so this also works before an image's
 * natural dimensions have finished decoding. Pointer coordinates are first
 * transformed back into the image's unrotated local axes.
 */
export function cropImageFromHandle(element, handle, pagePoint, pageSize = DEFAULT_PAGE_SIZE, minimum = 0.02) {
  if (element?.type !== "image" || !element.bounds || !pagePoint) return structuredClone(element);
  const image = structuredClone(element);
  const originalBounds = image.bounds;
  const originalCrop = image.crop || { x: 0, y: 0, width: 1, height: 1 };
  const center = {
    x: originalBounds.x + originalBounds.width / 2,
    y: originalBounds.y + originalBounds.height / 2
  };
  const localPoint = rotateNormalizedPoint(pagePoint, center, -Number(image.rotation || 0), pageSize);
  const localRatio = {
    x: (localPoint.x - originalBounds.x) / originalBounds.width,
    y: (localPoint.y - originalBounds.y) / originalBounds.height
  };
  const sourcePoint = {
    x: originalCrop.x + localRatio.x * originalCrop.width,
    y: originalCrop.y + localRatio.y * originalCrop.height
  };
  const nextCrop = resizeBoundsFromHandle(originalCrop, handle, sourcePoint, minimum);
  const zoomX = originalBounds.width / originalCrop.width;
  const zoomY = originalBounds.height / originalCrop.height;
  const nextWidth = nextCrop.width * zoomX;
  const nextHeight = nextCrop.height * zoomY;
  const localCenterShift = {
    x: (nextCrop.x + nextCrop.width / 2 - originalCrop.x - originalCrop.width / 2) * zoomX,
    y: (nextCrop.y + nextCrop.height / 2 - originalCrop.y - originalCrop.height / 2) * zoomY
  };
  const rotatedCenter = rotateNormalizedPoint({
    x: center.x + localCenterShift.x,
    y: center.y + localCenterShift.y
  }, center, Number(image.rotation || 0), pageSize);
  image.crop = nextCrop;
  image.bounds = clampBounds({
    x: rotatedCenter.x - nextWidth / 2,
    y: rotatedCenter.y - nextHeight / 2,
    width: nextWidth,
    height: nextHeight
  });
  return image;
}

/**
 * Restores the full source image without changing the zoom that was active
 * immediately before the reset. The expanded bounds stay centered on the
 * current crop and are clamped when that expansion would leave the page.
 */
export function resetImageCrop(element) {
  if (element?.type !== "image" || !element.bounds) return structuredClone(element);
  const image = structuredClone(element);
  const crop = image.crop || { x: 0, y: 0, width: 1, height: 1 };
  const cropWidth = Math.max(0.001, Number(crop.width) || 0);
  const cropHeight = Math.max(0.001, Number(crop.height) || 0);
  const center = {
    x: image.bounds.x + image.bounds.width / 2,
    y: image.bounds.y + image.bounds.height / 2
  };
  const fullWidth = image.bounds.width / cropWidth;
  const fullHeight = image.bounds.height / cropHeight;
  image.crop = { x: 0, y: 0, width: 1, height: 1 };
  image.bounds = clampBounds({
    x: center.x - fullWidth / 2,
    y: center.y - fullHeight / 2,
    width: fullWidth,
    height: fullHeight
  });
  return image;
}

export function rotateElements(elements, center, angleDegrees, pageSize = DEFAULT_PAGE_SIZE) {
  return (elements || []).map(original => {
    const element = structuredClone(original);
    if (element.locked) return element;
    if (element.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
      const points = lineEndpoints(element, pageSize).map(point => rotateNormalizedPoint(point, center, angleDegrees, pageSize));
      return normalizeLineElement({ ...element, start: points[0], end: points[1] }, pageSize);
    }
    if (Array.isArray(element.points) && !element.bounds) {
      element.points = element.points.map(point => ({ ...point, ...rotateNormalizedPoint(point, center, angleDegrees, pageSize) }));
      return element;
    }
    if (element.bounds) {
      const itemCenter = {
        x: element.bounds.x + element.bounds.width / 2,
        y: element.bounds.y + element.bounds.height / 2
      };
      const nextCenter = rotateNormalizedPoint(itemCenter, center, angleDegrees, pageSize);
      element.bounds.x = nextCenter.x - element.bounds.width / 2;
      element.bounds.y = nextCenter.y - element.bounds.height / 2;
      element.rotation = Number(element.rotation || 0) + angleDegrees;
    }
    return element;
  });
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = ((a.y > point.y) !== (b.y > point.y)) &&
      point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  return Math.sign((b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y));
}

function segmentsIntersect(a, b, c, d) {
  return orientation(a, b, c) !== orientation(a, b, d) && orientation(c, d, a) !== orientation(c, d, b);
}

export function lassoContainsElement(polygon, element, pageSize = DEFAULT_PAGE_SIZE) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let points;
  let closed = false;
  if (element?.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
    points = lineEndpoints(element, pageSize);
  } else if (Array.isArray(element?.points) && !element.bounds) {
    points = element.points;
  } else {
    const bounds = clampBounds(element.bounds || elementBounds(element, pageSize));
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const rotation = Number(element.rotation || 0);
    points = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      { x: bounds.x, y: bounds.y + bounds.height }
    ].map(point => rotation ? rotateNormalizedPoint(point, center, rotation, pageSize) : point);
    if (pointInPolygon(center, polygon)) return true;
    closed = true;
  }
  if (points.some(point => pointInPolygon(point, polygon))) return true;
  const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
  for (let pointIndex = 0; pointIndex < segmentCount; pointIndex += 1) {
    for (let polygonIndex = 0; polygonIndex < polygon.length; polygonIndex += 1) {
      if (segmentsIntersect(
        points[pointIndex], points[(pointIndex + 1) % points.length],
        polygon[polygonIndex], polygon[(polygonIndex + 1) % polygon.length]
      )) return true;
    }
  }
  return false;
}

export function angleFromCenter(point, center, pageSize = DEFAULT_PAGE_SIZE) {
  const size = pageSizeOrDefault(pageSize);
  return Math.atan2((point.y - center.y) * size.height, (point.x - center.x) * size.width) * 180 / Math.PI;
}
