import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

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

for (const file of readdirSync("js").filter(file => file.endsWith(".js")).sort()) {
  execFileSync(process.execPath, ["--check", `js/${file}`], { stdio: "inherit" });
}

console.log("check OK");
