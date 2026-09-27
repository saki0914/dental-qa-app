import assert from "node:assert/strict";
import test from "node:test";
import { createNoteToolSettingsStore, normalizeNoteToolSettings } from "../../js/core/note-tool-settings.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("ペン・蛍光・消しゴム設定をUIDごとに分離して保持する", () => {
  const storage = memoryStorage();
  const alice = createNoteToolSettingsStore({ uid: "alice", storage });
  const bob = createNoteToolSettingsStore({ uid: "bob", storage });
  alice.save({ penWidth: 42, penColor: "#ff0000", highlighterWidth: 70, eraserMode: "pixel", toolbarDock: "left" });
  assert.equal(alice.load().penWidth, 42);
  assert.equal(alice.load().highlighterWidth, 70);
  assert.equal(alice.load().eraserMode, "pixel");
  assert.equal(alice.load().toolbarDock, "left");
  assert.notEqual(bob.load().penWidth, 42);
});

test("設定値を安全な範囲と許可値へ正規化する", () => {
  const value = normalizeNoteToolSettings({ penWidth: 999, penColor: "red", toolbarDock: "center", eraserMode: "all" });
  assert.equal(value.penWidth, 100);
  assert.equal(value.penColor, "#111111");
  assert.equal(value.toolbarDock, "bottom");
  assert.equal(value.eraserMode, "object");
});
