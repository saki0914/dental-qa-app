import assert from "node:assert/strict";
import test from "node:test";

import {
  SUMMARY_MAX_SOURCE_PAGES,
  SUMMARY_PAGE_SIZE,
  addInheritedMaskTombstones,
  buildSummaryLayout,
  createInheritedMask,
  isInheritedMask,
  isSummaryNote,
  isSummaryPage,
  mergeSummarySlotMasks,
  normalizeSummaryOptions,
  placeSourceBounds,
  removeSummarySlotFromContent,
  summaryFingerprint,
  summaryInkKey,
  summarySlotGeometry,
  summarySlotLabel,
  summarySourceKey,
  summarySourceMaskEntries,
  summarySourceRefs,
  withoutMaskOrigin
} from "../../js/core/note-summary.js";

const A4 = { width: 2200, height: 3111 };
const SLIDE = { width: 2200, height: 1238 };
let counter = 0;
const createId = () => `slot-${++counter}`;

function inside(rect, outer, epsilon = 1e-6) {
  return rect.x >= outer.x - epsilon && rect.y >= outer.y - epsilon &&
    rect.x + rect.width <= outer.x + outer.width + epsilon &&
    rect.y + rect.height <= outer.y + outer.height + epsilon;
}

test("まとめの配置設定は2・4・6枚と余白なし・狭い・広いだけを受け付ける", () => {
  assert.deepEqual(normalizeSummaryOptions({ perPage: 6, memo: "wide" }), { perPage: 6, memo: "wide" });
  assert.deepEqual(normalizeSummaryOptions({ perPage: 5, memo: "huge" }), { perPage: 4, memo: "narrow" });
  assert.deepEqual(normalizeSummaryOptions(), { perPage: 4, memo: "narrow" });
  assert.equal(SUMMARY_MAX_SOURCE_PAGES, 60);
  assert.equal(SUMMARY_PAGE_SIZE.width * SUMMARY_PAGE_SIZE.height < 10_000_000, true, "PDFページと同じく10MP未満");
});

test("元ページは縦横比を保ったまま、名前の行とメモ余白を除いた枠の左上に収まる", () => {
  for (const perPage of [2, 4, 6]) {
    for (const memo of ["none", "narrow", "wide"]) {
      for (const sourceSize of [A4, SLIDE]) {
        const rects = [];
        for (let index = 0; index < perPage; index += 1) {
          const { cell, rect, label } = summarySlotGeometry({ perPage, memo, index, sourceSize });
          assert.ok(inside(rect, cell), `${perPage}枚・${memo}: 枠の中`);
          assert.ok(inside(cell, { x: 0, y: 0, width: 1, height: 1 }), "ページの中");
          const pixelAspect = (rect.width * SUMMARY_PAGE_SIZE.width) / (rect.height * SUMMARY_PAGE_SIZE.height);
          assert.ok(Math.abs(pixelAspect - sourceSize.width / sourceSize.height) < 1e-3, "縦横比を維持");
          assert.equal(rect.x, cell.x, "左寄せ（右がメモ余白）");
          assert.ok(rect.y > cell.y && rect.y - cell.y <= label.band + 1e-6, "上に名前の行");
          if (memo !== "none") {
            const memoRatio = memo === "wide" ? .4 : .25;
            assert.ok(rect.x + rect.width <= cell.x + cell.width * (1 - memoRatio) + 1e-6, "右側にメモ余白");
          }
          rects.push(rect);
        }
        for (let left = 0; left < rects.length; left += 1) {
          for (let right = left + 1; right < rects.length; right += 1) {
            const a = rects[left];
            const b = rects[right];
            const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
            assert.equal(overlap, false, "元ページどうしは重ならない");
          }
        }
      }
    }
  }
});

test("配置数を超えたページは続きのまとめページへ回し、元ページの対応を保持する", () => {
  counter = 0;
  const items = Array.from({ length: 7 }, (_, index) => ({ noteId: `note-${index % 2}`, pageId: `page-${index}`, size: A4, label: `p.${index + 1}` }));
  const layout = buildSummaryLayout(items, { perPage: 6, memo: "narrow" }, { createId });
  assert.equal(layout.length, 2);
  assert.deepEqual(layout.map(page => page.slots.length), [6, 1]);
  assert.deepEqual(layout.flatMap(page => page.slots.map(slot => slot.pageId)), items.map(item => item.pageId), "順番どおり");
  assert.deepEqual(layout[1].slots[0], {
    ...layout[1].slots[0],
    slotId: "slot-7",
    index: 0,
    noteId: "note-0",
    pageId: "page-6",
    label: "p.7",
    sourceSize: A4
  });
  assert.throws(() => buildSummaryLayout(items, {}, {}), /ID/);
  assert.equal(summarySlotLabel("生化学", 3), "生化学  p.3");
  assert.equal(summarySlotLabel("", 0), "無題ノート");
});

test("元ページ内の位置は配置先の枠へ同じ割合で移し、ページ外へは出さない", () => {
  const rect = { x: .1, y: .2, width: .4, height: .3 };
  assert.deepEqual(placeSourceBounds({ x: .5, y: .5, width: .25, height: .1 }, rect), { x: .3, y: .35, width: .1, height: .03 });
  const edge = placeSourceBounds({ x: 1, y: 1, width: .5, height: .5 }, { x: .8, y: .8, width: .4, height: .4 });
  assert.ok(edge.x + edge.width <= 1 + 1e-9 && edge.y + edge.height <= 1 + 1e-9);
});

test("元ページのノートマスクと教材マスクを、IDのない教材マスクも含めて重複なく引き継ぐ", () => {
  const entries = summarySourceMaskEntries(
    { noteMasks: [{ id: "a", x: .1, y: .1, width: .2, height: .05, weak: true, underline: true }, { id: "a", x: 0, y: 0, width: .1, height: .1 }, { id: "zero", x: .1, y: .1, width: 0, height: .1 }] },
    [{ id: "m1", x: .5, y: .5, width: .1, height: .1, weak: false }, { id: "", x: .2, y: .3, width: .1, height: .1 }]
  );
  assert.deepEqual(entries.map(entry => entry.key), ["material:m1", "material:geo:0.200000,0.300000,0.100000,0.100000", "note:a"]);
  assert.deepEqual(entries[2], { key: "note:a", kind: "note", x: .1, y: .1, width: .2, height: .05, weak: true, underline: true });
});

test("引き継いだマスクは元ノート優先で更新し、まとめ側だけのマスクと書き込みは残す", () => {
  const slot = { slotId: "s1", rect: { x: .5, y: .5, width: .5, height: .5 } };
  const otherSlot = { slotId: "s2", rect: { x: 0, y: 0, width: .5, height: .5 } };
  const source = [
    { key: "note:a", kind: "note", x: 0, y: 0, width: .2, height: .1, weak: false, underline: true },
    { key: "note:b", kind: "note", x: .5, y: .5, width: .2, height: .1, weak: true, underline: false }
  ];
  const own = { id: "own", x: .1, y: .1, width: .1, height: .1, weak: false, underline: true };
  const writing = [{ id: "ink", type: "stroke", points: [] }];
  let content = mergeSummarySlotMasks({ elements: writing, noteMasks: [own] }, slot, source);
  const otherInherited = createInheritedMask(otherSlot, source[0]);
  content.noteMasks.push(otherInherited);
  assert.equal(content.noteMasks.length, 4);
  const inheritedA = content.noteMasks.find(mask => mask.origin?.key === "note:a" && mask.origin.slotId === "s1");
  assert.deepEqual({ x: inheritedA.x, y: inheritedA.y, width: inheritedA.width, height: inheritedA.height }, { x: .5, y: .5, width: .1, height: .05 }, "枠の中の同じ位置");
  assert.equal(inheritedA.underline, true, "赤い下線も引き継ぐ");
  assert.ok(isInheritedMask(inheritedA));
  assert.equal(content.elements, writing, "書き込みはそのまま");

  // Moved in the summary: kept while the source does not change it.
  inheritedA.x = .7;
  const again = mergeSummarySlotMasks(content, slot, source);
  assert.equal(again.noteMasks.find(mask => mask.id === inheritedA.id).x, .7, "まとめ側の調整を保つ");
  assert.deepEqual(mergeSummarySlotMasks(again, slot, source), again, "何度更新しても同じ");

  // Changed in the source: the source wins.
  const moved = [{ ...source[0], x: .2 }, source[1]];
  const updated = mergeSummarySlotMasks(again, slot, moved);
  assert.equal(updated.noteMasks.find(mask => mask.id === inheritedA.id).x, .6, "元ノートで変更したマスクは元ノートの位置へ");
  assert.equal(updated.noteMasks.find(mask => mask.id === inheritedA.id).origin.source.x, .2);

  // Deleted in the source: it goes; the summary's own mask and the other slot stay.
  const deleted = mergeSummarySlotMasks(updated, slot, [moved[0]]);
  assert.equal(deleted.noteMasks.some(mask => mask.origin?.key === "note:b" && mask.origin.slotId === "s1"), false);
  assert.ok(deleted.noteMasks.some(mask => mask.id === "own"), "まとめ側だけのマスクは残る");
  assert.ok(deleted.noteMasks.some(mask => mask.id === otherInherited.id), "別の枠のマスクは変えない");

  // Added in the source.
  const added = mergeSummarySlotMasks(deleted, slot, [...moved, { key: "note:c", kind: "note", x: .9, y: .9, width: .1, height: .1, weak: false, underline: false }]);
  assert.ok(added.noteMasks.some(mask => mask.origin?.key === "note:c"));
});

test("まとめ側で削除した引き継ぎマスクは、元ノートで変わるまで戻さない", () => {
  const slot = { slotId: "s1", rect: { x: 0, y: 0, width: 1, height: 1 } };
  const source = [{ key: "note:a", kind: "note", x: .1, y: .1, width: .2, height: .1, weak: false, underline: true }];
  const content = mergeSummarySlotMasks({ elements: [], noteMasks: [] }, slot, source);
  const mask = content.noteMasks[0];
  addInheritedMaskTombstones(content, [mask, { id: "own", x: 0, y: 0, width: .1, height: .1 }]);
  content.noteMasks = [];
  assert.equal(content.summaryRemovedMasks.length, 1, "引き継いだマスクだけを記録");
  const kept = mergeSummarySlotMasks(content, slot, source);
  assert.equal(kept.noteMasks.length, 0, "削除したままにする");
  assert.equal(kept.summaryRemovedMasks.length, 1);
  const changed = mergeSummarySlotMasks(kept, slot, [{ ...source[0], width: .3 }]);
  assert.equal(changed.noteMasks.length, 1, "元ノートで変更したら戻る（元ノート優先）");
  assert.equal(changed.summaryRemovedMasks.length, 0);
  const gone = mergeSummarySlotMasks(kept, slot, []);
  assert.equal(gone.summaryRemovedMasks.length, 0, "元ノートで削除されたら記録も消す");
});

test("まとめから外した枠のマスクと削除記録だけを取り除く", () => {
  const content = {
    elements: [{ id: "ink" }],
    noteMasks: [{ id: "a", origin: { slotId: "s1", key: "note:a" } }, { id: "b", origin: { slotId: "s2", key: "note:b" } }, { id: "own" }],
    summaryRemovedMasks: [{ slotId: "s1", key: "note:c" }, { slotId: "s2", key: "note:d" }]
  };
  const result = removeSummarySlotFromContent(content, "s1");
  assert.deepEqual(result.noteMasks.map(mask => mask.id), ["b", "own"]);
  assert.deepEqual(result.summaryRemovedMasks, [{ slotId: "s2", key: "note:d" }]);
  assert.deepEqual(result.elements, [{ id: "ink" }]);
  assert.deepEqual(withoutMaskOrigin({ id: "a", x: 1, origin: { slotId: "s1" } }), { id: "a", x: 1 });
});

test("まとめノートは使っている元ノート・元ページを記録する", () => {
  const pages = [
    { pageId: "p1", summary: { slots: [{ noteId: "n2", pageId: "x" }, { noteId: "n1", pageId: "y" }] } },
    { pageId: "p2", summary: { slots: [{ noteId: "n1", pageId: "y" }] } },
    { pageId: "memo" }
  ];
  assert.deepEqual(summarySourceRefs(pages), { noteIds: ["n1", "n2"], pageRefs: ["n1/y", "n2/x"] });
  assert.equal(isSummaryPage(pages[0]), true);
  assert.equal(isSummaryPage(pages[2]), false);
  assert.equal(isSummaryNote({ summary: { version: 1 } }), true);
  assert.equal(isSummaryNote({ type: "standalone" }), false);
});

test("元ページの変化は書き込みの変化とマスクだけの変化を見分ける", () => {
  const page = { contentRevision: 3, contentHash: "h", size: A4, background: { type: "pdf-source-page", imagePath: "a.jpg" } };
  const content = { elements: [{ id: "ink", points: [{ x: .1, y: .1 }] }], noteMasks: [{ id: "m", x: .1, y: .1, width: .1, height: .1 }] };
  const ink = summaryInkKey({ page, content });
  assert.equal(summaryInkKey({ page: { ...page, contentRevision: 4 }, content: { ...content, noteMasks: [] } }), ink, "マスクだけの変更では画像を作り直さない");
  assert.notEqual(summaryInkKey({ page, content: { ...content, elements: [] } }), ink, "書き込みの変更");
  assert.notEqual(summaryInkKey({ page: { ...page, background: { ...page.background, imagePath: "b.jpg" } }, content }), ink, "背景の変更");
  const key = summarySourceKey({ page });
  assert.notEqual(summarySourceKey({ page: { ...page, contentRevision: 4 } }), key, "保存されたら確認する");
  assert.notEqual(summarySourceKey({ page, materialMasks: [{ id: "x", x: 0, y: 0, width: .1, height: .1 }] }), key, "教材マスクの変更");
  assert.equal(summaryFingerprint({ a: 1 }), summaryFingerprint({ a: 1 }));
  assert.match(summaryFingerprint("x"), /^[0-9a-f]{16}$/);
});
