import test from "node:test";
import assert from "node:assert/strict";
import {
  createNoteEditorDiagnosticSnapshot,
  rebaseRecoveredNoteContent,
  reorderNoteMasks,
  resolveNoteEditorTabId,
  sanitizeDiagnosticUrlParameters,
  saveStatePresentation,
  selectNoteFeatureUser,
  shouldRecoverLocalNoteState
} from "../../js/core/note-editor-state.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    values
  };
}

test("同じタブの再読み込みはsessionStorageのeditorTabIdを再利用する", () => {
  const storage = memoryStorage();
  const first = resolveNoteEditorTabId({ uid: "user", routeEditorTabId: "route-a", storage, createId: () => "generated" });
  const reloaded = resolveNoteEditorTabId({ uid: "user", routeEditorTabId: "route-a", storage, createId: () => "other" });
  assert.equal(first.value, "route-a");
  assert.equal(reloaded.value, "route-a");
});

test("新しい編集URLはopenerから複製されたsessionStorageよりroute tokenを優先する", () => {
  const storage = memoryStorage({ "dentalQaNoteEditorTab:user": "old-tab" });
  const result = resolveNoteEditorTabId({ uid: "user", routeEditorTabId: "new-tab", storage, createId: () => "generated" });
  assert.equal(result.value, "new-tab");
  assert.equal(storage.values.get(result.key), "new-tab");
});

test("editorTabIdのない直URLは複製されたsessionStorageを使わず新規生成する", () => {
  const storage = memoryStorage({ "dentalQaNoteEditorTab:user": "cloned-tab" });
  const result = resolveNoteEditorTabId({ uid: "user", storage, createId: () => "fresh-tab" });
  assert.equal(result.value, "fresh-tab");
  assert.equal(result.matchedStoredValue, false);
});

test("復元コピーはnote/page/revision/writer系列と要素IDを新しくする", () => {
  let serial = 0;
  const result = rebaseRecoveredNoteContent({
    schemaVersion: 1,
    noteId: "source-note",
    pageId: "source-page",
    revision: 9,
    savedAt: "old",
    writerSessionId: "old-writer",
    clientMutationId: "old-mutation",
    baseRevision: 8,
    elements: [
      { id: "stroke-old", type: "stroke", points: [] },
      { id: "image-old", type: "image", assetId: "asset-a", bounds: { x: 0, y: 0, width: .5, height: .5 } }
    ],
    noteMasks: [{ id: "mask-old", x: .1, y: .1, width: .2, height: .2 }]
  }, {
    noteId: "copy-note",
    pageId: "copy-page",
    sourceNoteId: "source-note",
    createId: () => `new-${++serial}`
  });
  assert.equal(result.noteId, "copy-note");
  assert.equal(result.pageId, "copy-page");
  assert.equal(result.revision, 0);
  assert.equal(result.savedAt, "");
  assert.equal(result.writerSessionId, undefined);
  assert.equal(result.clientMutationId, undefined);
  assert.equal(result.baseRevision, undefined);
  assert.deepEqual(result.elements.map(item => item.id), ["new-1", "new-2"]);
  assert.equal(result.elements[1].assetNoteId, "source-note");
  assert.equal(result.noteMasks[0].id, "new-3");
});

test("保存状態表示は固定アイコンと説明へ正規化する", () => {
  assert.equal(saveStatePresentation("saving").icon, "◌");
  assert.equal(saveStatePresentation("saving").shortLabel, "保存中");
  assert.equal(saveStatePresentation("saved").shortLabel, "保存済み");
  assert.ok([...saveStatePresentation("recoverable-error").shortLabel].length > 4);
  assert.match(saveStatePresentation("recoverable-error").label, /端末内/);
  assert.match(saveStatePresentation("local-storage-error").label, /端末内への保存に失敗/);
  assert.equal(saveStatePresentation("unknown").label, "待機中");
});

test("クラウド版を明示した場合は端末内下書きと画像を自動再送しない", () => {
  assert.equal(shouldRecoverLocalNoteState(), true);
  assert.equal(shouldRecoverLocalNoteState({ readOnly: true }), false);
  assert.equal(shouldRecoverLocalNoteState({ preferCloud: true }), false);
});

test("前面・背面変更はnoteMasks内だけを安定して並べ替え、教材マスク順を変えない", () => {
  const materialMasks = [{ id: "material-a" }, { id: "material-b" }];
  const noteMasks = [{ id: "note-a" }, { id: "note-b" }, { id: "note-c" }];
  const front = reorderNoteMasks(noteMasks, ["note-a", "note-c"], "front");
  const back = reorderNoteMasks(noteMasks, ["note-c"], "back");
  assert.deepEqual(front.map(mask => mask.id), ["note-b", "note-a", "note-c"]);
  assert.deepEqual(back.map(mask => mask.id), ["note-c", "note-a", "note-b"]);
  assert.deepEqual(materialMasks.map(mask => mask.id), ["material-a", "material-b"]);
  assert.deepEqual([...materialMasks, ...front].map(mask => mask.id), ["material-a", "material-b", "note-b", "note-a", "note-c"]);
});

test("診断情報は許可項目だけを残し本文・token・passwordを含めない", () => {
  const result = createNoteEditorDiagnosticSnapshot({
    noteId: "note-a",
    pageId: "page-a",
    saveState: "recoverable-error",
    noteContent: "secret body",
    firebaseToken: "secret token",
    password: "secret password"
  });
  assert.deepEqual(result, { noteId: "note-a", pageId: "page-a", saveState: "recoverable-error" });
});

test("診断URLは既知の接続・編集識別子だけを残す", () => {
  const result = sanitizeDiagnosticUrlParameters(new URLSearchParams({
    firebaseEmulator: "1",
    emulatorHost: "192.168.1.126",
    noteId: "note-a",
    token: "secret-token",
    body: "secret body",
    content: "secret content"
  }).entries());
  assert.deepEqual(result, {
    firebaseEmulator: "1",
    emulatorHost: "192.168.1.126",
    noteId: "note-a"
  });
});

test("専用エディタはアプリ全体同期失敗中も認証ユーザーで復旧できる", () => {
  const user = { uid: "user-a" };
  assert.equal(selectNoteFeatureUser({ dedicatedEditor: true, user, interactionReady: false }), user);
  assert.equal(selectNoteFeatureUser({ dedicatedEditor: false, user, interactionReady: false }), null);
  assert.equal(selectNoteFeatureUser({ dedicatedEditor: false, user, interactionReady: true }), user);
});
