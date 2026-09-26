import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const dataDir = resolve(".firebase-emulator-data");
const hubOnline = await fetch("http://127.0.0.1:4400/emulators", { signal: AbortSignal.timeout(800) })
  .then(response => response.ok)
  .catch(() => false);
if (hubOnline) {
  throw new Error("Firebase Emulatorを停止してから local:reset を実行してください。");
}
if (existsSync(dataDir)) await rm(dataDir, { recursive: true, force: true });

const command = [
  "firebase", "emulators:exec",
  "--project", "demo-dental-qa",
  "--only", "auth,firestore,storage",
  "--export-on-exit", ".firebase-emulator-data",
  "node scripts/local-seed.mjs"
];
const result = spawnSync("npx", command, { stdio: "inherit", shell: false });
if (result.status !== 0) process.exit(result.status || 1);
console.log("ローカルEmulatorデータを初期化しました。");
console.log("ブラウザのノート下書きは、設定画面または開発者ツールから dentalQaNoteLocal を削除してください。");
