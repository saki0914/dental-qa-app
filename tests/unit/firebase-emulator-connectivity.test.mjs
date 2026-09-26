import assert from "node:assert/strict";
import test from "node:test";
import { verifyFirebaseEmulatorConnectivity } from "../../js/core/firebase-emulator-connectivity.js";

test("Storage Emulatorはno-corsでHTTP statusを問わずポート到達を確認する", async () => {
  const requests = [];
  const result = await verifyFirebaseEmulatorConnectivity("192.168.1.20", {
    retries: 1,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes(":9199/")) return { ok: false, status: 404, type: "opaque" };
      return { ok: true, status: 200 };
    }
  });
  assert.deepEqual(result, { Auth: true, Firestore: true, Storage: true });
  const storageRequest = requests.find(request => request.url === "http://192.168.1.20:9199/");
  assert.equal(storageRequest.options.mode, "no-cors");
  assert.equal(storageRequest.options.cache, "no-store");
});

test("Storage Emulatorポートが停止している場合だけ疎通失敗にする", async () => {
  await assert.rejects(
    verifyFirebaseEmulatorConnectivity("127.0.0.1", {
      retries: 1,
      fetchImpl: async url => {
        if (url.includes(":9199/")) throw new TypeError("fetch failed");
        return { ok: true, status: 200 };
      }
    }),
    error => {
      assert.match(error.message, /Storage Emulatorへ接続できません/);
      assert.deepEqual(error.results, { Auth: true, Firestore: true, Storage: false });
      return true;
    }
  );
});
