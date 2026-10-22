import assert from "node:assert/strict";
import test from "node:test";

import {
  addInheritedMaskTombstones,
  applySummaryChangesToSource,
  countSummaryMergeConflicts,
  createInheritedMask,
  describeSummaryChange,
  keepSummaryChangesLocal,
  mergeSummarySlotMasks,
  placeSourceBounds,
  summaryContentAfterReflect,
  summaryPendingChanges,
  summarySlotUnderMask,
  summarySourceBounds,
  summarySourceMaskEntries,
  summarySourceMaskId
} from "../../js/core/note-summary.js";

// A summary page with two places: the left one shows page "p1" of note
// "n1", the right one page "p2" of note "n2".
const slotA = { slotId: "A", noteId: "n1", pageId: "p1", label: "解剖  p.1", rect: { x: .03, y: .05, width: .4, height: .4 }, cell: { x: .03, y: .03, width: .45, height: .45 } };
const slotB = { slotId: "B", noteId: "n2", pageId: "p2", label: "生化学  p.2", rect: { x: .52, y: .05, width: .4, height: .4 }, cell: { x: .52, y: .03, width: .45, height: .45 } };
const page = { pageId: "S1", summary: { slots: [slotA, slotB] } };
let idCounter = 0;
const createId = () => `new-${++idCounter}`;

function close(actual, expected, epsilon = 1e-6) {
  ["x", "y", "width", "height"].forEach(field => {
    assert.ok(Math.abs(actual[field] - expected[field]) <= epsilon, `${field}: ${actual[field]} ≒ ${expected[field]}`);
  });
}

function summaryWith(...sourceMasks) {
  const entries = summarySourceMaskEntries({ noteMasks: sourceMasks });
  return { content: { noteMasks: entries.map(entry => createInheritedMask(slotA, entry)), summaryRemovedMasks: [] }, entries };
}

test("まとめのマスクを元ページの割合へ戻す（元ページの外へはみ出した部分は除き、半分以上外なら戻さない）", () => {
  const source = { x: .2, y: .3, width: .25, height: .1 };
  const placed = placeSourceBounds(source, slotA.rect);
  close(summarySourceBounds(placed, slotA.rect), source);
  const half = summarySourceBounds({ x: slotA.rect.x + slotA.rect.width - .04, y: .2, width: .06, height: .02 }, slotA.rect);
  close(half, { x: 1 - .04 / .4, y: (.2 - .05) / .4, width: .04 / .4, height: .02 / .4 });
  assert.equal(summarySourceBounds({ x: .44, y: .2, width: .06, height: .02 }, slotA.rect), null, "ほとんどがメモ余白");
  assert.equal(summarySlotUnderMask(page.summary.slots, { x: .6, y: .1, width: .05, height: .02 }), slotB);
  assert.equal(summarySlotUnderMask(page.summary.slots, { x: .45, y: .9, width: .05, height: .02 }), null);
  assert.equal(summarySourceMaskId("note:m1"), "m1");
  assert.equal(summarySourceMaskId("material:m1"), "", "教材マスクは反映しない");
  assert.equal(summarySourceMaskId("note:geo:0.1,0.2"), "", "IDのないマスクは反映しない");
});

test("未反映の変更: 移動・大きさ・下線・苦手、削除、元ページの上に作ったマスク。教材マスクとメモ余白のマスクは数えない", () => {
  const { content } = summaryWith(
    { id: "m1", x: .1, y: .1, width: .2, height: .05, underline: true },
    { id: "m2", x: .1, y: .3, width: .2, height: .05 },
    { id: "m3", x: .1, y: .5, width: .2, height: .05 }
  );
  assert.deepEqual(summaryPendingChanges(page, content), [], "引き継いだままなら変更なし");
  const [m1, m2, m3] = content.noteMasks;
  m1.x += .05;
  m2.underline = true;
  m2.weak = true;
  addInheritedMaskTombstones(content, [m3]);
  content.noteMasks = content.noteMasks.filter(mask => mask !== m3);
  const material = createInheritedMask(slotA, { key: "material:t1", kind: "material", x: .5, y: .5, width: .1, height: .1, weak: false, underline: false });
  material.x += .02;
  content.noteMasks.push(material);
  content.noteMasks.push({ id: "own-on-page", x: .6, y: .2, width: .1, height: .03, weak: false, underline: true });
  content.noteMasks.push({ id: "own-memo", x: .45, y: .9, width: .05, height: .02, weak: false, underline: false });
  const changes = summaryPendingChanges(page, content);
  assert.deepEqual(changes.map(change => [change.kind, change.maskId || change.key, change.noteId, change.sourcePageId]), [
    ["update", m1.id, "n1", "p1"],
    ["update", m2.id, "n1", "p1"],
    ["add", "own-on-page", "n2", "p2"],
    ["delete", "note:m3", "n1", "p1"]
  ]);
  const [move, flags, add, removal] = changes;
  assert.deepEqual(move.details, { place: true, weak: false, underline: false });
  close(move.bounds, { x: .1 + .05 / .4, y: .1, width: .2, height: .05 });
  assert.equal(move.sourceMaskId, "m1");
  assert.deepEqual(flags.details, { place: false, weak: true, underline: true });
  close(flags.bounds, { x: .1, y: .3, width: .2, height: .05 });
  close(add.bounds, { x: (.6 - .52) / .4, y: (.2 - .05) / .4, width: .1 / .4, height: .03 / .4 });
  assert.equal(add.underline, true);
  assert.equal(removal.sourceMaskId, "m3");
  assert.deepEqual(changes.map(describeSummaryChange), [
    "マスクを変更（位置・大きさ）",
    "マスクを変更（下線を付けた、苦手にした）",
    "まとめで作ったマスクを追加",
    "マスクを削除"
  ]);
  assert.equal(new Set(changes.map(change => change.id)).size, changes.length, "変更ごとに別のID");
});

test("「まとめだけの変更」にした変更は聞かない。そのマスクをまた変えたら聞く。元ノートが変えれば元ノートに合わせる", () => {
  const { content, entries } = summaryWith({ id: "m1", x: .1, y: .1, width: .2, height: .05 }, { id: "m2", x: .1, y: .3, width: .2, height: .05 });
  content.noteMasks[0].x += .05;
  addInheritedMaskTombstones(content, [content.noteMasks[1]]);
  content.noteMasks = content.noteMasks.slice(0, 1);
  content.noteMasks.push({ id: "own", x: .1, y: .3, width: .1, height: .03 });
  const kept = keepSummaryChangesLocal(content, summaryPendingChanges(page, content));
  assert.deepEqual(summaryPendingChanges(page, kept), []);
  assert.equal(content.noteMasks[0].summaryLocal, undefined, "元の内容は変えない");
  kept.noteMasks[0].y += .03;
  assert.deepEqual(summaryPendingChanges(page, kept).map(change => change.kind), ["update"], "また動かしたら聞く");
  const changedSource = entries.map(entry => entry.key === "note:m1" ? { ...entry, x: .3 } : entry);
  const merged = mergeSummarySlotMasks(kept, slotA, changedSource);
  const replaced = merged.noteMasks.find(mask => mask.origin?.key === "note:m1");
  assert.equal(replaced.summaryLocal, undefined, "元ノートの内容に置き換えたらまとめだけの印は消す");
  close(replaced, placeSourceBounds({ x: .3, y: .1, width: .2, height: .05 }, slotA.rect));
});

test("元ページへの反映: 移動・下線・削除・追加を行い、元ノート側でも変わったマスクは反映しない（元ノート優先）", () => {
  const sourceContent = {
    noteId: "n1",
    pageId: "p1",
    elements: [{ id: "ink", type: "stroke", points: [] }],
    noteMasks: [
      { id: "m1", x: .1, y: .1, width: .2, height: .05, weak: false, underline: true },
      { id: "m2", x: .1, y: .3, width: .2, height: .05, weak: false, underline: false },
      { id: "m3", x: .1, y: .5, width: .2, height: .05, weak: false, underline: false },
      { id: "m4", x: .1, y: .7, width: .2, height: .05, weak: false, underline: false }
    ]
  };
  const { content } = summaryWith(...sourceContent.noteMasks);
  const masks = content.noteMasks;
  masks[0].x += .05;
  masks[1].underline = true;
  masks[3].y += .02;
  addInheritedMaskTombstones(content, [masks[2]]);
  content.noteMasks = masks.filter((_, index) => index !== 2);
  content.noteMasks.push({ id: "own", x: .1, y: .3, width: .1, height: .03, weak: true, underline: true });
  const changes = summaryPendingChanges(page, content);
  // The source moved m4 itself in the meantime.
  const current = { ...sourceContent, noteMasks: sourceContent.noteMasks.map(mask => mask.id === "m4" ? { ...mask, x: .4 } : { ...mask }) };
  const result = applySummaryChangesToSource(current, changes, { createId });
  assert.deepEqual(result.applied.map(change => change.kind), ["update", "update", "add", "delete"]);
  assert.deepEqual(result.skipped.map(item => [item.change.sourceMaskId, item.reason]), [["m4", "changed"]]);
  const byId = new Map(result.content.noteMasks.map(mask => [mask.id, mask]));
  close(byId.get("m1"), { x: .1 + .05 / .4, y: .1, width: .2, height: .05 });
  assert.equal(byId.get("m1").underline, true);
  assert.equal(byId.get("m2").underline, true);
  assert.equal(byId.has("m3"), false, "削除");
  assert.equal(byId.get("m4").x, .4, "元ノート側の変更は残す");
  const added = result.applied.find(change => change.kind === "add");
  assert.match(added.sourceMaskId, /^new-/);
  assert.deepEqual([byId.get(added.sourceMaskId).weak, byId.get(added.sourceMaskId).underline], [true, true]);
  assert.deepEqual(result.content.elements, sourceContent.elements, "書き込みは変えない");
  assert.equal(current.noteMasks.length, 4, "渡した内容は変えない");
  const gone = applySummaryChangesToSource({ noteMasks: [] }, changes.filter(change => change.kind !== "add"), { createId });
  assert.deepEqual(gone.applied.map(change => change.kind), ["delete"], "元ノートで消えたマスクの削除は済み");
  assert.deepEqual(gone.skipped.map(item => item.reason), ["removed", "removed", "removed"]);
  assert.throws(() => applySummaryChangesToSource(current, changes), TypeError);
});

test("反映した後のまとめは元ページの新しい状態を持ち、未反映の変更は残らない。次の更新でも変わらない", () => {
  const sourceContent = {
    noteMasks: [
      { id: "m1", x: .1, y: .1, width: .2, height: .05, weak: false, underline: false },
      { id: "m2", x: .1, y: .3, width: .2, height: .05, weak: false, underline: false }
    ]
  };
  const { content } = summaryWith(...sourceContent.noteMasks);
  content.noteMasks[0].x = slotA.rect.x + slotA.rect.width - .05;
  content.noteMasks[0].width = .08;
  addInheritedMaskTombstones(content, [content.noteMasks[1]]);
  content.noteMasks = content.noteMasks.slice(0, 1);
  content.noteMasks.push({ id: "own", x: .1, y: .3, width: .1, height: .03, weak: false, underline: true });
  const changes = summaryPendingChanges(page, content);
  const reflected = applySummaryChangesToSource(sourceContent, changes, { createId });
  const after = summaryContentAfterReflect(content, page, reflected.applied);
  assert.deepEqual(summaryPendingChanges(page, after), []);
  assert.deepEqual(after.summaryRemovedMasks, [], "反映した削除の記録は消す");
  const moved = after.noteMasks.find(mask => mask.origin?.key === "note:m1");
  assert.ok(moved.x + moved.width <= slotA.rect.x + slotA.rect.width + 1e-6, "元ページの外にはみ出した分は元ページに合わせる");
  const own = after.noteMasks.find(mask => mask.id === "own");
  assert.equal(own.origin.key, `note:${reflected.applied.find(change => change.kind === "add").sourceMaskId}`, "追加したマスクは引き継ぎマスクになる");
  const merged = mergeSummarySlotMasks(after, slotA, summarySourceMaskEntries(reflected.content));
  assert.deepEqual(merged.noteMasks, after.noteMasks, "元ノートからの更新でも同じ");
  assert.equal(merged.noteMasks.length, 2, "追加したマスクを二重に引き継がない");
});

test("更新で置き換わるまとめ側の変更を数える（両方で変えたマスク、元ノートが消したマスク、まとめで消したが元ノートで変わったマスク）", () => {
  const { content, entries } = summaryWith(
    { id: "m1", x: .1, y: .1, width: .2, height: .05 },
    { id: "m2", x: .1, y: .3, width: .2, height: .05 },
    { id: "m3", x: .1, y: .5, width: .2, height: .05 },
    { id: "m4", x: .1, y: .7, width: .2, height: .05 }
  );
  content.noteMasks[0].x += .05;
  content.noteMasks[1].underline = true;
  addInheritedMaskTombstones(content, [content.noteMasks[2]]);
  content.noteMasks = content.noteMasks.filter((_, index) => index !== 2);
  assert.equal(countSummaryMergeConflicts(content, slotA, entries), 0, "元ノートが変わっていなければ置き換わらない");
  const changed = entries
    .filter(entry => entry.key !== "note:m2")
    .map(entry => ["note:m1", "note:m3", "note:m4"].includes(entry.key) ? { ...entry, y: entry.y + .01 } : entry);
  assert.equal(countSummaryMergeConflicts(content, slotA, changed), 3, "m1（両方で変更）、m2（元で削除）、m3（まとめで削除・元で変更）。m4はまとめで変えていない");
});
