export const clampPageZoom = (value, min = 0.8, max = 5) => Math.min(max, Math.max(min, value));

export function getTwoPointDistance(points) {
  return Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY);
}

export function getTwoPointCenter(points) {
  return { x: (points[0].clientX + points[1].clientX) / 2, y: (points[0].clientY + points[1].clientY) / 2 };
}

export function captureElementZoomAnchor(container, clientX, clientY, selector, key = "page") {
  if (!container) return null;
  let element = document.elementFromPoint(clientX, clientY)?.closest?.(selector);
  if (!element || !container.contains(element)) {
    const elements = [...container.querySelectorAll(selector)];
    element = elements.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    }) || elements[0];
  }
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    elementKey: element.dataset[key],
    xRatio: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    yRatio: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
  };
}

export function restoreElementZoomAnchor(container, anchor, clientX, clientY, selector, key = "page", onResidualY = null) {
  if (!anchor || !container) return;
  const element = [...container.querySelectorAll(selector)].find(candidate => candidate.dataset[key] === anchor.elementKey);
  if (!element) return;
  const rect = element.getBoundingClientRect();
  container.scrollLeft += rect.left + rect.width * anchor.xRatio - clientX;
  container.scrollTop += rect.top + rect.height * anchor.yRatio - clientY;
  if (onResidualY) {
    const adjusted = element.getBoundingClientRect();
    onResidualY(adjusted.top + adjusted.height * anchor.yRatio - clientY);
  }
}

export function createPageZoomController({
  viewport,
  content,
  min = 0.8,
  max = 5,
  onChange = () => {},
  shouldTrackTouch = () => true
}) {
  let zoom = 1;
  let lastFitZoom = 1;
  let pinch = null;
  let pinchGestureActive = false;
  const touches = new Map();
  const clampZoom = value => clampPageZoom(value, min, max);

  function captureAnchor(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const x = clientX ?? rect.left + rect.width / 2;
    const y = clientY ?? rect.top + rect.height / 2;
    return {
      x: (viewport.scrollLeft + x - rect.left) / zoom,
      y: (viewport.scrollTop + y - rect.top) / zoom,
      viewportX: x - rect.left,
      viewportY: y - rect.top
    };
  }

  function restoreAnchor(anchor) {
    viewport.scrollLeft = anchor.x * zoom - anchor.viewportX;
    viewport.scrollTop = anchor.y * zoom - anchor.viewportY;
  }

  function setZoom(value, anchor = captureAnchor()) {
    zoom = clampZoom(value);
    content.style.setProperty("--page-zoom", String(zoom));
    content.style.transform = `scale(${zoom})`;
    content.style.transformOrigin = "top left";
    restoreAnchor(anchor);
    onChange(zoom);
  }

  function wheel(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * 0.002), captureAnchor(event.clientX, event.clientY));
  }
  function gestureStart(event) {
    event.preventDefault();
    pinch = { zoom, anchor: captureAnchor(event.clientX, event.clientY) };
  }
  function gestureChange(event) {
    if (!pinch) return;
    event.preventDefault();
    setZoom(pinch.zoom * event.scale, pinch.anchor);
  }
  function gestureEnd() { pinch = null; }
  function pointerDown(event) {
    if (event.pointerType !== "touch") return;
    if (!shouldTrackTouch(event)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2) return;
    const [a, b] = [...touches.values()];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinchGestureActive = true;
    viewport.dispatchEvent(new CustomEvent("pagezoomstart"));
    pinch = {
      zoom,
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      midpoint,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      anchor: captureAnchor(midpoint.x, midpoint.y)
    };
  }
  function pointerMove(event) {
    if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2 || !pinch) return;
    event.preventDefault();
    const [a, b] = [...touches.values()];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    setZoom(pinch.zoom * distance / pinch.distance, pinch.anchor);
    viewport.scrollLeft -= midpoint.x - pinch.midpoint.x;
    viewport.scrollTop -= midpoint.y - pinch.midpoint.y;
  }
  function pointerUp(event) {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = null;
    if (touches.size === 0) pinchGestureActive = false;
  }
  function doubleClick(event) {
    const rect = content.getBoundingClientRect();
    if (Math.abs(zoom - 1) < 0.05) {
      lastFitZoom = zoom;
      setZoom(clampZoom(viewport.clientWidth / Math.max(1, rect.width / zoom)), captureAnchor(event.clientX, event.clientY));
    } else {
      setZoom(lastFitZoom || 1, captureAnchor(event.clientX, event.clientY));
    }
  }

  viewport.addEventListener("wheel", wheel, { passive: false });
  viewport.addEventListener("gesturestart", gestureStart, { passive: false });
  viewport.addEventListener("gesturechange", gestureChange, { passive: false });
  viewport.addEventListener("gestureend", gestureEnd);
  viewport.addEventListener("dblclick", doubleClick);
  viewport.addEventListener("pointerdown", pointerDown, { capture: true });
  viewport.addEventListener("pointermove", pointerMove, { capture: true, passive: false });
  viewport.addEventListener("pointerup", pointerUp, { capture: true });
  viewport.addEventListener("pointercancel", pointerUp, { capture: true });

  return {
    get zoom() { return zoom; },
    get touchCount() { return touches.size; },
    get isPinching() { return Boolean(pinch && touches.size >= 2); },
    get isPinchGestureActive() { return pinchGestureActive; },
    setZoom,
    captureAnchor,
    destroy() {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("gesturestart", gestureStart);
      viewport.removeEventListener("gesturechange", gestureChange);
      viewport.removeEventListener("gestureend", gestureEnd);
      viewport.removeEventListener("dblclick", doubleClick);
      viewport.removeEventListener("pointerdown", pointerDown, { capture: true });
      viewport.removeEventListener("pointermove", pointerMove, { capture: true });
      viewport.removeEventListener("pointerup", pointerUp, { capture: true });
      viewport.removeEventListener("pointercancel", pointerUp, { capture: true });
    }
  };
}
