// Writes the versions of the JS modules and style sheets into index.html
// (see scripts/lib/asset-versions.mjs). Run after changing any of them.
import { readFileSync, writeFileSync } from "node:fs";
import { assetVersionProblems, computeAssetVersions, stampIndexHtml } from "./lib/asset-versions.mjs";

const assets = computeAssetVersions(".");
const html = readFileSync("index.html", "utf8");
const stamped = stampIndexHtml(html, assets);
const problems = assetVersionProblems(stamped, assets);
if (problems.length) throw new Error(`index.htmlの版を書き込めませんでした:\n${problems.join("\n")}`);
if (stamped !== html) writeFileSync("index.html", stamped);
console.log(`stamp OK: build ${assets.build} (${assets.modules.length} modules, ${assets.styles.length} style sheets)${stamped === html ? ", unchanged" : ""}`);
