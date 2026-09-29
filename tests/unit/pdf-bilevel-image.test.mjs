import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { rasterizeBilevelImage } from "../../js/core/pdf-bilevel-image.js";

// Packs rows of 0/1 samples (1 = sample value 1) into PDF 1-bit rows.
function packRows(samples, width) {
  const rowBytes = Math.ceil(width / 8);
  const packed = new Uint8Array(rowBytes * samples.length);
  samples.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value) packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    });
  });
  return packed;
}

function randomSamples(width, height, seed = 7) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return Array.from({ length: height }, () => Array.from({ length: width }, () => (random() < 0.55 ? 1 : 0)));
}

// Exact area average of white (sample value 1 when black is 0) by brute force.
function referenceGray(samples, width, height, outWidth, outHeight) {
  const scaleX = width / outWidth;
  const scaleY = height / outHeight;
  const gray = [];
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      for (let sy = Math.floor(y * scaleY); sy < Math.min(height, Math.ceil((y + 1) * scaleY)); sy += 1) {
        const coverY = Math.min(sy + 1, (y + 1) * scaleY) - Math.max(sy, y * scaleY);
        for (let sx = Math.floor(x * scaleX); sx < Math.min(width, Math.ceil((x + 1) * scaleX)); sx += 1) {
          const coverX = Math.min(sx + 1, (x + 1) * scaleX) - Math.max(sx, x * scaleX);
          if (coverX > 0 && coverY > 0) sum += coverX * coverY * samples[sy][sx];
        }
      }
      gray.push(Math.round(sum / (scaleX * scaleY) * 255));
    }
  }
  return gray;
}

async function rasterize(options) {
  const out = new Uint8ClampedArray(options.width * options.height * 4);
  const strips = [];
  await rasterizeBilevelImage({
    ...options,
    onStrip: (rgba, y, rows) => {
      strips.push([y, rows]);
      out.set(rgba.subarray(0, rows * options.width * 4), y * options.width * 4);
    }
  });
  return { out, strips };
}

test("1ビット画像を行ごとに展開し、出力画素の下の白い面積の割合で縮小する", async () => {
  const width = 97;
  const height = 61;
  const samples = randomSamples(width, height);
  const data = new Blob([deflateSync(packRows(samples, width))]);
  const { out, strips } = await rasterize({ data, sourceWidth: width, sourceHeight: height, width: 20, height: 13, stripRows: 4 });
  const expected = referenceGray(samples, width, height, 20, 13);
  const actual = [];
  for (let index = 0; index < out.length; index += 4) {
    assert.equal(out[index], out[index + 1]);
    assert.equal(out[index], out[index + 2]);
    assert.equal(out[index + 3], 255);
    actual.push(out[index]);
  }
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= 1), "丸め誤差1以内");
  assert.deepEqual(strips, [[0, 4], [4, 4], [8, 4], [12, 1]]);
});

test("整数倍の縮小は各ブロックの白の数どおりになり、Decode反転にも対応する", async () => {
  const samples = randomSamples(40, 20, 3);
  const data = new Blob([deflateSync(packRows(samples, 40))]);
  const { out } = await rasterize({ data, sourceWidth: 40, sourceHeight: 20, width: 4, height: 2 });
  const inverted = await rasterize({ data, sourceWidth: 40, sourceHeight: 20, blackBit: 1, width: 4, height: 2 });
  for (let by = 0; by < 2; by += 1) {
    for (let bx = 0; bx < 4; bx += 1) {
      let whites = 0;
      for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) whites += samples[by * 10 + y][bx * 10 + x];
      const index = (by * 4 + bx) * 4;
      assert.equal(out[index], Math.round(whites / 100 * 255));
      assert.equal(inverted.out[index], Math.round((100 - whites) / 100 * 255));
    }
  }
});

test("縮小しない場合と、データが足りない場合", async () => {
  const samples = [[1, 0, 1], [0, 1, 0]];
  const data = new Blob([deflateSync(packRows(samples, 3))]);
  const { out } = await rasterize({ data, sourceWidth: 3, sourceHeight: 2, width: 3, height: 2 });
  assert.deepEqual([...out].filter((_, index) => index % 4 === 0), [255, 0, 255, 0, 255, 0]);
  const short = new Blob([deflateSync(packRows(samples.slice(0, 1), 3))]);
  await assert.rejects(rasterize({ data: short, sourceWidth: 3, sourceHeight: 2, width: 3, height: 2 }), /データが不足/);
  await assert.rejects(rasterize({ data, sourceWidth: 3, sourceHeight: 2, width: 4, height: 2 }), RangeError);
});
