import assert from "node:assert/strict";
import test from "node:test";
import { createNoteToolSettingsStore, normalizeNoteToolSettings } from "../../js/core/note-tool-settings.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("ペン・蛍光・消しゴム・図形・文字設定をUIDごとに分離して保持する", () => {
  const storage = memoryStorage();
  const alice = createNoteToolSettingsStore({ uid: "alice", storage });
  const bob = createNoteToolSettingsStore({ uid: "bob", storage });
  alice.save({
    penWidth: 42,
    penColor: "#ff0000",
    highlighterWidth: 70,
    eraserMode: "pixel",
    shapeType: "star",
    shapeStrokeColor: "#2563eb",
    shapeFillOpacity: 55,
    textFontFamily: "system-serif",
    textFontSize: 38,
    textBold: true,
    textColor: "#16a34a",
    toolbarDock: "left",
    toolbarAutoHide: true,
    fingerDraw: false
  });
  assert.equal(alice.load().penWidth, 42);
  assert.equal(alice.load().highlighterWidth, 70);
  assert.equal(alice.load().eraserMode, "pixel");
  assert.equal(alice.load().shapeType, "star");
  assert.equal(alice.load().shapeStrokeColor, "#2563eb");
  assert.equal(alice.load().shapeFillOpacity, 55);
  assert.equal(alice.load().textFontFamily, "system-serif");
  assert.equal(alice.load().textFontSize, 38);
  assert.equal(alice.load().textBold, true);
  assert.equal(alice.load().textColor, "#16a34a");
  assert.equal(alice.load().toolbarDock, "left");
  assert.equal(alice.load().toolbarAutoHide, true);
  assert.equal(alice.load().fingerDraw, false);
  assert.notEqual(bob.load().penWidth, 42);
});

test("設定値を安全な範囲と許可値へ正規化する", () => {
  const value = normalizeNoteToolSettings({
    penWidth: 999,
    penColor: "red",
    shapeType: "hexagon",
    shapeStrokeWidth: 0,
    shapeFillOpacity: 200,
    textFontFamily: "fantasy",
    textFontSize: 200,
    textAlign: "justify",
    textLineHeight: 1.75,
    toolbarDock: "center",
    eraserMode: "all"
  });
  assert.equal(value.penWidth, 100);
  assert.equal(value.penColor, "#111111");
  assert.equal(value.toolbarDock, "bottom");
  assert.equal(value.eraserMode, "object");
  assert.equal(value.shapeType, "line");
  assert.equal(value.shapeStrokeWidth, 1);
  assert.equal(value.shapeFillOpacity, 100);
  assert.equal(value.textFontFamily, "system-sans");
  assert.equal(value.textFontSize, 80);
  assert.equal(value.textAlign, "left");
  assert.equal(value.textLineHeight, 1.25);
  assert.equal(value.fingerDraw, true);
});

test("旧スキーマの設定には図形・文字の既定値を補完する", () => {
  const value = normalizeNoteToolSettings({ penColor: "#ef4444", highlighterWidth: 58 });
  assert.equal(value.penColor, "#ef4444");
  assert.equal(value.highlighterWidth, 58);
  assert.equal(value.shapeType, "line");
  assert.equal(value.shapeStrokeColor, "#111111");
  assert.equal(value.textFontFamily, "system-sans");
  assert.equal(value.textColor, "#111111");
});
