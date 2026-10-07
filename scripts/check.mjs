import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assetVersionProblems, computeAssetVersions } from "./lib/asset-versions.mjs";

const jsonFiles = [
  "package.json",
  ".devcontainer/devcontainer.json",
  "firebase.json",
  ".firebaserc"
];

for (const file of jsonFiles) {
  JSON.parse(readFileSync(file, "utf8"));
}

const html = readFileSync("index.html", "utf8");
if (!/<script type="module" src="\.\/js\/app\.js\?v=[0-9a-f]+"><\/script>/.test(html)) {
  throw new Error("index.html must load ./js/app.js as an external module");
}
// Every JS module and style sheet is loaded by a URL with its current
// version, so that a release is never served from a browser's cache.
const assetProblems = assetVersionProblems(html, computeAssetVersions("."));
if (assetProblems.length) {
  throw new Error(`index.htmlの資産の版が古い。npm run stamp を実行してください:\n${assetProblems.join("\n")}`);
}
if (/<script type="module">/.test(html)) {
  throw new Error("inline module script remains in index.html");
}

function collectJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectJavaScriptFiles(path) : [path];
    })
    .filter(file => file.endsWith(".js"));
}

for (const file of collectJavaScriptFiles("js").sort()) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log("check OK");
