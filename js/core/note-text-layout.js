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
