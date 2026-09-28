import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { sha256Hex, sha256HexSync } from "../../js/core/sha256.js";

const nodeDigest = bytes => createHash("sha256").update(bytes).digest("hex");

test("既知のSHA-256テストベクトルと一致する", () => {
  assert.equal(sha256HexSync(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256HexSync("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256HexSync("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
});

test("ブロック境界と日本語を含む任意長の入力でNode.jsの実装と一致する", () => {
  for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096]) {
    const bytes = new Uint8Array(length).map((_, index) => (index * 31 + length) & 0xff);
    assert.equal(sha256HexSync(bytes), nodeDigest(bytes), `length ${length}`);
  }
  const text = JSON.stringify({ text: "歯科衛生士の日本語ノート", elements: [{ x: 0.1 }] });
  assert.equal(sha256HexSync(text), nodeDigest(Buffer.from(text, "utf8")));
});

test("crypto.subtleがないHTTP環境でも同じ内容は同じhashになる", async () => {
  const bytes = new TextEncoder().encode("{\"revision\":1}");
  const withSubtle = await sha256Hex(bytes);
  const withoutSubtle = await sha256Hex(bytes, { subtle: undefined });
  const again = await sha256Hex(bytes, { subtle: undefined });
  assert.equal(withoutSubtle, withSubtle);
  assert.equal(again, withoutSubtle, "時刻に依存しない");
  const failingSubtle = { digest: async () => { throw new Error("not allowed"); } };
  assert.equal(await sha256Hex(bytes, { subtle: failingSubtle }), withSubtle);
});
