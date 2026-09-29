// Black-and-white scanner pages: a scanner in automatic color mode stores
// text-only pages as a 1-bit image at a higher resolution than color pages
// (a ScanSnap A4 page at 1200 dpi is about 9,800 x 14,000 px, 138M px). pdf.js
// expands such an image to 4 bytes per pixel before downscaling it, over 500 MB
// for one page, which terminates the iPad Safari tab. Here the compressed rows
// are inflated as a stream and averaged straight down to the size the page
// canvas needs, so the page never exists at full resolution.

export const BILEVEL_STRIP_ROWS = 64;

// The rows of zlib-compressed `data` (a Blob), inflated by the browser as they
// are read.
export async function* inflateWithDecompressionStream(data) {
  const reader = data.stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Area average of a 1-bit image, `sourceWidth` x `sourceHeight`, stored as
// zlib-compressed rows (PDF FlateDecode without predictor) in the Blob `data`,
// down to `width` x `height` gray pixels (at most the source size).
// `inflate(data)` yields the inflated bytes in chunks. `blackBit` is the
// sample value that is black (0 for DeviceGray without a Decode array). Each
// output pixel is the exact white fraction of the source area under it.
// `onStrip(rgba, y, rows)` receives consecutive rows of opaque RGBA pixels;
// `rgba` is reused between calls.
export async function rasterizeBilevelImage({
  data,
  sourceWidth,
  sourceHeight,
  blackBit = 0,
  width,
  height,
  stripRows = BILEVEL_STRIP_ROWS,
  inflate = inflateWithDecompressionStream,
  onStrip
}) {
  const W = Math.trunc(sourceWidth);
  const H = Math.trunc(sourceHeight);
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  if (!(W > 0 && H > 0 && w > 0 && h > 0) || w > W || h > H) {
    throw new RangeError("白黒画像の縮小サイズが不正です。");
  }
  const rowBytes = Math.ceil(W / 8);
  const scaleX = W / w;
  const scaleY = H / h;
  const area = scaleX * scaleY;
  const invert = blackBit === 1 ? 0xff : 0;

  // Output column x covers source columns [x, x + 1) * scaleX: pixel `first`
  // by `firstWeight`, the whole pixels after it, and pixel `last` by
  // `lastWeight` (scaleX >= 1, so first < last).
  const first = new Int32Array(w);
  const last = new Int32Array(w);
  const firstWeight = new Float64Array(w);
  const lastWeight = new Float64Array(w);
  for (let x = 0; x < w; x += 1) {
    const start = x * scaleX;
    const end = x === w - 1 ? W : (x + 1) * scaleX;
    first[x] = Math.floor(start);
    last[x] = Math.min(W, Math.floor(end));
    firstWeight[x] = first[x] + 1 - start;
    lastWeight[x] = last[x] < W ? end - last[x] : 0;
  }

  // white[i]: white pixels left of column i in the current source row.
  const white = new Uint32Array(W + 1);
  const rowWhite = new Float64Array(w);
  let current = new Float64Array(w);
  let next = new Float64Array(w);
  const stripHeight = Math.max(1, Math.min(h, Math.trunc(stripRows)));
  const strip = new Uint8ClampedArray(w * stripHeight * 4);
  let stripStart = 0;
  let stripCount = 0;
  let outputRow = 0;
  let sourceRow = 0;

  const emitRow = async () => {
    let offset = stripCount * w * 4;
    for (let x = 0; x < w; x += 1) {
      const gray = Math.round(current[x] / area * 255);
      strip[offset] = gray;
      strip[offset + 1] = gray;
      strip[offset + 2] = gray;
      strip[offset + 3] = 255;
      offset += 4;
    }
    stripCount += 1;
    outputRow += 1;
    if (stripCount === stripHeight || outputRow === h) {
      await onStrip(strip, stripStart, stripCount);
      stripStart += stripCount;
      stripCount = 0;
    }
  };

  const addRow = async row => {
    let column = 0;
    for (let index = 0; index < rowBytes; index += 1) {
      const byte = row[index] ^ invert;
      for (let bit = 7; bit >= 0 && column < W; bit -= 1) {
        white[column + 1] = white[column] + ((byte >> bit) & 1);
        column += 1;
      }
    }
    for (let x = 0; x < w; x += 1) {
      const a = first[x];
      const b = last[x];
      rowWhite[x] = firstWeight[x] * (white[a + 1] - white[a]) +
        (white[b] - white[a + 1]) +
        (b < W ? lastWeight[x] * (white[b + 1] - white[b]) : 0);
    }
    // Output row `outputRow` covers source rows [outputRow, outputRow + 1) * scaleY.
    const boundary = outputRow === h - 1 ? H : (outputRow + 1) * scaleY;
    const bottom = sourceRow + 1;
    if (bottom < boundary - 1e-9) {
      for (let x = 0; x < w; x += 1) current[x] += rowWhite[x];
    } else {
      const upper = boundary - sourceRow;
      const lower = bottom - boundary;
      for (let x = 0; x < w; x += 1) current[x] += upper * rowWhite[x];
      if (lower > 1e-9 && outputRow + 1 < h) {
        for (let x = 0; x < w; x += 1) next[x] += lower * rowWhite[x];
      }
      await emitRow();
      [current, next] = [next, current];
      next.fill(0);
    }
    sourceRow += 1;
  };

  const row = new Uint8Array(rowBytes);
  let rowFill = 0;
  // Leaving the loop early stops the inflation (the generator's finally).
  for await (const value of inflate(data)) {
    let offset = 0;
    while (offset < value.length && sourceRow < H) {
      const take = Math.min(rowBytes - rowFill, value.length - offset);
      row.set(value.subarray(offset, offset + take), rowFill);
      rowFill += take;
      offset += take;
      if (rowFill === rowBytes) {
        await addRow(row);
        rowFill = 0;
      }
    }
    if (sourceRow >= H) break;
  }
  if (sourceRow < H) throw new Error(`白黒画像のデータが不足しています（${sourceRow} / ${H}行）。`);
  if (outputRow !== h) throw new Error("白黒画像を縮小できませんでした。");
}
