import assert from "node:assert/strict";
import test from "node:test";
import { chooseClipboardImage, imageFileFromPasteEvent, isTextEditingTarget } from "../../js/core/note-clipboard.js";

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

test("書いているテキストと、その色パレットへの操作はページへ渡さない", () => {
  const target = selector => ({ closest: value => (value.split(", ").includes(selector) ? {} : null) });
  assert.equal(isTextEditingTarget(target("[data-note-text-editor='true']")), true);
  assert.equal(isTextEditingTarget(target("[data-note-text-palette='true']")), true);
  assert.equal(isTextEditingTarget(target("button")), false);
  assert.equal(isTextEditingTarget(null), false);
});
