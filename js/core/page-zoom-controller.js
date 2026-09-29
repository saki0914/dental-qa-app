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
  let pinchSource = null;
  let pinchGestureActive = false;
  let zoomFrame = 0;
  let pendingZoom = null;
  const touches = new Map();
  const clampZoom = value => clampPageZoom(value, min, max);

  // The content point under (clientX, clientY), in unzoomed content pixels,
  // measured from where the content is drawn. The content does not start at
  // the scroll origin (it is centered and below the viewport padding), so the
  // point must not be derived from the scroll offset alone.
  function captureAnchor(clientX, clientY) {
    const viewportRect = viewport.getBoundingClientRect();
    const x = clientX ?? viewportRect.left + viewportRect.width / 2;
    const y = clientY ?? viewportRect.top + viewportRect.height / 2;
    const contentRect = content.getBoundingClientRect();
    return {
      x: (x - contentRect.left) / zoom,
      y: (y - contentRect.top) / zoom,
      clientX: x,
      clientY: y
    };
  }

  // Scrolls so that the anchored content point is back under its client point.
  function restoreAnchor(anchor) {
    if (!anchor) return;
    const contentRect = content.getBoundingClientRect();
    viewport.scrollLeft += contentRect.left + anchor.x * zoom - anchor.clientX;
    viewport.scrollTop += contentRect.top + anchor.y * zoom - anchor.clientY;
  }

  function setZoom(value, anchor = captureAnchor()) {
    zoom = clampZoom(value);
    content.style.setProperty("--page-zoom", String(zoom));
    content.style.transform = `scale(${zoom})`;
    content.style.transformOrigin = "top left";
    restoreAnchor(anchor);
    onChange(zoom);
  }

  function flushScheduledZoom() {
    if (zoomFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(zoomFrame);
    zoomFrame = 0;
    const pending = pendingZoom;
    pendingZoom = null;
    if (!pending) return;
    setZoom(pending.value, pending.anchor);
    viewport.scrollLeft -= pending.panX || 0;
    viewport.scrollTop -= pending.panY || 0;
  }

  function scheduleZoom(value, anchor, panX = 0, panY = 0) {
    pendingZoom = { value, anchor, panX, panY };
    if (typeof requestAnimationFrame !== "function") {
      flushScheduledZoom();
      return;
    }
    if (zoomFrame) return;
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = 0;
      flushScheduledZoom();
    });
  }

  function wheel(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * 0.002), captureAnchor(event.clientX, event.clientY));
  }
  function startPageZoomGesture(source) {
    if (pinchSource && pinchSource !== source) return false;
    const alreadyActive = pinchGestureActive;
    pinchSource = source;
    pinchGestureActive = true;
    if (!alreadyActive) viewport.dispatchEvent(new CustomEvent("pagezoomstart"));
    return true;
  }
  function endPageZoomGesture(source) {
    if (!pinchGestureActive || pinchSource !== source) return;
    pinchSource = null;
    pinchGestureActive = false;
    viewport.dispatchEvent(new CustomEvent("pagezoomend"));
  }
  function gestureStart(event) {
    event.preventDefault();
    if (!shouldTrackTouch(event)) return;
    // Safari can emit GestureEvents after the two PointerEvents have already
    // claimed this contact sequence. The first source keeps ownership until
    // that sequence ends so the same physical pinch is never applied twice.
    if (!startPageZoomGesture("native")) return;
    pinch = { zoom, anchor: captureAnchor(event.clientX, event.clientY) };
  }
  function gestureChange(event) {
    event.preventDefault();
    if (pinchSource !== "native" || !pinch) return;
    scheduleZoom(pinch.zoom * event.scale, pinch.anchor);
  }
  function gestureEnd() {
    if (pinchSource !== "native") return;
    flushScheduledZoom();
    pinch = null;
    endPageZoomGesture("native");
  }
  function pointerDown(event) {
    if (event.pointerType !== "touch") return;
    if (!shouldTrackTouch(event)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2) return;
    if (!startPageZoomGesture("pointer")) return;
    const [a, b] = [...touches.values()];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
    if (pinchSource !== "pointer" || touches.size !== 2 || !pinch) return;
    event.preventDefault();
    const [a, b] = [...touches.values()];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    scheduleZoom(
      pinch.zoom * distance / pinch.distance,
      pinch.anchor,
      midpoint.x - pinch.midpoint.x,
      midpoint.y - pinch.midpoint.y
    );
  }
  function pointerUp(event) {
    touches.delete(event.pointerId);
    if (pinchSource === "pointer" && touches.size < 2) {
      flushScheduledZoom();
      pinch = null;
    }
    if (pinchSource === "pointer" && touches.size === 0) endPageZoomGesture("pointer");
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

  function reset() {
    setZoom(1, null);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    lastFitZoom = 1;
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
    get isPinching() { return Boolean(pinchSource === "pointer" && pinch && touches.size >= 2); },
    get isPinchGestureActive() { return pinchGestureActive; },
    get pinchSource() { return pinchSource; },
    setZoom,
    flushScheduledZoom,
    reset,
    captureAnchor,
    destroy() {
      if (zoomFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(zoomFrame);
      zoomFrame = 0;
      pendingZoom = null;
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
