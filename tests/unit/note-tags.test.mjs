import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTE_TAG_FILTER_ALL,
  NOTE_TAG_FILTER_NONE,
  NOTE_TAG_MAX_COUNT,
  NOTE_TAG_MAX_LENGTH,
  buildNoteTagTree,
  countUntaggedNotes,
  describeNoteTagFilter,
  filterNotesByTag,
  flattenNoteTagTree,
  isNoteTagWithin,
  matchesNoteTagFilter,
  noteMatchesQuery,
  noteTagAncestors,
  noteTagName,
  normalizeNoteTag,
  normalizeNoteTags,
  removeNoteTagFromList,
  renameNoteTagInList,
  sameNoteTags
} from "../../js/core/note-tags.js";

test("タグは全角・半角をそろえ、先頭の#と空の階層を取り、各階層の前後の空白を除く", () => {
  assert.equal(normalizeNoteTag("  #口腔解剖学 / ４章 "), "口腔解剖学/4章");
  assert.equal(normalizeNoteTag("＃国試対策／ Ａ問題"), "国試対策/A問題");
  assert.equal(normalizeNoteTag("a//b/"), "a/b");
  assert.equal(normalizeNoteTag("歯科   予防"), "歯科 予防");
  assert.equal(normalizeNoteTag("改\n行"), "改 行");
  assert.equal(normalizeNoteTag("  # / "), "", "何も残らなければタグにしない");
  assert.equal(normalizeNoteTag("x".repeat(NOTE_TAG_MAX_LENGTH)), "x".repeat(NOTE_TAG_MAX_LENGTH));
  assert.equal(normalizeNoteTag("x".repeat(NOTE_TAG_MAX_LENGTH + 1)), "", "長すぎるタグは付けない");
});

test("大文字・小文字だけ違うタグは1つにまとめ、最初の書き方を残す。数には上限がある", () => {
  assert.deepEqual(normalizeNoteTags(["Anatomy", "anatomy", "#ANATOMY", "生化学", "", null, "生化学 "]), ["Anatomy", "生化学"]);
  const many = Array.from({ length: NOTE_TAG_MAX_COUNT + 5 }, (_, index) => `t${index}`);
  assert.equal(normalizeNoteTags(many).length, NOTE_TAG_MAX_COUNT);
  assert.deepEqual(normalizeNoteTags("not a list"), []);
  assert.equal(sameNoteTags(["a", "b"], ["a", " b "]), true);
  assert.equal(sameNoteTags(["a", "b"], ["b", "a"]), false, "順番も見る");
});

test("入れ子のタグ: 親を選ぶと下の階層のタグを持つノートも入る。名前の一部が同じだけのタグは入らない", () => {
  assert.deepEqual(noteTagAncestors("口腔解剖学/4章/発生"), ["口腔解剖学", "口腔解剖学/4章", "口腔解剖学/4章/発生"]);
  assert.equal(noteTagName("口腔解剖学/4章"), "4章");
  assert.equal(isNoteTagWithin("口腔解剖学/4章", "口腔解剖学"), true);
  assert.equal(isNoteTagWithin("口腔解剖学", "口腔解剖学"), true);
  assert.equal(isNoteTagWithin("口腔解剖学2", "口腔解剖学"), false);
  assert.equal(isNoteTagWithin("口腔解剖学", "口腔解剖学/4章"), false, "子を選んでも親だけのノートは入らない");
  assert.equal(isNoteTagWithin("Anatomy/Head", "anatomy"), true, "大文字・小文字は区別しない");
  const nested = { tags: ["口腔解剖学/4章"] };
  const untagged = { tags: [] };
  assert.equal(matchesNoteTagFilter(nested, NOTE_TAG_FILTER_ALL), true);
  assert.equal(matchesNoteTagFilter(nested, "口腔解剖学"), true);
  assert.equal(matchesNoteTagFilter(nested, NOTE_TAG_FILTER_NONE), false);
  assert.equal(matchesNoteTagFilter(untagged, NOTE_TAG_FILTER_NONE), true);
  assert.equal(matchesNoteTagFilter({}, NOTE_TAG_FILTER_NONE), true, "tagsのない以前のノートはタグなし");
  assert.equal(describeNoteTagFilter("口腔解剖学"), "#口腔解剖学");
  assert.equal(describeNoteTagFilter(NOTE_TAG_FILTER_NONE), "タグなし");
  assert.equal(describeNoteTagFilter(NOTE_TAG_FILTER_ALL), "すべてのノート");
});

test("検索はノート名とタグ名から、すべての語を含むノートを探す（全角・半角、大文字・小文字は区別しない）", () => {
  const note = { title: "鰓弓と神経 ノート", tags: ["口腔解剖学/4章", "国試対策"] };
  assert.equal(noteMatchesQuery(note, ""), true);
  assert.equal(noteMatchesQuery(note, "鰓弓"), true);
  assert.equal(noteMatchesQuery(note, "＃国試"), true, "#を付けてもタグを探せる");
  assert.equal(noteMatchesQuery(note, "4章 鰓弓"), true);
  assert.equal(noteMatchesQuery(note, "４章　神経"), true);
  assert.equal(noteMatchesQuery(note, "鰓弓 生化学"), false);
  const notes = [
    note,
    { title: "生化学ドリル", tags: ["生化学"] },
    { title: "白紙", tags: [] }
  ];
  assert.deepEqual(filterNotesByTag(notes, { tag: "口腔解剖学" }).map(item => item.title), ["鰓弓と神経 ノート"]);
  assert.deepEqual(filterNotesByTag(notes, { tag: NOTE_TAG_FILTER_NONE }).map(item => item.title), ["白紙"]);
  assert.deepEqual(filterNotesByTag(notes, { query: "ドリル" }).map(item => item.title), ["生化学ドリル"]);
  assert.deepEqual(filterNotesByTag(notes, { tag: "生化学", query: "鰓弓" }), [], "タグと検索の両方に合うノートだけ");
});

test("タグの木: 階層ごとに名前順（数字は数の順）で、件数はそのタグか下のタグを持つノートの数", () => {
  const notes = [
    { tags: ["口腔解剖学/10章", "国試対策"] },
    { tags: ["口腔解剖学/2章"] },
    { tags: ["口腔解剖学", "口腔解剖学/2章"] },
    { tags: ["Biochem"] },
    { tags: ["biochem/enzymes"] },
    { tags: [] }
  ];
  const tree = buildNoteTagTree(notes);
  assert.deepEqual(tree.map(node => [node.name, node.count]), [["Biochem", 2], ["口腔解剖学", 3], ["国試対策", 1]]);
  const anatomy = tree.find(node => node.name === "口腔解剖学");
  assert.deepEqual(anatomy.children.map(node => [node.tag, node.count, node.depth]), [["口腔解剖学/2章", 2, 1], ["口腔解剖学/10章", 1, 1]]);
  assert.equal(tree[0].children[0].tag, "Biochem/enzymes", "子のタグは親の最初の書き方でつなぐ");
  const rows = flattenNoteTagTree(tree);
  assert.deepEqual(rows.map(row => row.tag), ["Biochem", "Biochem/enzymes", "口腔解剖学", "口腔解剖学/2章", "口腔解剖学/10章", "国試対策"]);
  assert.equal(rows.find(row => row.tag === "口腔解剖学").hasChildren, true);
  assert.equal(countUntaggedNotes(notes), 1);
});

test("タグ名の変更は下の階層にも及び、重なったタグは1つになる。削除は下の階層ごと外す", () => {
  assert.deepEqual(renameNoteTagInList(["解剖/4章", "解剖", "生化学"], "解剖", "口腔解剖学"), ["口腔解剖学/4章", "口腔解剖学", "生化学"]);
  assert.deepEqual(renameNoteTagInList(["解剖/4章"], "解剖/4章", "解剖/第4章"), ["解剖/第4章"]);
  assert.deepEqual(renameNoteTagInList(["解剖", "口腔解剖学"], "解剖", "口腔解剖学"), ["口腔解剖学"], "同じタグになれば1つ");
  assert.deepEqual(renameNoteTagInList(["解剖2"], "解剖", "口腔解剖学"), ["解剖2"], "名前の一部が同じだけのタグは変えない");
  assert.deepEqual(renameNoteTagInList(["解剖"], "解剖", "  "), ["解剖"], "空の名前には変えない");
  assert.deepEqual(removeNoteTagFromList(["解剖", "解剖/4章", "解剖2", "生化学"], "解剖"), ["解剖2", "生化学"]);
  assert.deepEqual(removeNoteTagFromList(["解剖", "解剖/4章"], "解剖/4章"), ["解剖"], "子を消しても親は残る");
});
