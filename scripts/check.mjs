import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
if (!html.includes('<script type="module" src="./js/app.js"></script>')) {
  throw new Error("index.html must load ./js/app.js as an external module");
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
