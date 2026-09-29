import { assertNonEmptyBlob, canvasToVerifiedBlob } from "./file-validator.js";
import { lineEndpoints } from "./note-geometry.js";
import { drawStrokeOnCanvas } from "./note-stroke.js";
import {
  createNoteTextMeasure,
  layoutTextBox,
  measureTextFontMetrics,
  punctuationSpacingSegments,
  renderableTextLine,
  setNoteTextCanvasFont,
  textLineBaselines
} from "./note-text-layout.js";
import { maskVisibilityKey } from "./note-mask-adapter.js";

function loadImage(blob) {
  assertNonEmptyBlob(blob, "描画画像");
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ image, revoke: () => URL.revokeObjectURL(url) });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像をデコードできませんでした。")); };
    image.src = url;
  });
}

function drawPaper(context, page, width, height) {
  const background = page.background || {};
  context.fillStyle = background.paperColor || "#ffffff";
  context.fillRect(0, 0, width, height);
  if (background.type !== "ruled" && background.ruleType !== "ruled") return;
  const spacing = Math.max(10, Number(background.ruleSpacingRatio || 0.035) * height);
  context.strokeStyle = background.ruleColor || "#d9dee7";
  context.globalAlpha = Number(background.ruleOpacity ?? 0.7);
  context.lineWidth = Math.max(1, Number(background.ruleWidthRatio || 0.001) * width);
  for (let y = spacing; y < height; y += spacing) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.globalAlpha = 1;
}

async function drawBlobCover(context, blob, x, y, width, height, crop = null, rotation = 0, opacity = 1, signal) {
  if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
  const loaded = await loadImage(blob);
  try {
    if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
    const source = crop || { x: 0, y: 0, width: 1, height: 1 };
    const sx = source.x * loaded.image.naturalWidth;
    const sy = source.y * loaded.image.naturalHeight;
    const sw = source.width * loaded.image.naturalWidth;
    const sh = source.height * loaded.image.naturalHeight;
    context.save();
    context.globalAlpha = opacity;
    context.translate(x + width / 2, y + height / 2);
    context.rotate(Number(rotation || 0) * Math.PI / 180);
    context.drawImage(loaded.image, sx, sy, sw, sh, -width / 2, -height / 2, width, height);
    context.restore();
  } finally {
    loaded.revoke();
  }
}

function drawShape(context, element, width, height) {
  const bounds = element.bounds;
  const style = element.style || {};
  if (["line", "arrow"].includes(element.shapeType)) {
    const [start, end] = lineEndpoints(element, { width, height });
    const x1 = start.x * width;
    const y1 = start.y * height;
    const x2 = end.x * width;
    const y2 = end.y * height;
    context.save();
    context.globalAlpha = Number(style.strokeOpacity ?? 1);
    context.strokeStyle = style.strokeColor || "#111111";
    context.lineWidth = Math.max(1, Number(style.strokeWidthRatio || 0.002) * width);
    context.lineCap = "round";
    context.setLineDash(style.lineStyle === "dashed" ? [12, 8] : style.lineStyle === "dotted" ? [2, 7] : []);
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
    if (element.shapeType === "arrow") {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const arrowSize = Math.max(10, context.lineWidth * 4);
      context.beginPath();
      context.moveTo(x2, y2);
      context.lineTo(x2 - arrowSize * Math.cos(angle - 0.55), y2 - arrowSize * Math.sin(angle - 0.55));
      context.moveTo(x2, y2);
      context.lineTo(x2 - arrowSize * Math.cos(angle + 0.55), y2 - arrowSize * Math.sin(angle + 0.55));
      context.stroke();
    }
    context.restore();
    return;
  }
  const x = bounds.x * width;
  const y = bounds.y * height;
  const w = bounds.width * width;
  const h = bounds.height * height;
  context.save();
  context.translate(x + w / 2, y + h / 2);
  context.rotate(Number(element.rotation || 0) * Math.PI / 180);
  context.translate(-w / 2, -h / 2);
  context.globalAlpha = Number(style.strokeOpacity ?? 1);
  context.strokeStyle = style.strokeColor || "#111111";
  context.lineWidth = Math.max(1, Number(style.strokeWidthRatio || 0.002) * width);
  context.setLineDash(style.lineStyle === "dashed" ? [12, 8] : style.lineStyle === "dotted" ? [2, 7] : []);
  context.fillStyle = style.fillColor || "transparent";

  const path = new Path2D();
  if (element.shapeType === "ellipse") {
    path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (element.shapeType === "triangle") {
    path.moveTo(w / 2, 0); path.lineTo(w, h); path.lineTo(0, h); path.closePath();
  } else if (element.shapeType === "star") {
    for (let index = 0; index < 10; index += 1) {
      const radius = index % 2 ? Math.min(w, h) * 0.22 : Math.min(w, h) * 0.5;
      const angle = -Math.PI / 2 + index * Math.PI / 5;
      const px = w / 2 + Math.cos(angle) * radius;
      const py = h / 2 + Math.sin(angle) * radius;
      index ? path.lineTo(px, py) : path.moveTo(px, py);
    }
    path.closePath();
  } else if (element.shapeType === "rounded-rectangle") {
    path.roundRect(0, 0, w, h, Math.min(w, h) * 0.12);
  } else {
    path.rect(0, 0, w, h);
  }
  if (style.fillOpacity > 0 && element.shapeType !== "line" && element.shapeType !== "arrow") {
    context.globalAlpha = Number(style.fillOpacity);
    context.fill(path);
  }
  context.globalAlpha = Number(style.strokeOpacity ?? 1);
  context.stroke(path);
  context.restore();
}

function drawText(context, element, width, height) {
  const bounds = element.bounds;
  const style = element.style || {};
  const x = bounds.x * width;
  const y = bounds.y * height;
  const boxWidth = bounds.width * width;
  // No minimum size: thumbnails must wrap exactly like the page does.
  const fontSize = Math.max(0.5, Number(style.fontSizeRatio || 0.025) * height);
  const align = style.textAlign === "center" || style.textAlign === "right" ? style.textAlign : "left";
  context.save();
  context.globalAlpha = Number(style.opacity ?? 1);
  context.fillStyle = style.color || "#111111";
  // The editor overlay, the SVG page and this Canvas share one font stack,
  // one line breaker and the CSS half-leading baseline model.
  const anchorX = align === "center" ? boxWidth / 2 : align === "right" ? boxWidth : 0;
  const lineHeight = fontSize * Number(style.lineHeight || 1.25);
  const layout = layoutTextBox(element.text, {
    maxWidth: boxWidth,
    lineHeight,
    measureText: createNoteTextMeasure(context, style, fontSize)
  });
  setNoteTextCanvasFont(context, style, fontSize);
  context.textBaseline = "alphabetic";
  context.textAlign = align;
  const baselines = textLineBaselines(layout.lines.length, {
    top: 0,
    lineHeight,
    ...measureTextFontMetrics(context, fontSize)
  });
  const boxHeight = Math.max(bounds.height * height, layout.requiredHeight);
  context.translate(x + boxWidth / 2, y + boxHeight / 2);
  context.rotate(Number(element.rotation || 0) * Math.PI / 180);
  context.translate(-boxWidth / 2, -boxHeight / 2);
  layout.lines.forEach((line, index) => {
    const visible = renderableTextLine(line);
    if (visible) fillTextLine(context, visible, anchorX, baselines[index], align);
  });
  context.restore();
}

// Draws one laid-out line with the same advances the line breaker measured:
// segments split between adjacent fullwidth punctuation are drawn separately
// so Canvas cannot kern them closer than the editor and the SVG page show.
function fillTextLine(context, text, anchorX, baseline, align) {
  const segments = punctuationSpacingSegments(text);
  if (segments.length === 1) {
    context.fillText(text, anchorX, baseline);
    return;
  }
  const widths = segments.map(segment => context.measureText(segment).width);
  const total = widths.reduce((sum, width) => sum + width, 0);
  let x = align === "center" ? anchorX - total / 2 : align === "right" ? anchorX - total : anchorX;
  context.textAlign = "left";
  segments.forEach((segment, index) => {
    context.fillText(segment, x, baseline);
    x += widths[index];
  });
  context.textAlign = align;
}

function shouldDrawMask(mask, source, options) {
  if (options.maskMode === "none") return false;
  if (options.maskMode === "all") return true;
  return options.revealedMaskIds?.has(maskVisibilityKey(mask, source)) !== true;
}

export async function renderNotePageToCanvas({
  page,
  content,
  materialMasks = [],
  resolveBackgroundBlob,
  resolveAssetBlob,
  width,
  height,
  maskMode = "none",
  revealedMaskIds = new Set(),
  pageNumber = null,
  signal
}) {
  if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d", { alpha: false });
  drawPaper(context, page, canvas.width, canvas.height);

  if (["pdf-source-page", "material-page"].includes(page.background?.type)) {
    const blob = await resolveBackgroundBlob(page);
    if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
    await drawBlobCover(context, blob, 0, 0, canvas.width, canvas.height, null, 0, 1, signal);
  }

  const elements = [...(content.elements || [])].sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0));
  for (const element of elements) {
    if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
    if (element.type === "image") {
      const blob = await resolveAssetBlob(element.assetId, element.assetNoteId);
      if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
      const bounds = element.bounds;
      await drawBlobCover(context, blob, bounds.x * canvas.width, bounds.y * canvas.height,
        bounds.width * canvas.width, bounds.height * canvas.height, element.crop, element.rotation, element.opacity, signal);
    } else if (element.type === "highlighter") {
      context.save();
      context.globalAlpha = Number(element.style?.opacity ?? 0.3);
      context.strokeStyle = element.style?.color || "#fff176";
      context.lineCap = "round"; context.lineJoin = "round";
      drawStrokeOnCanvas(context, element.points, Number(element.style?.widthRatio || 0.025), canvas.width, canvas.height);
      context.restore();
    } else if (element.type === "stroke") {
      context.save();
      context.globalAlpha = Number(element.style?.opacity ?? 1);
      context.strokeStyle = element.style?.color || "#111111";
      context.lineWidth = Number(element.style?.widthRatio || 0.0025) * canvas.width;
      context.lineCap = "round"; context.lineJoin = "round";
      drawStrokeOnCanvas(context, element.points, Number(element.style?.widthRatio || 0.0025), canvas.width, canvas.height, {
        pressureEnabled: element.pressureEnabled === true
      });
      context.restore();
    } else if (element.type === "shape") {
      drawShape(context, element, canvas.width, canvas.height);
    } else if (element.type === "text") {
      drawText(context, element, canvas.width, canvas.height);
    }
  }

  const masks = [
    ...materialMasks.map(mask => ({ mask, source: "material" })),
    ...(content.noteMasks || []).map(mask => ({ mask, source: "note" }))
  ];
  // The colors of the image memory screen's masks (.pdf-mask in app.css).
  masks.filter(({ mask, source }) => shouldDrawMask(mask, source, { maskMode, revealedMaskIds })).forEach(({ mask }) => {
    context.fillStyle = mask.weak ? "#b91c1c" : "#111827";
    context.fillRect(mask.x * canvas.width, mask.y * canvas.height, mask.width * canvas.width, mask.height * canvas.height);
  });
  if (maskMode === "screen") {
    masks.filter(({ mask, source }) => revealedMaskIds?.has(maskVisibilityKey(mask, source))).forEach(({ mask }) => {
      const x = mask.x * canvas.width;
      const y = mask.y * canvas.height;
      const width = mask.width * canvas.width;
      const height = mask.height * canvas.height;
      context.save();
      if (mask.weak) {
        context.fillStyle = "rgba(185,28,28,.18)";
        context.fillRect(x, y, width, height);
      }
      context.strokeStyle = mask.weak ? "#dc2626" : "rgba(37,99,235,.55)";
      context.lineWidth = Math.max(1, canvas.width * (mask.weak ? .002 : .001));
      context.setLineDash([Math.max(3, canvas.width * .004), Math.max(3, canvas.width * .003)]);
      context.beginPath();
      context.rect(x, y, width, height);
      context.stroke();
      context.restore();
    });
  }
  if (pageNumber != null) {
    const size = Math.max(16, canvas.width * 0.012);
    context.font = `${size}px sans-serif`;
    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.fillStyle = "rgba(17,24,39,.72)";
    context.fillText(String(pageNumber), canvas.width - size, canvas.height - size * 0.6);
  }
  return canvas;
}

export async function noteCanvasToJpeg(canvas, quality, signal) {
  if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
  const blob = await canvasToVerifiedBlob(canvas, "image/jpeg", quality, "PDF書き出しページ");
  if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
  return blob;
}
