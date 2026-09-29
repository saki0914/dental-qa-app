import assert from "node:assert/strict";
import test from "node:test";
import * as pdfLib from "pdf-lib";

import {
  composePdfMatrices,
  drawScannedPage,
  findScannedPageImage,
  inspectJpegHeader,
  openScannedPdfPages,
  scannedPageMatchesViewport
} from "../../js/core/pdf-scanned-page.js";

const content = text => new TextEncoder().encode(text);

test("ScanSnap形式（全面JPEG＋不可視OCR文字）の描画画像と変換行列を取り出す", () => {
  const page = content(
    "q Q q /Perceptual ri q 591 0 0 840 0 0 cm /Im1 Do Q 3 Tr q 1 0 0 1 300 664\n" +
    "cm BT 0.0654 Tc 17 0 0 17 0 0 Tm /C1 1 Tf <08c3027e07b1> Tj ET Q q 1 0 0 1 300 621 cm BT\n" +
    "[(Do f S) -250 <0012>] TJ (x) ' 1 2 (y) \" ET Q % comment Do\n"
  );
  assert.deepEqual(findScannedPageImage(page), { name: "Im1", ctm: [591, 0, 0, 840, 0, 0], clips: [] });
});

test("iOSの書類スキャン形式（ページ全面の矩形clip）も対象にし、clipを保持する", () => {
  const page = content("q Q q 0 0 3933 2667 re W n /Perceptual ri q 3933 0 0 2667 0 0 cm /Im1 Do Q Q");
  assert.deepEqual(findScannedPageImage(page), {
    name: "Im1",
    ctm: [3933, 0, 0, 2667, 0, 0],
    clips: [{ rect: [0, 0, 3933, 2667], ctm: [1, 0, 0, 1, 0, 0] }]
  });
});

test("q/Qで変換行列・文字描画モード・clipを戻す", () => {
  const page = content("q 2 0 0 2 0 0 cm 0 0 10 10 re W n 3 Tr Q q 10 0 0 20 5 6 cm /Im0 Do Q BT (visible?) Tj ET");
  assert.equal(findScannedPageImage(page), null, "Qで戻った後の文字描画モード0の文字は可視");
  const restored = findScannedPageImage(content("q 2 0 0 2 0 0 cm 0 0 10 10 re W n Q q 10 0 0 20 5 6 cm /Im0 Do Q"));
  assert.deepEqual(restored, { name: "Im0", ctm: [10, 0, 0, 20, 5, 6], clips: [] });
});

test("見える要素や読めない内容を含むページは対象外にしてpdf.jsへ任せる", () => {
  const cases = {
    "可視の文字": "q 595 0 0 842 0 0 cm /Im1 Do Q BT /F1 12 Tf (text) Tj ET",
    "線の描画": "q 595 0 0 842 0 0 cm /Im1 Do Q 0 0 m 100 100 l S",
    "塗りつぶし矩形": "q 595 0 0 842 0 0 cm /Im1 Do Q 0 0 10 10 re f",
    "画像2枚": "q 595 0 0 842 0 0 cm /Im1 Do Q q 10 0 0 10 0 0 cm /Im2 Do Q",
    "インライン画像": "BI /W 1 /H 1 /BPC 8 /CS /G ID ÿ EI q 595 0 0 842 0 0 cm /Im1 Do Q",
    "グラフィック状態辞書": "/GS0 gs q 595 0 0 842 0 0 cm /Im1 Do Q",
    "オプションコンテンツ": "/OC /MC0 BDC q 595 0 0 842 0 0 cm /Im1 Do Q EMC",
    "矩形以外のclip": "0 0 m 10 0 l 10 10 l h W n q 595 0 0 842 0 0 cm /Im1 Do Q",
    "複数矩形のclip": "0 0 5 5 re 5 5 5 5 re W n q 595 0 0 842 0 0 cm /Im1 Do Q",
    "つぶれた変換行列": "q 0 0 0 842 0 0 cm /Im1 Do Q",
    "画像なし": "BT 3 Tr (ocr) Tj ET",
    "閉じていない配列": "q 595 0 0 842 0 0 cm /Im1 Do Q [ (a"
  };
  for (const [label, text] of Object.entries(cases)) {
    assert.equal(findScannedPageImage(content(text)), null, label);
  }
});

test("PDF行列の合成はpdf.jsのUtil.transformと同じ順序で適用する", () => {
  // Scale 2, then translate by (5, 7).
  assert.deepEqual(composePdfMatrices([1, 0, 0, 1, 5, 7], [2, 0, 0, 2, 0, 0]), [2, 0, 0, 2, 5, 7]);
  assert.deepEqual(composePdfMatrices([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 7]), [2, 0, 0, 2, 10, 14]);
});

function fakeJpeg({ width = 64, height = 48, components = 3, exifOrientation = null } = {}) {
  const segments = [0xff, 0xd8];
  if (exifOrientation) {
    // Big-endian TIFF with one IFD entry: Orientation (0x0112), SHORT, count 1.
    const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, exifOrientation, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00];
    const data = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    segments.push(0xff, 0xe1, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data);
  }
  const frame = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, components];
  for (let component = 1; component <= components; component += 1) frame.push(component, 0x11, 0);
  segments.push(0xff, 0xc0, (frame.length + 2) >> 8, (frame.length + 2) & 0xff, ...frame);
  segments.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9);
  return new Uint8Array(segments);
}

test("JPEGのヘッダから寸法・成分数・EXIFの向きを読む", () => {
  assert.deepEqual(inspectJpegHeader(fakeJpeg({ width: 4928, height: 7002 })), {
    precision: 8, width: 4928, height: 7002, components: 3, orientation: 1
  });
  assert.equal(inspectJpegHeader(fakeJpeg({ exifOrientation: 6 })).orientation, 6);
  assert.equal(inspectJpegHeader(fakeJpeg({ components: 1 })).components, 1);
  assert.equal(inspectJpegHeader(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(inspectJpegHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null, "SOFより前に画像データ");
});

async function scannedPdf(build) {
  const document = await pdfLib.PDFDocument.create();
  await build(document);
  return new Uint8Array(await document.save());
}

test("pdf-libで開いたスキャンPDFのページから埋込みJPEGをそのまま取り出す", async t => {
  t.mock.method(console, "debug", () => {});
  const jpeg = fakeJpeg({ width: 1200, height: 1700 });
  const bytes = await scannedPdf(async document => {
    const image = await document.embedJpg(jpeg);
    const scan = document.addPage([595, 842]);
    scan.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
    const text = document.addPage([595, 842]);
    text.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
    text.drawText("visible", { x: 20, y: 20, size: 12 });
    const annotated = document.addPage([595, 842]);
    annotated.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
    annotated.node.set(pdfLib.PDFName.of("Annots"), document.context.obj([document.context.obj({ Type: "Annot", Subtype: "Square", Rect: [0, 0, 10, 10] })]));
  });
  const reader = await openScannedPdfPages(bytes, { pdfLib, expectedPageCount: 3 });
  assert.equal(reader.pageCount, 3);
  const plan = reader.planForPage(1);
  assert.deepEqual([...plan.jpeg], [...jpeg]);
  assert.equal(plan.imageWidth, 1200);
  assert.equal(plan.imageHeight, 1700);
  assert.deepEqual(plan.ctm, [595, 0, 0, 842, 0, 0]);
  assert.deepEqual(plan.pageSize, { width: 595, height: 842 });
  assert.equal(reader.planForPage(2), null, "可視の文字があるページ");
  assert.equal(reader.planForPage(3), null, "注釈があるページ");
  assert.equal(reader.planForPage(4), null);
  assert.equal(await openScannedPdfPages(bytes, { pdfLib, expectedPageCount: 2 }), null, "pdf.jsとページ数が違えば使わない");
  assert.equal(await openScannedPdfPages(new TextEncoder().encode("not a pdf"), { pdfLib }), null);
});

test("EXIFで回転指定されたJPEGや寸法の合わない画像はpdf.jsへ任せる", async () => {
  const rotated = fakeJpeg({ width: 100, height: 200, exifOrientation: 6 });
  const bytes = await scannedPdf(async document => {
    const page = document.addPage([100, 200]);
    page.drawImage(await document.embedJpg(rotated), { x: 0, y: 0, width: 100, height: 200 });
  });
  const reader = await openScannedPdfPages(bytes, { pdfLib, expectedPageCount: 1 });
  assert.equal(reader.planForPage(1), null);
});

function recordingContext() {
  const calls = [];
  const context = new Proxy({}, {
    get: (_, property) => (...args) => { calls.push([property, ...args]); },
    set: (_, property, value) => { calls.push([`set:${String(property)}`, value]); return true; }
  });
  return { context, calls };
}

test("スキャン画像はviewportと変換行列どおりの位置・向きへ、描画サイズでデコードして描く", async t => {
  const decodes = [];
  const closed = [];
  const decodeImage = async (blob, options) => {
    decodes.push({ type: blob.type, size: blob.size, options });
    return { close: () => closed.push(true) };
  };
  const { context, calls } = recordingContext();
  // pdf.js PageViewport for view [0 0 595 842], rotation 0, scale 2.
  const viewport = { transform: [2, 0, 0, -2, 0, 1684] };
  const plan = {
    jpeg: fakeJpeg(), imageWidth: 4928, imageHeight: 7002, ctm: [595, 0, 0, 842, 0, 0],
    clips: [{ rect: [0, 0, 595, 842], ctm: [1, 0, 0, 1, 0, 0] }]
  };
  const result = await drawScannedPage(context, viewport, plan, { decodeImage });
  assert.deepEqual(result, { drawnWidth: 1190, drawnHeight: 1684, resized: true });
  assert.deepEqual(decodes, [{
    type: "image/jpeg",
    size: plan.jpeg.length,
    options: { resizeWidth: 1190, resizeHeight: 1684, resizeQuality: "high" }
  }]);
  const transforms = calls.filter(call => call[0] === "setTransform").map(call => call.slice(1));
  assert.deepEqual(transforms, [[2, 0, 0, -2, 0, 1684], [1190, 0, 0, 1684, 0, 0]], "clip、画像の順に変換を設定する");
  assert.deepEqual(calls.find(call => call[0] === "rect"), ["rect", 0, 0, 595, 842]);
  assert.deepEqual(calls.find(call => call[0] === "drawImage").slice(2), [0, 0, 1, 1]);
  assert.equal(closed.length, 1, "ImageBitmapを閉じる");

  const upscale = await drawScannedPage(recordingContext().context, { transform: [4, 0, 0, -4, 0, 400] }, {
    jpeg: fakeJpeg(), imageWidth: 100, imageHeight: 100, ctm: [100, 0, 0, 100, 0, 0], clips: []
  }, { decodeImage });
  assert.equal(upscale.resized, false, "拡大時は元の解像度でデコードする");
  assert.equal(decodes.at(-1).options, undefined);
  t.diagnostic(JSON.stringify(result));
});

test("縮小デコードに対応しないブラウザでは元の解像度でデコードして描く", async () => {
  const requests = [];
  const decodeImage = async (_blob, options) => {
    requests.push(options);
    if (options) throw new TypeError("resize options are not supported");
    return { close() {} };
  };
  const result = await drawScannedPage(recordingContext().context, { transform: [1, 0, 0, -1, 0, 842] }, {
    jpeg: fakeJpeg(), imageWidth: 4928, imageHeight: 7002, ctm: [595, 0, 0, 842, 0, 0], clips: []
  }, { decodeImage });
  assert.equal(requests.length, 2);
  assert.equal(requests[1], undefined);
  assert.equal(result.resized, false);
  await assert.rejects(
    drawScannedPage(recordingContext().context, { transform: [1, 0, 0, -1, 0, 842] }, {
      jpeg: fakeJpeg(), imageWidth: 4928, imageHeight: 7002, ctm: [595, 0, 0, 842, 0, 0], clips: []
    }, { decodeImage: async () => { throw new Error("out of memory"); } }),
    /out of memory/
  );
});

test("pdf.jsと同じ規則でページ寸法（CropBox・回転・UserUnit）を求めて照合する", async () => {
  const jpeg = fakeJpeg({ width: 100, height: 140 });
  const bytes = await scannedPdf(async document => {
    const image = await document.embedJpg(jpeg);
    const rotated = document.addPage([400, 550]);
    rotated.setRotation(pdfLib.degrees(90));
    rotated.setCropBox(10, 20, 300, 400);
    rotated.drawImage(image, { x: 0, y: 0, width: 400, height: 550 });
    const scaled = document.addPage([200, 300]);
    scaled.node.set(pdfLib.PDFName.of("UserUnit"), pdfLib.PDFNumber.of(2));
    scaled.drawImage(image, { x: 0, y: 0, width: 200, height: 300 });
  });
  const reader = await openScannedPdfPages(bytes, { pdfLib, expectedPageCount: 2 });
  assert.deepEqual(reader.planForPage(1).pageSize, { width: 400, height: 300 }, "CropBox 300x400を90度回転");
  assert.deepEqual(reader.planForPage(2).pageSize, { width: 400, height: 600 });
  assert.equal(scannedPageMatchesViewport(reader.planForPage(1), { width: 400.2, height: 299.8 }), true);
  assert.equal(scannedPageMatchesViewport(reader.planForPage(1), { width: 300, height: 400 }), false);
  assert.equal(scannedPageMatchesViewport({}, { width: 300, height: 400 }), false);
});
