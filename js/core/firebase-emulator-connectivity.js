const DEFAULT_EMULATOR_PROJECT_ID = "demo-dental-qa";

async function fetchWithTimeout(url, fetchImpl, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      cache: "no-store",
      ...(options.request || {})
    });
    if (!options.acceptAnyResponse && !response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyFirebaseEmulatorConnectivity(emulatorHost, {
  fetchImpl = globalThis.fetch,
  // Keep each probe bounded, but do not report a healthy local service as down.
  timeoutMs = 8000,
  retries = 3,
  onStatus = () => {},
  projectId = DEFAULT_EMULATOR_PROJECT_ID
} = {}) {
  if (!emulatorHost || typeof fetchImpl !== "function") throw new Error("Emulator疎通確認を開始できません。");
  const encodedProject = encodeURIComponent(projectId);
  const checks = [
    { name: "Auth", url: `http://${emulatorHost}:9099/emulator/v1/projects/${encodedProject}/config` },
    // ruleCoverageは長時間の検証後に評価履歴の集計で数秒以上かかり、正常な
    // Emulatorを停止中と誤判定してエディタ起動を失敗させる。Firestoreも
    // ルートへのno-cors到達確認だけを行う（停止時はfetch自体が失敗する）。
    { name: "Firestore", url: `http://${emulatorHost}:8080/`, request: { mode: "no-cors" }, acceptAnyResponse: true },
    // Storage EmulatorにはRulesに依存しない公開health endpointがないため、
    // no-corsでポートからHTTP応答が返ることだけを確認する。停止時はfetch自体が失敗する。
    { name: "Storage", url: `http://${emulatorHost}:9199/`, request: { mode: "no-cors" }, acceptAnyResponse: true }
  ];
  const results = {};
  await Promise.all(checks.map(async ({ name, url, request, acceptAnyResponse }) => {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        await fetchWithTimeout(url, fetchImpl, timeoutMs, { request, acceptAnyResponse });
        results[name] = true;
        onStatus(name, "connected");
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < retries) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    results[name] = false;
    onStatus(name, "failed", lastError);
  }));
  const failed = Object.entries(results).filter(([, connected]) => !connected).map(([name]) => name);
  if (failed.length) {
    const error = new Error(`${failed.join(" / ")} Emulatorへ接続できませんでした。3サービスが揃うまで操作を開始できません。`);
    error.results = results;
    throw error;
  }
  return results;
}
