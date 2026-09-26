import assert from "node:assert/strict";
import test from "node:test";
import { chooseClipboardImage, imageFileFromPasteEvent } from "../../js/core/note-clipboard.js";

test("Clipboard画像はPNG、WebP、JPEGの順で選択する", () => {
  const selected = chooseClipboardImage([{ type: "image/jpeg" }, { type: "image/png" }, { type: "image/webp" }]);
  assert.equal(selected.type, "image/png");
});

test("SVGと非画像を画像貼り付け対象にしない", () => {
  assert.equal(chooseClipboardImage([{ type: "text/html" }, { type: "image/svg+xml" }]), null);
});

test("pasteイベントの同一候補から画像を1つだけ返す", () => {
  const png = new Blob(["png"], { type: "image/png" });
  const jpeg = new Blob(["jpg"], { type: "image/jpeg" });
  const result = imageFileFromPasteEvent({ clipboardData: { items: [
    { type: "image/jpeg", getAsFile: () => jpeg },
    { type: "image/png", getAsFile: () => png }
  ] } });
  assert.equal(result, png);
});
