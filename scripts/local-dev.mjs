import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

const lan = process.argv.includes("--lan");
const findLanAddress = () => Object.values(networkInterfaces())
  .flat()
  .find(item => item && item.family === "IPv4" && !item.internal)?.address;
const publicHost = lan ? findLanAddress() : "localhost";
if (!publicHost) throw new Error("LAN用IPv4アドレスを取得できませんでした。");
const emulatorHost = lan ? "0.0.0.0" : "127.0.0.1";
const dataArgs = existsSync(".firebase-emulator-data/firebase-export-metadata.json")
  ? ["--import", ".firebase-emulator-data"]
  : [];
const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    detached: process.platform !== "win32",
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.on("exit", code => {
    if (code && !shuttingDown) void shutdown(code, { terminateChildren: true });
  });
  return child;
}

let shuttingDown = false;
const waitForExit = child => child.exitCode != null || child.signalCode
  ? Promise.resolve()
  : new Promise(resolve => child.once("exit", resolve));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function shutdown(code = 0, { terminateChildren = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (terminateChildren) {
    children.filter(child => child.exitCode == null && !child.signalCode).forEach(child => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    });
  }
  let exited = false;
  await Promise.race([
    Promise.all(children.map(waitForExit)).then(() => { exited = true; }),
    delay(15_000)
  ]);
  if (!exited) {
    children.filter(child => child.exitCode == null && !child.signalCode).forEach(child => child.kill("SIGTERM"));
    await Promise.race([Promise.all(children.map(waitForExit)), delay(2_000)]);
  }
  process.exit(code);
}
process.on("SIGINT", () => { void shutdown(0, { terminateChildren: true }); });
process.on("SIGTERM", () => { void shutdown(0, { terminateChildren: true }); });

start("npx", [
  "firebase", "emulators:start",
  "--project", "demo-dental-qa",
  "--only", "auth,firestore,storage",
  ...dataArgs,
  "--export-on-exit", ".firebase-emulator-data"
], { FIREBASE_AUTH_EMULATOR_HOST: `${emulatorHost}:9099` });
start("npx", ["http-server", ".", "-a", lan ? "0.0.0.0" : "127.0.0.1", "-p", "3000", "-c-1"]);

async function waitFor(url, { attempts = 240, requireOk = true } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await fetch(url).then(response => requireOk ? response.ok : true).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${url} を起動できませんでした。`);
}

try {
  await Promise.all([
    waitFor("http://127.0.0.1:3000/index.html"),
    waitFor("http://127.0.0.1:4000/", { requireOk: false }),
    waitFor("http://127.0.0.1:8080/", { requireOk: false }),
    waitFor("http://127.0.0.1:9099/", { requireOk: false }),
    waitFor("http://127.0.0.1:9199/", { requireOk: false })
  ]);
  const seed = spawn("node", ["scripts/local-seed.mjs"], {
    stdio: "inherit",
    env: { ...process.env, DENTAL_LOCAL_HOST: "127.0.0.1" }
  });
  children.push(seed);
  await new Promise((resolve, reject) => {
    seed.on("exit", code => code === 0 ? resolve() : reject(new Error("ローカル初期データ作成に失敗しました。")));
  });
  const query = lan
    ? `?firebaseEmulator=1&emulatorHost=${encodeURIComponent(publicHost)}`
    : "?firebaseEmulator=1";
  console.log("\nDental QA App ローカル確認環境");
  console.log(`アプリ: http://${publicHost}:3000/${query}`);
  console.log(`Firebase Emulator UI: http://${publicHost}:4000`);
  console.log("ローカル確認用ユーザー: local-note-test@example.com");
  console.log("パスワード: LocalNoteTest123!");
  if (lan) console.log("信頼できる同一LAN専用です。公共Wi-Fiでは使用せず、確認後は終了してください。");
} catch (error) {
  console.error(error);
  void shutdown(1, { terminateChildren: true });
}

await new Promise(() => {});
