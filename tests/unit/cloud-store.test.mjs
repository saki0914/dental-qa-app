import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../helpers/cloud-store-loader.mjs", import.meta.url);
const {
  getCloudStoreReadPaths,
  resetCloudStoreFirebaseStubs
} = await import("../helpers/cloud-store-firebase-stubs.mjs");
const { readNoteEditorMaterialState } = await import("../../js/services/cloud-store.js?note-editor-material-state");

const mainPath = "users/alice/app/main";
const splitPath = "users/alice/app/pdfMaterials";
const materialState = {
  pdfMaterials: [{ id: "material-1" }],
  pdfRevealStates: { "material-1": true },
  selectedPdfId: "material-1",
  selectedMaskId: null,
  pdfSearchQuery: "search"
};

test("専用エディタは分割教材文書があればlegacy mainを読まない", async () => {
  resetCloudStoreFirebaseStubs({
    [splitPath]: { ...materialState, unrelated: "ignored" },
    [mainPath]: { ...materialState, legacy: true }
  });

  const result = await readNoteEditorMaterialState({}, "alice");

  assert.deepEqual(result, { hasData: true, source: "split", state: materialState });
  assert.deepEqual(getCloudStoreReadPaths(), [splitPath]);
});

test("分割教材文書が未整備ならlegacy mainから教材項目だけを抽出する", async () => {
  resetCloudStoreFirebaseStubs({
    [mainPath]: { ...materialState, unrelatedLargeState: "x".repeat(1024) }
  });

  const result = await readNoteEditorMaterialState({}, "alice");

  assert.deepEqual(result, { hasData: true, source: "legacy", state: materialState });
  assert.deepEqual(getCloudStoreReadPaths(), [splitPath, mainPath]);
  assert.equal(Object.hasOwn(result.state, "unrelatedLargeState"), false);
});

test("空の分割教材文書は移行完了と誤認せずlegacy mainへfallbackする", async () => {
  resetCloudStoreFirebaseStubs({
    [splitPath]: { schemaVersion: 1 },
    [mainPath]: materialState
  });

  const result = await readNoteEditorMaterialState({}, "alice");

  assert.equal(result.source, "legacy");
  assert.deepEqual(result.state, materialState);
  assert.deepEqual(getCloudStoreReadPaths(), [splitPath, mainPath]);
});
