import assert from "node:assert/strict";
import test from "node:test";

import {
  PDF_IMAGE_MAX_PIXELS,
  PDF_RENDER_JPEG_QUALITY,
  PDF_RENDER_MAX_PIXELS,
  PDF_RENDER_MAX_SCALE,
  PDF_RENDER_RETRY_FACTORS,
  convertPdfToImageFiles,
  createScanWorkerPool,
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

// A pdf.js stand-in. `failures` maps a page number to the outcomes of its
// successive attempts ("render" rejects the render, "blob" makes toBlob yield
// null); missing entries succeed.
function fakePdf({ pageSizes = [[595, 842]], failures = {} } = {}) {
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
  assert.ok(pdf.state.getDocumentOptions.data.byteLength > 0);
  assert.equal(pdf.state.destroyed, true);
  assert.ok(pdf.canvases.every(canvas => canvas.width === 1 && canvas.height === 1), "描画後のcanvasを解放する");
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
    jpeg: new Uint8Array([0xff, 0xd8]), imageWidth: 4928, imageHeight: 7002, ctm: [595, 0, 0, 842, 0, 0], clips: [],
    pageSize: { width: 595, height: 842 }
  };
  const otherPage = { ...plan, pageSize: { width: 612, height: 792 } };
  const openedWith = [];
  let scanBytes = null;
  const decoded = [];
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async (bytes, options) => {
      openedWith.push({ size: bytes.byteLength, ...options });
      scanBytes = bytes;
      return { pageCount: 4, planForPage: pageNumber => [plan, plan, null, otherPage][pageNumber - 1] };
    },
    decodeImage: async (blob, options) => {
      decoded.push(options);
      if (decoded.length === 2 || decoded.length === 3) throw new Error("decode failed");
      return { close() {} };
    },
    onPage: async page => { pages.push(page); }
  });
  assert.deepEqual(openedWith, [{ size: pdfFile().size, expectedPageCount: 4 }]);
  assert.deepEqual(pages.map(page => page.renderer), ["scan", "pdfjs", "pdfjs", "pdfjs"]);
  assert.deepEqual(pdf.state.attempts.map(attempt => attempt.pageNumber), [2, 3, 4], "pdf.jsは直接描画しなかったページだけ");
  assert.equal(decoded.length, 3, "pdf.jsとページ寸法が合わないページは直接描画しない");
  assert.deepEqual(decoded[0], { resizeWidth: 1904, resizeHeight: 2694, resizeQuality: "high" });
  assert.notEqual(pdf.state.getDocumentOptions.data.buffer, scanBytes.buffer, "pdf.jsは渡された領域をworkerへ移すため複製を渡す");
  assert.deepEqual([...pdf.state.getDocumentOptions.data], [...scanBytes]);
});

// Stand-in for pdf-scan-page-worker.js. `respond(message)` returns (or
// resolves to) the reply data for a page.
function fakeScanWorkers(respond) {
  const state = { created: [], messages: [], active: 0, peak: 0 };
  const createScanWorker = () => {
    const listeners = { message: [], error: [], messageerror: [] };
    // `state.active` counts pages a live worker is still converting; a
    // terminated worker stops at once, like a real one.
    const worker = {
      terminated: false,
      inFlight: 0,
      addEventListener(type, listener) { listeners[type].push(listener); },
      postMessage(message) {
        state.messages.push(message);
        worker.inFlight += 1;
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        Promise.resolve(respond(message)).then(data => {
          if (worker.terminated) return;
          worker.inFlight -= 1;
          state.active -= 1;
          listeners.message.forEach(listener => listener({ data: { id: message.id, ...data } }));
        });
      },
      terminate() {
        if (worker.terminated) return;
        worker.terminated = true;
        state.active -= worker.inFlight;
        worker.inFlight = 0;
      },
      fire(type, event) { listeners[type].forEach(listener => listener(event)); }
    };
    state.created.push(worker);
    return worker;
  };
  return { state, createScanWorker };
}

function scanPlan(pageSize = { width: 595, height: 842 }) {
  return {
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), imageWidth: 4928, imageHeight: 7002,
    ctm: [595, 0, 0, 842, 0, 0], clips: [], pageSize
  };
}

const jpegReply = async () => ({ blob: new Blob(["jpeg"], { type: "image/jpeg" }) });

test("スキャンページはworkerで2ページずつ並行して変換し、ページ順に渡す", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842], [595, 842], [595, 842]] });
  const workers = fakeScanWorkers(async message => {
    // Page 1 finishes after page 2.
    await new Promise(resolve => setTimeout(resolve, message.pageNumber === 1 ? 20 : 1));
    return jpegReply();
  });
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async () => ({ pageCount: 4, planForPage: () => scanPlan() }),
    createScanWorker: workers.createScanWorker,
    onPage: async page => { pages.push(page); }
  });
  assert.deepEqual(pages.map(page => page.pageNumber), [1, 2, 3, 4], "ページ順に渡す");
  assert.ok(pages.every(page => page.worker && page.renderer === "scan"));
  assert.deepEqual(pages.map(page => [page.width, page.height]), pages.map(() => [1904, 2694]), "本体と同じ寸法");
  assert.equal(pdf.state.attempts.length, 0, "本体ではpdf.jsで描かない");
  assert.equal(workers.state.created.length, 2);
  assert.equal(workers.state.peak, 2, "同時に変換するのはworker数まで");
  const [first] = workers.state.messages;
  assert.ok(first.plan.jpeg instanceof Blob, "ページのJPEGだけを送る");
  assert.equal(first.plan.jpeg.size, 4);
  assert.equal(first.quality, PDF_RENDER_JPEG_QUALITY);
  assert.deepEqual([first.width, first.height], [1904, 2694]);
  assert.ok(workers.state.created.every(worker => worker.terminated), "変換後にworkerを終了する");
});

test("workerで変換できないページは本体で描き直し、以降は1ページずつ本体で変換する", async t => {
  t.mock.method(console, "warn", () => {});
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842], [595, 842], [595, 842]] });
  let mainDraws = 0;
  let overlapped = false;
  const workers = fakeScanWorkers(async message => {
    // Page 1 succeeds; page 2 fails while page 3 is still converting.
    await new Promise(resolve => setTimeout(resolve, { 1: 1, 2: 10 }[message.pageNumber] ?? 30));
    return message.pageNumber === 2 ? { error: "decode failed" } : jpegReply();
  });
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async () => ({ pageCount: 4, planForPage: () => scanPlan() }),
    createScanWorker: workers.createScanWorker,
    decodeImage: async () => {
      if (workers.state.active) overlapped = true;
      mainDraws += 1;
      return { close() {} };
    },
    onPage: async page => { pages.push(page); }
  });
  assert.deepEqual(pages.map(page => page.pageNumber), [1, 2, 3, 4]);
  assert.deepEqual(pages.map(page => page.worker), [true, false, false, false]);
  assert.ok(pages.every(page => page.renderer === "scan"), "本体でも埋込みJPEGから描く");
  assert.equal(mainDraws, 3);
  assert.equal(overlapped, false, "本体の描画はworkerの変換と重ねない");
});

test("2ページ以下のPDFはworkerを起動せず本体で変換する", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [595, 842]] });
  const workers = fakeScanWorkers(jpegReply);
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async () => ({ pageCount: 2, planForPage: () => scanPlan() }),
    createScanWorker: workers.createScanWorker,
    decodeImage: async () => ({ close() {} }),
    onPage: async page => { pages.push(page); }
  });
  assert.equal(workers.state.created.length, 0);
  assert.deepEqual(pages.map(page => [page.renderer, page.worker]), [["scan", false], ["scan", false]]);
});

test("pdf-libとpdf.jsで寸法が合わないページとスキャンでないページは本体のpdf.jsで描く", async () => {
  const pdf = fakePdf({ pageSizes: [[595, 842], [612, 792], [595, 842]] });
  const workers = fakeScanWorkers(jpegReply);
  const pages = [];
  await convertPdfToImageFiles(pdfFile(), null, {
    pdfjsLib: pdf.lib,
    createCanvas: pdf.createCanvas,
    wait: noWait,
    openScannedPages: async () => ({ pageCount: 3, planForPage: pageNumber => [scanPlan(), scanPlan(), null][pageNumber - 1] }),
    createScanWorker: workers.createScanWorker,
    onPage: async page => { pages.push(page); }
  });
  assert.deepEqual(pages.map(page => [page.pageNumber, page.worker, page.renderer]), [
    [1, true, "scan"], [2, false, "pdfjs"], [3, false, "pdfjs"]
  ]);
  assert.deepEqual(pdf.state.attempts.map(attempt => attempt.pageNumber), [2, 3]);
});

test("応答しない・起動できないworkerは失敗として扱い、待っているページも返す", async () => {
  const timers = [];
  const hung = fakeScanWorkers(() => new Promise(() => {}));
  const pool = createScanWorkerPool({
    size: 1,
    createWorker: hung.createScanWorker,
    timeoutMs: 1000,
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimer: () => {}
  });
  const first = pool.render({ pageNumber: 1 });
  const second = pool.render({ pageNumber: 2 });
  assert.equal(timers.length, 1, "送ったページだけ時間を計る");
  timers[0].callback();
  await assert.rejects(first, /時間内に終わりませんでした/);
  await assert.rejects(second, /時間内に終わりませんでした/);
  assert.equal(pool.failed, true);
  await assert.rejects(pool.render({ pageNumber: 3 }), /時間内に終わりませんでした/);
  pool.close();
  assert.equal(hung.state.created[0].terminated, true);

  const broken = fakeScanWorkers(() => new Promise(() => {}));
  const brokenPool = createScanWorkerPool({ size: 2, createWorker: broken.createScanWorker });
  const pending = brokenPool.render({ pageNumber: 1 });
  broken.state.created[1].fire("error", { message: "module failed", preventDefault() {} });
  await assert.rejects(pending, /module failed/);
  brokenPool.close();
});
