import { expect, test } from "@playwright/test";

// Revisions 17 and 18: a lecture PDF made on an iPad lost all its Japanese
// text when it was made into a note, while its numbers, arrows, boxes and
// photos stayed. Its Japanese font (Hiragino, embedded as a CID-keyed CFF
// font declared Adobe-Japan1, without a ToUnicode map) needs pdf.js's
// Adobe-Japan1-UCS2 CMap, which the app fetched from cdnjs; cdnjs has only the
// builds of pdf.js, and pdf.js leaves out a font whose CMap it cannot read.
// The app now serves the CMaps itself (vendor/pdfjs-dist-4.10.38), stops
// rather than save pages that lost text when a CMap cannot be read, and draws
// embedded fonts from their outlines instead of handing them to the browser's
// font engine (revision 17). The fixture is described in
// tests/fixtures/README.md.

async function convertFixture(page, options = {}) {
  await page.goto("/js/core/pdf-converter.js");
  return page.evaluate(async ({ failCMaps }) => {
    // The fonts pdf.js gives to the browser while it converts.
    const added = [];
    const fonts = document.fonts;
    const add = fonts.add;
    fonts.add = function addFont(fontFace) {
      added.push(fontFace.family);
      return add.call(fonts, fontFace);
    };
    const { convertPdfToImageFiles } = await import("/js/core/pdf-converter.js");
    const blob = await (await fetch("/tests/fixtures/pdf-embedded-cid-cff-ja.pdf")).blob();
    const file = new File([blob], "埋め込みフォント.pdf", { type: "application/pdf" });
    const pages = [];
    let error = null;
    try {
      await convertPdfToImageFiles(file, null, {
        onPage: async info => { pages.push(info); },
        ...(failCMaps ? { fetchCMap: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }), wait: async () => {} } : {})
      });
    } catch (caught) {
      error = caught.message;
    } finally {
      fonts.add = add;
    }
    if (!pages.length) return { error, pageCount: 0, added };
    const image = await createImageBitmap(pages[0].file);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    // Dark pixels in the band of a line (shares of the page height).
    const darkIn = (top, bottom) => {
      const y = Math.round(canvas.height * top);
      const height = Math.round(canvas.height * (bottom - top));
      const { data } = context.getImageData(Math.round(canvas.width * .05), y, Math.round(canvas.width * .85), height);
      let dark = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] < 100 && data[index + 1] < 100 && data[index + 2] < 100) dark += 1;
      }
      return dark;
    };
    return {
      error,
      pageCount: pages.length,
      renderer: pages[0].renderer,
      width: canvas.width,
      identity: darkIn(.07, .14),
      helvetica: darkIn(.16, .215),
      between: darkIn(.215, .3),
      japan1: darkIn(.4, .46),
      added
    };
  }, { failCMaps: options.failCMaps === true });
}

test("改訂17・18: PDFの日本語フォント（Adobe-Japan1でToUnicodeのないものを含む）の文字が画像に残り、CMapはアプリから読む", async ({ page }) => {
  test.setTimeout(90_000);
  const cMapRequests = [];
  page.on("request", request => { if (request.url().includes(".bcmap")) cMapRequests.push(request.url()); });
  const result = await convertFixture(page);
  expect(result.error).toBeNull();
  expect(result.pageCount).toBe(1);
  expect(result.renderer).toBe("pdfjs");
  expect(result.width, "A4はこれまでどおり約1900px幅").toBeGreaterThan(1800);
  // pdf.js names an embedded font g_d0_f1 and the device font it substitutes
  // for a font that is not embedded (here Helvetica) g_d0_sf2.
  expect(result.added.filter(name => !/_sf\d+$/.test(name)), "PDFに埋め込まれたフォントをブラウザのフォントにしない").toEqual([]);
  expect(result.identity, "埋め込みの日本語の行（Adobe-Identity）が描かれる").toBeGreaterThan(3000);
  expect(result.helvetica, "埋め込みでないHelveticaの行も描かれる").toBeGreaterThan(1000);
  expect(result.between, "行の間には何もない").toBeLessThan(50);
  expect(result.japan1, "Adobe-Japan1でToUnicodeのない日本語の行も描かれる（Appleの端末で作ったPDFのヒラギノと同じ形）").toBeGreaterThan(3000);
  const origin = new URL(page.url()).origin;
  expect(cMapRequests, "CMapはアプリ自身のvendor/から読む（cdnjsには置かれていない）").toEqual([`${origin}/vendor/pdfjs-dist-4.10.38/cmaps/Adobe-Japan1-UCS2.bcmap`]);
});

test("改訂18: CMapを読めないときは、文字の欠けた画像を作らず理由を示して止める", async ({ page }) => {
  test.setTimeout(90_000);
  const result = await convertFixture(page, { failCMaps: true });
  expect(result.pageCount, "文字の欠けたページを渡さない").toBe(0);
  expect(result.error).toContain("CMap: Adobe-Japan1-UCS2");
  expect(result.error).toContain("変換を中止しました");
});
