import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../helpers/firebase-browser-import-loader.mjs", import.meta.url);
const { createNoteStore } = await import("../../js/services/note-store.js");

test("全NoteStore APIはexpectedUidなしでFirebase SDKへ到達しない", async () => {
  let contextCalls = 0;
  const store = createNoteStore({
    getDb: () => { contextCalls += 1; return null; },
    getStorage: () => { contextCalls += 1; return null; },
    getUser: () => { contextCalls += 1; return null; }
  });
  const blob = new Blob(["x"], { type: "image/png" });
  const calls = {
    listNotes: () => store.listNotes(),
    getNote: () => store.getNote("note"),
    listNotesByMaterial: () => store.listNotesByMaterial("material"),
    listPages: () => store.listPages("note"),
    createNote: () => store.createNote({ pages: [] }),
    createCreatingNote: () => store.createCreatingNote("note", {}),
    finalizeCreatingNote: () => store.finalizeCreatingNote("note", []),
    finalizeNoteCreation: () => store.finalizeNoteCreation("note", 0),
    abortCreatingNote: () => store.abortCreatingNote("note"),
    cleanupStuckCreatingNotes: () => store.cleanupStuckCreatingNotes(),
    markCreationFailed: () => store.markCreationFailed("note"),
    journalSourcePages: () => store.journalSourcePages("note", ["page"]),
    uploadSourcePage: () => store.uploadSourcePage("note", "page", blob),
    deleteStoragePaths: () => store.deleteStoragePaths([]),
    loadPageContent: () => store.loadPageContent("note", { pageId: "page", contentPath: "" }),
    savePageContent: () => store.savePageContent({ noteId: "note", pageId: "page", expectedRevision: 0 }, {}),
    uploadAsset: () => store.uploadAsset("note", blob),
    getAsset: () => store.getAsset("note", "asset"),
    getStorageBlob: () => store.getStorageBlob("users/u/notes/n/file.json"),
    cleanupStoragePath: () => store.cleanupStoragePath("users/u/notes/n/file.json"),
    updatePageOrder: () => store.updatePageOrder("note", [], 0),
    createPage: () => store.createPage("note", { pageId: "page" }, 1, 0),
    deletePage: () => store.deletePage("note", "page", [{ pageId: "remaining" }], 0),
    updatePage: () => store.updatePage("note", "page", {}),
    updateNote: () => store.updateNote("note", {}),
    deleteMaterialLinkedNotes: () => store.deleteMaterialLinkedNotes([], "material-deleted"),
    restoreNote: () => store.restoreNote("note"),
    deleteNote: () => store.deleteNote("note")
  };

  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call, error => {
      assert.match(error.message, /expectedUid/, name);
      return true;
    });
  }
  assert.equal(contextCalls, 0);
});
