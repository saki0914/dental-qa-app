import assert from "node:assert/strict";
import test from "node:test";

import {
  PDF_IMAGE_MAX_PIXELS,
  PDF_RENDER_MAX_PIXELS,
  PDF_RENDER_MAX_SCALE,
  PDF_RANGE_CHUNK_SIZE,
  PDF_RENDER_RETRY_FACTORS,
  convertPdfToImageFiles,
  normalizePdfRotation,
  pdfRenderScale
} from "../../js/core/pdf-converter.js";

test("PDF回転角を診断メタデータ用の0/90/180/270度へ正規化する", () => {
  assert.equal(normalizePdfRotation(0), 0);
  assert.equal(normalizePdfRotation(90), 90);
  assert.equal(normalizePdfRotation(270), 270);
  assert.equal(normalizePdfRotation(-90), 270);
  assert.equal(normalizePdfRotation(450), 90);
  assert.equal(normalizePdfRotation(45), 0);
  assert.equal(normalizePdfRotation("invalid"), 0);
});

test("A4・A3は従来の解像度のまま、大判ページは描画面積を上限内に収める", () => {
  assert.equal(pdfRenderScale(595, 842), PDF_RENDER_MAX_SCALE, "A4は最大倍率");
  assert.equal(pdfRenderScale(842, 1191), 2200 / 842, "A3は幅2200px");
  const posterScale = pdfRenderScale(2480, 3508);
  assert.ok(2480 * 3508 * posterScale ** 2 <= PDF_RENDER_MAX_PIXELS + 1, "1pt=1pxの大判スキャンも上限内");
  assert.ok(posterScale < 1.8, "大判ページでは最小倍率より面積上限を優先する");
  assert.equal(pdfRenderScale(595, 842, .5), PDF_RENDER_MAX_SCALE * .5, "再試行係数を掛ける");
  assert.equal(pdfRenderScale(0, 842), 1.8);
});

function pdfFile(name = "scan.pdf") {
  return new File(["%PDF-1.4\n% test\n"], name, { type: "application/pdf" });
}

// pdf.js's PDFDataRangeTransport, reduced to what the converter uses.
class FakeRangeTransport {
  constructor(length, initialData) {
    this.length = length;
    this.initialData = initialData;
    this.received = [];
  }
  onDataRange(begin, chunk) {
    this.received.push({ begin, bytes: [...chunk] });
  }
}

// A pdf.js stand-in. `failures` maps a page number to the outcomes of its
// successive attempts ("render" rejects the render, "blob" makes toBlob yield
// null); missing entries succeed. Without `ranges` it has no
// PDFDataRangeTransport.
function fakePdf({ pageSizes = [[595, 842]], failures = {}, ranges = true } = {}) {
  const state = { getDocumentOptions: null, cleanups: 0, attempts: [], destroyed: false };
  const remaining = Object.fromEntries(Object.entries(failures).map(([page, list]) => [page, [...list]]));
  let pendingBlobFailure = false;
  const pdfDoc = {
    numPages: pageSizes.length,
    async getPage(pageNumber) {
      const [width, height] = pageSizes[pageNumber - 1];
      return {
        rotate: 0,
        getViewport: ({ scale }) => ({
          width: width * scale, height: height * scale, rotation: 0,
          transform: [scale, 0, 0, -scale, 0, height * scale]
        }),
        render: ({ viewport }) => {
          const outcome = remaining[pageNumber]?.shift() || "ok";
          state.attempts.push({ pageNumber, width: Math.floor(viewport.width), outcome });
          pendingBlobFailure = outcome === "blob";
          return { promise: outcome === "render" ? Promise.reject(new Error("render failed")) : Promise.resolve() };
        },
        cleanup: () => true
      };
    },
    async cleanup() {
      state.cleanups += 1;
    }
  };
  const lib = {
    AnnotationMode: { ENABLE: 1 },
    ...(ranges ? { PDFDataRangeTransport: FakeRangeTransport } : {}),
    getDocument(options) {
      state.getDocumentOptions = options;
      return { promise: Promise.resolve(pdfDoc), destroy: async () => { state.destroyed = true; } };
    }
  };
  const canvases = [];
  const createCanvas = () => {
    const canvas = {
      width: 300,
      height: 150,
      getContext: () => ({
        fillRect() {}, fillStyle: "", save() {}, restore() {}, setTransform() {}, drawImage() {},
        beginPath() {}, rect() {}, clip() {}
      }),
      toBlob(callback, type) {
        const fail = pendingBlobFailure;
        pendingBlobFailure = false;
        callback(fail ? null : new Blob(["jpeg"], { type }));
      }
    };
    canvases.push(canvas);
    return canvas;
  };
  return { state, lib, createCanvas, canvases };
}

const noWait = async () => {};
const noScans = async () => null;

test("ページ数が分かった時点で、最初のページを描く前にonDocumentを1回呼ぶ", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842]] });
  const events = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: noScans,
    onDocument: async ({ pageCount }) => {
      await noWait();
      events.push(`document:${pageCount}:rendered=${pdf.state.attempts.length}`);
    },
    onPage: async page => { events.push(`page:${page.pageNumber}`); }
  });
  assert.deepEqual(events, ["document:2:rendered=0", "page:1", "page:2"]);
});

test("スキャンPDFの巨大な埋込み画像はpdf.jsのworkerで縮小させる", async () => {
  const pdf = fakePdf();
  await convertPdfToImageFiles(pdfFile(), null, { pdfjsLib: pdf.lib, createCanvas: pdf.createCanvas, wait: noWait, openScannedPages: noScans });
  assert.equal(pdf.state.getDocumentOptions.canvasMaxAreaInBytes, PDF_IMAGE_MAX_PIXELS * 4);
  assert.equal(pdf.state.destroyed, true);
  assert.ok(pdf.canvases.every(canvas => canvas.width === 1 && canvas.height === 1), "描画後のcanvasを解放する");
});

test("pdf.jsには必要な範囲だけをファイルから読ませ、PDF全体をメモリに持たせない", async () => {
  const pdf = fakePdf();
  const file = pdfFile();
  await convertPdfToImageFiles(file, null, { pdfjsLib: pdf.lib, createCanvas: pdf.createCanvas, wait: noWait, openScannedPages: noScans });
  const options = pdf.state.getDocumentOptions;
  assert.equal(options.data, undefined);
  assert.ok(options.range instanceof FakeRangeTransport);
  assert.equal(options.range.length, file.size);
  assert.equal(options.range.initialData, null);
  assert.deepEqual([options.rangeChunkSize, options.disableAutoFetch, options.disableStream], [PDF_RANGE_CHUNK_SIZE, true, true]);
  options.range.requestDataRange(1, 5);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(options.range.received, [{ begin: 1, bytes: [...new TextEncoder().encode("PDF-")] }]);

  const legacy = fakePdf({ ranges: false });
  await convertPdfToImageFiles(pdfFile(), null, { pdfjsLib: legacy.lib, createCanvas: legacy.createCanvas, wait: noWait, openScannedPages: noScans });
  assert.equal(legacy.state.getDocumentOptions.data.byteLength, file.size, "範囲読込みがないpdf.jsにはファイル全体を渡す");
});

test("pdf.jsが求めた範囲をファイルから読めない場合は、読み込めなかったことを示して止める", async () => {
  // Readable as a whole (the signature check and the scan planning), but not
  // in the ranges pdf.js asks for, as when the file changes after it is chosen.
  class UnreadableRanges extends File {
    slice(start, end, type) {
      const blob = super.slice(start, end, type);
      if (start > 0) blob.arrayBuffer = () => Promise.reject(new DOMException("The file could not be read.", "NotReadableError"));
      return blob;
    }
  }
  let destroyed = false;
  const lib = {
    PDFDataRangeTransport: FakeRangeTransport,
    getDocument(options) {
      let reject;
      const promise = new Promise((_, rejectPromise) => { reject = rejectPromise; });
      options.range.requestDataRange(1, 5);
      return {
        promise,
        destroy: async () => {
          destroyed = true;
          reject(new Error("Worker was destroyed"));
        }
      };
    }
  };
  const file = new UnreadableRanges(["%PDF-1.4\n% test\n"], "moved.pdf", { type: "application/pdf" });
  await assert.rejects(
    convertPdfToImageFiles(file, null, { pdfjsLib: lib, createCanvas: fakePdf().createCanvas, wait: noWait, openScannedPages: noScans }),
    /^Error: PDFファイルを読み込めませんでした。The file could not be read\.$/
  );
  assert.equal(destroyed, true);
});

test("JPEG化・描画に失敗したページは資源を解放して縮小再試行し、全ページを変換する", async t => {
  t.mock.method(console, "warn", () => {});
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842], [595, 842]], failures: { 2: ["blob", "render"] } });
  const pages = [];
  const result = await convertPdfToImageFiles(pdfFile("口腔解剖学.pdf"), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: noScans,
    onPage: async page => { pages.push(page); }
  });
  assert.deepEqual(result, { pageCount: 3, files: [] });
  assert.deepEqual(pages.map(page => page.pageNumber), [1, 2, 3]);
  assert.equal(pages[1].file.name, "口腔解剖学_page_002.jpg");
  const pageTwo = pdf.state.attempts.filter(attempt => attempt.pageNumber === 2);
  assert.deepEqual(pageTwo.map(attempt => attempt.outcome), ["blob", "render", "ok"]);
  assert.deepEqual(
    pageTwo.map(attempt => attempt.width),
    PDF_RENDER_RETRY_FACTORS.map(factor => Math.floor(595 * PDF_RENDER_MAX_SCALE * factor)),
    "再試行ごとに小さく描画する"
  );
  assert.equal(pdf.state.cleanups, 2, "再試行の前に文書のキャッシュを解放する");
  assert.equal(pages[1].width, pageTwo.at(-1).width);
});

test("再試行しても変換できないページはページ番号と対処を示して止める", async t => {
  t.mock.method(console, "warn", () => {});
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842]], failures: { 2: ["blob", "blob", "blob"] } });
  const pages = [];
  await assert.rejects(
    convertPdfToImageFiles(pdfFile(), null, {
      pdfjsLib: pdf.lib,
      createCanvas: pdf.createCanvas,
      wait: noWait,
      openScannedPages: noScans,
      onPage: async page => { pages.push(page.pageNumber); }
    }),
    error => {
      assert.match(error.message, /PDF 2ページ目を画像に変換できませんでした（3回試行）/);
      assert.match(error.message, /ほかのタブやアプリを閉じて/);
      assert.match(error.message, /変換画像を読み込めません/);
      return true;
    }
  );
  assert.deepEqual(pages, [1]);
  assert.equal(pdf.state.destroyed, true);
});

test("キャンセル済みの変換は再試行せずAbortErrorで止める", async t => {
  t.mock.method(console, "warn", () => {});
  const pdf = fakePdf({ failures: { 1: ["blob", "blob"] } });
  const controller = new AbortController();
  await assert.rejects(
    convertPdfToImageFiles(pdfFile(), null, {
      pdfjsLib: pdf.lib,
      createCanvas: pdf.createCanvas,
      openScannedPages: noScans,
      signal: controller.signal,
      wait: async () => controller.abort()
    }),
    error => error.name === "AbortError"
  );
  assert.equal(pdf.state.attempts.length, 1);
});

test("スキャンページは埋込みJPEGを直接描画し、失敗したページだけpdf.jsで描画する", async t => {
  t.mock.method(console, "warn", () => {});
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842], [595, 842], [595, 842]] });
  const plan = {
    kind: "jpeg", data: new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }),
    imageWidth: 4928, imageHeight: 7002, ctm: [595, 0, 0, 842, 0, 0], clips: [],
    pageSize: { width: 595, height: 842 }
  };
  const otherPage = { ...plan, pageSize: { width: 612, height: 792 } };
  const openedWith = [];
  const decoded = [];
  const pages = [];
  const file = pdfFile();
  await convertPdfToImageFiles(file, null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async (bytes, options) => {
      openedWith.push({ size: bytes.byteLength, ...options });
      return { pageCount: 4, planForPage: pageNumber => [plan, plan, null, otherPage][pageNumber - 1] };
    },
    decodeImage: async (blob, options) => {
      decoded.push(options);
      if (decoded.length === 2 || decoded.length === 3) throw new Error("decode failed");
      return { close() {} };
    },
    onPage: async page => { pages.push(page); }
  });
  assert.deepEqual(openedWith, [{ size: file.size, source: file }], "計画はファイル全体から1回だけ作り、画像はファイルから読み出す");
  assert.deepEqual(pages.map(page => page.renderer), ["scan", "pdfjs", "pdfjs", "pdfjs"]);
  assert.deepEqual(pdf.state.attempts.map(attempt => attempt.pageNumber), [2, 3, 4], "pdf.jsは直接描画しなかったページだけ");
  assert.equal(decoded.length, 3, "pdf.jsとページ寸法が合わないページは直接描画しない");
  assert.deepEqual(decoded[0], { resizeWidth: 1904, resizeHeight: 2694, resizeQuality: "high" });
});

test("スキャンページは1ページずつデコードし、2ページ分のデコードを同時にメモリへ置かない", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842], [595, 842], [595, 842]] });
  const plan = {
    kind: "jpeg", data: new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }),
    imageWidth: 4928, imageHeight: 7002, ctm: [595, 0, 0, 842, 0, 0], clips: [],
    pageSize: { width: 595, height: 842 }
  };
  let decoding = 0;
  let peak = 0;
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async () => ({ pageCount: 4, planForPage: () => plan }),
    decodeImage: async () => {
      decoding += 1;
      peak = Math.max(peak, decoding);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { close() { decoding -= 1; } };
    },
    // Pages are handed over faster than they upload: conversion must still
    // not start the next decode before the previous one is released.
    onPage: async page => { pages.push(page.pageNumber); }
  });
  assert.deepEqual(pages, [1, 2, 3, 4]);
  assert.equal(peak, 1);
});
