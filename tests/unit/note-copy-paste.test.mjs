import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTE_CLIPBOARD_SAME_PAGE_OFFSET,
  NOTE_CLIPBOARD_VERSION,
  clipboardPlacement,
  createNoteClipboard,
  noteClipboardMarkerKey,
  placeClipboardItem
} from "../../js/core/note-copy-paste.js";

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const A4 = { width: 1240, height: 1754 };

test("同じページへの貼り付けは少しずらし、繰り返すとさらにずらす", () => {
  const bounds = { x: .2, y: .3, width: .1, height: .05 };
  const first = clipboardPlacement(bounds, { sourceSize: A4, targetSize: A4, samePage: true, repeat: 0 });
  close(first.x, .2 + NOTE_CLIPBOARD_SAME_PAGE_OFFSET, "x");
  close(first.y, .3 + NOTE_CLIPBOARD_SAME_PAGE_OFFSET, "y");
  const second = clipboardPlacement(bounds, { sourceSize: A4, targetSize: A4, samePage: true, repeat: 1 });
  close(second.x, .2 + NOTE_CLIPBOARD_SAME_PAGE_OFFSET * 2, "2回目はさらにずらす");
  const edge = clipboardPlacement({ x: .95, y: .97, width: .05, height: .03 }, { samePage: true });
  assert.ok(edge.x + .05 <= 1 + 1e-9 && edge.y + .03 <= 1 + 1e-9, "ページの外へは出さない");
});

test("別のページ・別のノートへは同じ位置に貼る（同じ縦横比なら画素数が違っても同じ割合）", () => {
  const bounds = { x: .2, y: .3, width: .1, height: .05 };
  const placement = clipboardPlacement(bounds, { sourceSize: A4, targetSize: { width: 2480, height: 3508 } });
  assert.deepEqual([placement.x, placement.y, placement.scaleX, placement.scaleY], [.2, .3, 1, 1]);
  const again = clipboardPlacement(bounds, { sourceSize: A4, targetSize: A4, repeat: 1 });
  close(again.x, .2 + NOTE_CLIPBOARD_SAME_PAGE_OFFSET, "同じページへもう一度貼るとずらす");
  const stroke = { id: "s", type: "stroke", points: [{ x: .2, y: .3, pressure: .4 }, { x: .3, y: .35 }], style: { widthRatio: .003, color: "#111111" } };
  const placed = placeClipboardItem(stroke, placement, { width: 2480, height: 3508 });
  assert.deepEqual(placed.points, stroke.points, "書いた位置のまま");
  assert.equal(placed.style.widthRatio, .003);
  assert.notEqual(placed, stroke, "元の項目は変えない");
  const mask = { id: "m", x: .5, y: .6, width: .2, height: .04, weak: true, underline: true };
  assert.deepEqual(placeClipboardItem(mask, placement, A4), { ...mask });
});

test("縦横比の違うページへは幅の割合を保ち、形（円は円のまま）と文字の大きさを保つ", () => {
  // A4 portrait to A4 landscape: the same shape is 1.414^2 times taller as a share.
  const landscape = { width: 1754, height: 1240 };
  const bounds = { x: .1, y: .1, width: .2, height: .2 * (1240 / 1754) };
  const placement = clipboardPlacement(bounds, { sourceSize: A4, targetSize: landscape });
  const aspect = (1754 / 1240) / (1240 / 1754);
  close(placement.aspect, aspect, "縦横比の差");
  close(placement.scaleX, 1, "幅の割合はそのまま");
  close(placement.scaleY, aspect, "高さの割合は形を保つ分だけ変える");
  // A circle drawn on the portrait page: 0.2 of the width wide.
  const circle = { id: "c", type: "shape", shapeType: "ellipse", bounds: { ...bounds }, style: { strokeWidthRatio: .002 } };
  const placed = placeClipboardItem(circle, placement, landscape);
  close(placed.bounds.width, .2, "ページ幅に対して同じ割合の幅");
  close(placed.bounds.width * landscape.width / (placed.bounds.height * landscape.height), 1, "円は円のまま");
  // Text: its font follows the page height.
  const text = { id: "t", type: "text", text: "歯髄", bounds: { x: .1, y: .1, width: .2, height: .03 }, style: { fontSizeRatio: .02 } };
  const placedText = placeClipboardItem(text, placement, landscape);
  close(placedText.style.fontSizeRatio * landscape.height, .02 * A4.height * (landscape.width / A4.width), "文字は幅に対して同じ大きさ");
});

test("貼り付け先に入りきらない大きさは全体を縮めて、ページの中に収める", () => {
  // A tall selection on a portrait page pasted onto a landscape page.
  const bounds = { x: .1, y: .05, width: .5, height: .9 };
  const placement = clipboardPlacement(bounds, { sourceSize: A4, targetSize: { width: 1754, height: 1240 } });
  assert.ok(placement.fit < 1, "縮める");
  const height = bounds.height * placement.scaleY;
  const width = bounds.width * placement.scaleX;
  assert.ok(placement.y + height <= 1 + 1e-9 && placement.x + width <= 1 + 1e-9, "ページの中");
  close(height, 1, "高さいっぱいまで");
  const line = { id: "l", type: "shape", shapeType: "line", start: { x: .1, y: .05 }, end: { x: .6, y: .95 }, style: { strokeWidthRatio: .004 } };
  const placed = placeClipboardItem(line, placement, { width: 1754, height: 1240 });
  assert.ok([placed.start, placed.end].every(point => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
  close(placed.style.strokeWidthRatio, .004 * placement.fit, "線の太さも同じ割合で縮める");
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }
  };
}

// IndexedDB as the clipboard uses it: one store, put/get/delete by key.
function fakeIndexedDB() {
  const data = new Map();
  const request = operate => {
    const pending = {};
    queueMicrotask(() => {
      try {
        pending.result = operate();
        pending.onsuccess?.();
      } catch (error) {
        pending.error = error;
        pending.onerror?.();
      }
    });
    return pending;
  };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const transaction = {};
      const store = {
        put: (value, key) => request(() => { data.set(key, structuredClone(value)); return key; }),
        get: key => request(() => structuredClone(data.get(key))),
        delete: key => request(() => { data.delete(key); })
      };
      transaction.objectStore = () => store;
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    }
  };
  return {
    data,
    open() {
      const pending = {};
      queueMicrotask(() => { pending.result = database; pending.onsuccess?.(); });
      return pending;
    }
  };
}

test("他のタブ（別のノート）がコピーした内容を読み、どのタブで消しても全部のタブで消える", async () => {
  const indexedDB = fakeIndexedDB();
  const storage = memoryStorage();
  const tabA = createNoteClipboard({ indexedDB, storage });
  const tabB = createNoteClipboard({ indexedDB, storage });
  const record = { version: NOTE_CLIPBOARD_VERSION, id: "copy-1", createdAt: "2026-10-23T00:00:00.000Z", sourceNoteId: "n1", sourcePageId: "p1", items: [{ id: "a", x: .1, y: .1, width: .1, height: .1 }] };
  assert.equal(await tabA.write("user-1", record), true, "他のタブからも使える");
  assert.equal(tabB.peek("user-1").count, 1);
  assert.deepEqual(await tabB.read("user-1"), record);
  // B copies something else: A pastes what B copied.
  const second = { ...record, id: "copy-2", sourceNoteId: "n2", items: [record.items[0], { id: "b", type: "stroke", points: [] }] };
  assert.equal(await tabB.write("user-1", second), true);
  assert.equal(tabA.peek("user-1").id, "copy-2");
  assert.deepEqual(await tabA.read("user-1"), second);
  // B clears: A no longer offers what it copied itself.
  await tabB.clear("user-1");
  assert.equal(tabA.peek("user-1"), null);
  assert.equal(await tabA.read("user-1"), null);
  assert.equal(indexedDB.data.size, 0);
});

test("端末に保存できないときはこのタブの中でだけ貼り付けられ、他のタブには知らせない", async t => {
  t.mock.method(console, "warn", () => {});
  const storage = memoryStorage();
  const clipboard = createNoteClipboard({ indexedDB: null, storage });
  const record = { version: NOTE_CLIPBOARD_VERSION, id: "copy-1", createdAt: "2026-10-23T00:00:00.000Z", sourceNoteId: "n1", sourcePageId: "p1", items: [{ id: "a", x: .1, y: .1, width: .1, height: .1 }] };
  assert.equal(await clipboard.write("user-1", record), false, "他のノートからは使えない");
  assert.equal(storage.getItem(noteClipboardMarkerKey("user-1")), null);
  assert.equal(clipboard.peek("user-1").count, 1, "このタブでは貼り付けられる");
  assert.deepEqual(await clipboard.read("user-1"), record);
  assert.equal(clipboard.peek("user-2"), null, "別のアカウントには出さない");
  assert.equal(await clipboard.read("user-2"), null);
  await clipboard.clear("user-1");
  assert.equal(clipboard.peek("user-1"), null);
});
