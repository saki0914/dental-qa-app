import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSessionBoundBackgroundBlob,
  loadSessionBoundMaterialDimensions
} from "../../js/core/note-session-loading.js";

function sessionHarness() {
  const session = { uid: "user-a", generation: 1 };
  let generation = session.generation;
  let checks = 0;
  return {
    session,
    assertUserSession(candidate) {
      checks += 1;
      if (candidate !== session || generation !== candidate.generation) {
        const error = new Error("session changed");
        error.name = "NoteSessionChangedError";
        throw error;
      }
    },
    changeSession() { generation += 1; },
    checks: () => checks
  };
}

test("背景blobはPDF Storage読込後のセッション切替を拒否する", async () => {
  const harness = sessionHarness();
  await assert.rejects(
    loadSessionBoundBackgroundBlob({
      page: { background: { type: "pdf-source-page", imagePath: "users/user-a/pdf/page.png" } },
      session: harness.session,
      assertUserSession: harness.assertUserSession,
      getStorageBlob: async (path, options) => {
        assert.equal(path, "users/user-a/pdf/page.png");
        assert.equal(options.expectedUid, "user-a");
        harness.changeSession();
        return new Blob(["pdf"]);
      },
      getMaterialSourcePage: () => null
    }),
    { name: "NoteSessionChangedError" }
  );
  assert.equal(harness.checks(), 2);
});

test("背景blobは教材Storage読込後のセッション切替を拒否する", async () => {
  const harness = sessionHarness();
  await assert.rejects(
    loadSessionBoundBackgroundBlob({
      page: { background: { type: "material-page" } },
      session: harness.session,
      assertUserSession: harness.assertUserSession,
      getStorageBlob: async (path, options) => {
        assert.equal(path, "users/user-a/material/page.png");
        assert.equal(options.expectedUid, "user-a");
        harness.changeSession();
        return new Blob(["material"]);
      },
      getMaterialSourcePage: () => ({ storagePath: "users/user-a/material/page.png" })
    }),
    { name: "NoteSessionChangedError" }
  );
  assert.equal(harness.checks(), 2);
});

test("背景blobは教材URLのfetch後とblob変換後にセッションを再確認する", async t => {
  await t.test("fetch後", async () => {
    const harness = sessionHarness();
    let blobCalled = false;
    await assert.rejects(
      loadSessionBoundBackgroundBlob({
        page: { background: { type: "material-page" } },
        session: harness.session,
        assertUserSession: harness.assertUserSession,
        getStorageBlob: async () => null,
        getMaterialSourcePage: () => ({ imageUrl: "https://example.test/page.png" }),
        fetchImpl: async () => {
          harness.changeSession();
          return { ok: true, blob: async () => { blobCalled = true; } };
        }
      }),
      { name: "NoteSessionChangedError" }
    );
    assert.equal(blobCalled, false);
    assert.equal(harness.checks(), 2);
  });

  await t.test("blob変換後", async () => {
    const harness = sessionHarness();
    await assert.rejects(
      loadSessionBoundBackgroundBlob({
        page: { background: { type: "material-page" } },
        session: harness.session,
        assertUserSession: harness.assertUserSession,
        getStorageBlob: async () => null,
        getMaterialSourcePage: () => ({ url: "https://example.test/page.png" }),
        fetchImpl: async () => ({
          ok: true,
          blob: async () => {
            harness.changeSession();
            return new Blob(["url"]);
          }
        })
      }),
      { name: "NoteSessionChangedError" }
    );
    assert.equal(harness.checks(), 3);
  });
});

test("教材寸法取得はデコード後のセッション切替を握り潰さない", async () => {
  const harness = sessionHarness();
  let warningCount = 0;
  await assert.rejects(
    loadSessionBoundMaterialDimensions({
      source: { imagePath: "users/user-a/material/page.png" },
      session: harness.session,
      assertUserSession: harness.assertUserSession,
      getStorageBlob: async () => new Blob(["material"]),
      decodeImageDimensions: async () => {
        harness.changeSession();
        return { naturalWidth: 100, naturalHeight: 200 };
      },
      warn: () => { warningCount += 1; }
    }),
    { name: "NoteSessionChangedError" }
  );
  assert.equal(harness.checks(), 3);
  assert.equal(warningCount, 0);
});

test("教材寸法取得は各非同期読込後のセッション切替を握り潰さない", async t => {
  const scenarios = [
    {
      name: "Storage読込後",
      source: { storagePath: "users/user-a/material/page.png" },
      configure(harness) {
        return {
          getStorageBlob: async (path, options) => {
            assert.equal(path, "users/user-a/material/page.png");
            assert.equal(options.expectedUid, "user-a");
            harness.changeSession();
            return new Blob(["storage"]);
          },
          fetchImpl: async () => { throw new Error("unexpected fetch"); }
        };
      }
    },
    {
      name: "URL fetch後",
      source: { imageUrl: "https://example.test/page.png" },
      configure(harness) {
        return {
          getStorageBlob: async () => { throw new Error("unexpected storage read"); },
          fetchImpl: async () => {
            harness.changeSession();
            return { ok: true, blob: async () => new Blob(["url"]) };
          }
        };
      }
    },
    {
      name: "URL blob変換後",
      source: { url: "https://example.test/page.png" },
      configure(harness) {
        return {
          getStorageBlob: async () => { throw new Error("unexpected storage read"); },
          fetchImpl: async () => ({
            ok: true,
            blob: async () => {
              harness.changeSession();
              return new Blob(["url"]);
            }
          })
        };
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = sessionHarness();
      let warningCount = 0;
      await assert.rejects(
        loadSessionBoundMaterialDimensions({
          source: scenario.source,
          session: harness.session,
          assertUserSession: harness.assertUserSession,
          ...scenario.configure(harness),
          decodeImageDimensions: async () => ({ naturalWidth: 100, naturalHeight: 200 }),
          warn: () => { warningCount += 1; }
        }),
        { name: "NoteSessionChangedError" }
      );
      assert.equal(warningCount, 0);
    });
  }
});

test("教材寸法取得は通常の取得失敗だけ既定比率へフォールバックする", async () => {
  const harness = sessionHarness();
  const warnings = [];
  const result = await loadSessionBoundMaterialDimensions({
    source: { imageUrl: "https://example.test/page.png" },
    session: harness.session,
    assertUserSession: harness.assertUserSession,
    getStorageBlob: async () => null,
    fetchImpl: async () => { throw new Error("network unavailable"); },
    warn: (...args) => warnings.push(args)
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /既定比率/);
});
