export const LEGACY_NOTE_PAGE_SIZE = Object.freeze({ width: 1000, height: 1414 });

export function notePageMetrics(pageSize = LEGACY_NOTE_PAGE_SIZE) {
  const requestedWidth = Number(pageSize?.width);
  const requestedHeight = Number(pageSize?.height);
  const width = requestedWidth > 0 ? requestedWidth : LEGACY_NOTE_PAGE_SIZE.width;
  const height = requestedHeight > 0 ? requestedHeight : LEGACY_NOTE_PAGE_SIZE.height;
  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    x: value => Number(value || 0) * width,
    y: value => Number(value || 0) * height,
    widthRatio: value => Number(value || 0) * width,
    heightRatio: value => Number(value || 0) * height
  };
}
