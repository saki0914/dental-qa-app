import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PDF_CMAP_FETCH_ATTEMPTS,
  PDF_CMAP_RETRY_DELAY_MS,
  PDF_IMAGE_MAX_PIXELS,
  PDF_JS_CMAP_URL,
  PDF_JS_STANDARD_FONT_DATA_URL,
  PDF_RENDER_MAX_PIXELS,
  PDF_RENDER_MAX_SCALE,
  PDF_RANGE_CHUNK_SIZE,
  PDF_RENDER_RETRY_FACTORS,
  convertPdfToImageFiles,
  createCMapReaderFactory,
  drawEmbeddedFontsFromOutlines,
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
function fakePdf({ pageSizes = [[595, 842]], failures = {}, ranges = true, cMapRequests = {} } = {}) {
  const state = { getDocumentOptions: null, cleanups: 0, attempts: [], destroyed: false, cMapResults: [] };
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
          if (outcome === "render") return { promise: Promise.reject(new Error("render failed")) };
          // The fonts of the page ask for their CMaps, as pdf.js's worker does
          // (FetchBuiltInCMap); a font whose CMap fails is left out.
          const { CMapReaderFactory, cMapUrl, cMapPacked } = state.getDocumentOptions;
          const reader = CMapReaderFactory ? new CMapReaderFactory({ baseUrl: cMapUrl, isCompressed: cMapPacked }) : null;
          const requests = (cMapRequests[pageNumber] || []).map(name => reader.fetch({ name }).then(
            data => state.cMapResults.push({ name, ok: true, bytes: data.cMapData.length, isCompressed: data.isCompressed }),
            error => state.cMapResults.push({ name, ok: false, message: error.message })
          ));
          return { promise: Promise.all(requests).then(() => {}) };
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

// pdf.js 4.10.38's font loader, reduced to bind(): it records the fonts it was
// given to load as browser fonts.
function fakeFontLoader() {
  const loader = {
    bound: [],
    async bind(font) {
      this.bound.push(font.loadedName);
    }
  };
  return loader;
}

test("改訂17: PDFに埋め込まれたフォントはブラウザのフォントにせず輪郭から描かせ、埋め込みでないフォントは端末のフォントのまま", async () => {
  const loader = fakeFontLoader();
  const pdfDoc = { _transport: { fontLoader: loader } };
  assert.equal(drawEmbeddedFontsFromOutlines(pdfDoc), true);
  const embedded = { loadedName: "g_d0_f1", data: new Uint8Array([1, 2, 3]) };
  await assert.rejects(loader.bind(embedded), "埋め込みフォントはpdf.jsが輪郭を作る（ブラウザのフォントにしない）");
  assert.equal(embedded.disableFontFace, true, "このフォントは輪郭から描く");
  const others = [
    { loadedName: "missing", missingFile: true },
    { loadedName: "system", data: null, systemFontInfo: { loadedName: "system", src: "local(Hiragino Sans)" } },
    { loadedName: "type3", isType3Font: true, data: null },
    { loadedName: "xfa", data: new Uint8Array([1]), cssFontInfo: { fontFamily: "Xfa" } }
  ];
  for (const font of others) await loader.bind(font);
  assert.deepEqual(loader.bound, ["missing", "system", "type3", "xfa"], "埋め込みでないフォントは今までどおり");
  assert.ok(others.every(font => font.disableFontFace !== true));
  assert.equal(drawEmbeddedFontsFromOutlines(pdfDoc), true, "2回目は重ねない");
  await assert.rejects(loader.bind({ loadedName: "g_d0_f2", data: new Uint8Array([1]) }));
  assert.deepEqual(loader.bound, ["missing", "system", "type3", "xfa"]);
  assert.equal(drawEmbeddedFontsFromOutlines({}), false, "この仕組みのないpdf.jsはそのまま");
  assert.equal(drawEmbeddedFontsFromOutlines(null), false);
});

test("改訂17: 変換は最初のページを描く前に、埋め込みフォントを輪郭から描く設定にする", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842]] });
  const loader = fakeFontLoader();
  const getDocument = pdf.lib.getDocument;
  let pdfDoc = null;
  pdf.lib.getDocument = options => {
    const task = getDocument(options);
    return {
      ...task,
      promise: task.promise.then(doc => {
        pdfDoc = doc;
        doc._transport = { fontLoader: loader };
        const getPage = doc.getPage.bind(doc);
        doc.getPage = async pageNumber => {
          assert.equal(loader.bind.embeddedFontsFromOutlines, true, `${pageNumber}ページ目より前に設定する`);
          return getPage(pageNumber);
        };
        return doc;
      })
    };
  };
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib, createCanvas: pdf.createCanvas, wait: noWait, openScannedPages: noScans,
    onPage: async page => { pages.push(page.pageNumber); }
  });
  assert.deepEqual(pages, [1, 2]);
  assert.ok(pdfDoc);
  assert.equal(pdf.state.getDocumentOptions.disableFontFace, false, "埋め込みでないフォントのため、文書全体ではフォント機能を止めない");
});

test("改訂18: CMapと標準フォントはcdnjsではなくアプリ自身（vendor/pdfjs-dist-4.10.38）から読ませる", async () => {
  const pdf = fakePdf();
  await convertPdfToImageFiles(pdfFile(), null, { pdfjsLib: pdf.lib, createCanvas: pdf.createCanvas, wait: noWait, openScannedPages: noScans });
  const options = pdf.state.getDocumentOptions;
  assert.equal(options.cMapUrl, PDF_JS_CMAP_URL);
  assert.equal(options.cMapPacked, true);
  assert.equal(options.standardFontDataUrl, PDF_JS_STANDARD_FONT_DATA_URL);
  for (const url of [options.cMapUrl, options.standardFontDataUrl]) {
    assert.ok(url.endsWith("/"), "pdf.jsは末尾の/を求める");
    assert.ok(!url.includes("cdnjs"), "cdnjsはpdf.jsのデータファイルを置いていない");
    // Absolute (the pdf.js worker runs from a blob URL) and next to the app.
    assert.ok(new URL(url).pathname.endsWith("/vendor/pdfjs-dist-4.10.38/" + (url === options.cMapUrl ? "cmaps/" : "standard_fonts/")));
  }
});

test("改訂18: pdf.jsが日本語・中国語・韓国語のフォントで読むCMapと、取りに行く標準フォントが全てある", () => {
  const cmaps = fileURLToPath(PDF_JS_CMAP_URL);
  const files = readdirSync(cmaps).filter(name => name.endsWith(".bcmap"));
  assert.equal(files.length, 168, "pdfjs-dist 4.10.38のcmaps/の全て");
  // ToUnicode のないCIDフォント（Appleの端末で作ったPDFのヒラギノなど）と、
  // よく使われる日本語の文字コードのCMap。
  for (const name of ["Adobe-Japan1-UCS2", "Adobe-GB1-UCS2", "Adobe-CNS1-UCS2", "Adobe-Korea1-UCS2", "UniJIS-UCS2-H", "UniJIS-UTF16-H", "90ms-RKSJ-H", "90msp-RKSJ-H", "H", "V"]) {
    assert.ok(existsSync(`${cmaps}/${name}.bcmap`), `${name}.bcmap`);
  }
  assert.ok(existsSync(`${cmaps}/LICENSE`));
  const fonts = fileURLToPath(PDF_JS_STANDARD_FONT_DATA_URL);
  // useSystemFonts: true のとき、pdf.jsが取りに行くのはSymbolとZapfDingbatsだけ。
  for (const name of ["FoxitSymbol.pfb", "FoxitDingbats.pfb", "LICENSE_FOXIT"]) assert.ok(existsSync(`${fonts}/${name}`), name);
});

const okResponse = bytes => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer });
const notFound = { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };

test("改訂18: CMapはアプリのURLから.bcmapを読み、失敗したら間をおいて読み直し、読めなかった名前を記録する", async () => {
  const requested = [];
  const waits = [];
  let outcomes = [new Error("network"), notFound, okResponse([1, 2, 3])];
  const failures = [];
  const Factory = createCMapReaderFactory({
    fetchImpl: async url => { requested.push(url); const next = outcomes.shift(); if (next instanceof Error) throw next; return next; },
    wait: async milliseconds => { waits.push(milliseconds); },
    failures
  });
  const reader = new Factory({ baseUrl: PDF_JS_CMAP_URL, isCompressed: true });
  const data = await reader.fetch({ name: "Adobe-Japan1-UCS2" });
  assert.deepEqual([...data.cMapData], [1, 2, 3]);
  assert.equal(data.isCompressed, true);
  assert.deepEqual(requested, Array(3).fill(`${PDF_JS_CMAP_URL}Adobe-Japan1-UCS2.bcmap`));
  assert.deepEqual(waits, [PDF_CMAP_RETRY_DELAY_MS, PDF_CMAP_RETRY_DELAY_MS * 2]);
  assert.deepEqual(failures, [], "読めたものは記録しない");
  outcomes = Array(PDF_CMAP_FETCH_ATTEMPTS).fill(notFound);
  await assert.rejects(reader.fetch({ name: "UniJIS-UCS2-H" }), /UniJIS-UCS2-H/);
  assert.deepEqual(failures, ["UniJIS-UCS2-H"]);
  assert.equal(requested.length, 3 + PDF_CMAP_FETCH_ATTEMPTS);
});

test("改訂18: CMapを読めず文字が欠けるページは保存せず、理由を示して変換を止める", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842]], cMapRequests: { 1: ["Adobe-Japan1-UCS2"] } });
  const saved = [];
  await assert.rejects(convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib, createCanvas: pdf.createCanvas, wait: noWait, openScannedPages: noScans,
    fetchCMap: async () => notFound,
    onPage: async page => { saved.push(page.pageNumber); }
  }), error => {
    assert.match(error.message, /PDF 1ページ目の文字を読むための対応表（CMap: Adobe-Japan1-UCS2）を読み込めなかった/);
    assert.match(error.message, /変換を中止しました/);
    return true;
  });
  assert.deepEqual(saved, [], "文字の欠けたページを保存しない");
  assert.deepEqual(pdf.state.cMapResults.map(result => result.ok), [false]);
  assert.equal(pdf.state.destroyed, true);
  // The CMap read: the pages are saved.
  const ok = fakePdf({ pageSizes: [[595, 842], [595, 842]], cMapRequests: { 1: ["Adobe-Japan1-UCS2"] } });
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: ok.lib, createCanvas: ok.createCanvas, wait: noWait, openScannedPages: noScans,
    fetchCMap: async () => okResponse([9, 9]),
    onPage: async page => { pages.push(page.pageNumber); }
  });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(ok.state.cMapResults, [{ name: "Adobe-Japan1-UCS2", ok: true, bytes: 2, isCompressed: true }]);
});
