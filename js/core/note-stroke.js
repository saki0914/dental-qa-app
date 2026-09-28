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
