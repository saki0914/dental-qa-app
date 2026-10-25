import { expect, test } from "@playwright/test";

// Revision 17: the PDF a user uploaded on an iPad lost all its Japanese text,
// which was set in an embedded CID-keyed CFF font (Hiragino), while its
// numbers, arrows, boxes and photos stayed. iPad Safari draws nothing for the
// font as pdf.js 4.10.38 re-encodes it for the browser, so the conversion now
// has pdf.js draw embedded fonts from their outlines and never hands them to
// the browser's font machinery. Chromium drew the re-encoded font, so this test
// checks that the conversion no longer gives embedded fonts to the browser,
// and that the text of both an embedded and a non-embedded font is on the page
// image. The fixture is described in tests/fixtures/README.md.

test("改訂17: 埋め込みの日本語フォント（CID-keyed CFF）はブラウザのフォントにせず輪郭から描き、文字が画像に残る", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/js/core/pdf-converter.js");
  const result = await page.evaluate(async () => {
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
    await convertPdfToImageFiles(file, null, { onPage: async info => { pages.push(info); } });
    fonts.add = add;
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
      pageCount: pages.length,
      renderer: pages[0].renderer,
      width: canvas.width,
      height: canvas.height,
      japanese: darkIn(.07, .14),
      helvetica: darkIn(.16, .215),
      between: darkIn(.215, .3),
      added
    };
  });
  expect(result.pageCount).toBe(1);
  expect(result.renderer).toBe("pdfjs");
  expect(result.width, "A4はこれまでどおり約1900px幅").toBeGreaterThan(1800);
  // pdf.js names an embedded font g_d0_f1 and the device font it substitutes
  // for a font that is not embedded (here Helvetica) g_d0_sf2.
  expect(result.added.filter(name => !/_sf\d+$/.test(name)), "PDFに埋め込まれたフォントをブラウザのフォントにしない").toEqual([]);
  expect(result.japanese, "埋め込みの日本語の行が描かれる").toBeGreaterThan(3000);
  expect(result.helvetica, "埋め込みでないHelveticaの行も描かれる").toBeGreaterThan(1000);
  expect(result.between, "行の間には何もない").toBeLessThan(50);
});
