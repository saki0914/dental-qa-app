export function layoutTextLines(text, maxWidth, measureText) {
  const width = Math.max(1, Number(maxWidth) || 1);
  const measure = typeof measureText === "function" ? measureText : value => String(value).length;
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const grapheme of Array.from(paragraph)) {
      const candidate = line + grapheme;
      if (line && measure(candidate) > width) {
        lines.push(line);
        line = grapheme;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

export function visibleTextLines(text, { maxWidth, maxHeight, lineHeight, measureText }) {
  const lines = layoutTextLines(text, maxWidth, measureText);
  const maximumLines = Math.max(0, Math.floor((Number(maxHeight) || 0) / Math.max(1, Number(lineHeight) || 1)));
  return lines.slice(0, maximumLines);
}

export function layoutTextBox(text, {
  maxWidth,
  lineHeight,
  measureText,
  paddingTop = 0,
  paddingBottom = 0
}) {
  const lines = layoutTextLines(text, maxWidth, measureText);
  const normalizedLineHeight = Math.max(1, Number(lineHeight) || 1);
  return {
    lines,
    lineHeight: normalizedLineHeight,
    requiredHeight: Math.max(normalizedLineHeight, Number(paddingTop) + lines.length * normalizedLineHeight + Number(paddingBottom))
  };
}

export function ensureTextElementHeight(element, { pageWidth = 1000, pageHeight = 1414, measureText }) {
  if (!element?.bounds || element.type !== "text") return element;
  const style = element.style || {};
  const fontSize = Math.max(8, Number(style.fontSizeRatio || .025) * pageHeight);
  const layout = layoutTextBox(element.text, {
    maxWidth: Math.max(1, Number(element.bounds.width || 0) * pageWidth),
    lineHeight: fontSize * Number(style.lineHeight || 1.25),
    measureText
  });
  const availableHeight = Math.max(0, Math.min(1, 1 - Number(element.bounds.y || 0)));
  const targetHeight = Math.min(
    availableHeight,
    Math.max(Number(element.bounds.height || 0), layout.requiredHeight / pageHeight)
  );
  if (Number(element.bounds.height || 0) === targetHeight) return element;
  return {
    ...element,
    autoHeight: element.autoHeight !== false,
    bounds: { ...element.bounds, height: targetHeight }
  };
}
