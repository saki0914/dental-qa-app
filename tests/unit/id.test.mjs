import assert from "node:assert/strict";
import test from "node:test";
import { randomId } from "../../js/core/id.js";

test("secure contextではrandomUUIDを優先する", () => {
  let fallbackCalled = false;
  const value = randomId({
    randomUUID: () => "native-uuid",
    getRandomValues: () => { fallbackCalled = true; }
  });
  assert.equal(value, "native-uuid");
  assert.equal(fallbackCalled, false);
});

test("LAN HTTP相当でrandomUUIDがなくてもgetRandomValuesからUUID v4を生成する", () => {
  const value = randomId({
    getRandomValues(bytes) {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    }
  });
  assert.equal(value, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("LAN HTTPでrandomUUID呼出しが拒否されてもgetRandomValuesへフォールバックする", () => {
  const value = randomId({
    randomUUID() { throw new DOMException("insecure context", "SecurityError"); },
    getRandomValues(bytes) {
      bytes.fill(255);
      return bytes;
    }
  });
  assert.equal(value, "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("暗号学的乱数を利用できない環境ではID生成を停止する", () => {
  assert.throws(() => randomId({}), /安全なIDを生成できません/);
});
