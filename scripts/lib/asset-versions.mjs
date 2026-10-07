// Versions of the app's JavaScript modules and style sheets (revision 13).
//
// GitHub Pages serves every file with `Cache-Control: max-age=600`, so for up
// to ten minutes after a release a browser keeps running the JS and CSS it
// fetched before (and could mix old and new modules). index.html therefore
// loads every asset by a URL that carries a hash of its content: the style
// sheets and the entry module directly, the other modules through an import
// map. A changed file gets a new URL, which no cache holds. The note editor's
// URL is new for every tab, so its HTML (with the new URLs) always comes from
// the server: opening a note after a release runs the release.
//
// `npm run stamp` writes the versions into index.html; `npm run check` fails
// when they no longer match the files.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const ASSET_VERSIONS_START = "<!-- asset-versions:start (npm run stamp) -->";
export const ASSET_VERSIONS_END = "<!-- asset-versions:end -->";

const VERSION_LENGTH = 10;

export function assetVersion(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, VERSION_LENGTH);
}

function collectFiles(root, directory, extension) {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .flatMap(entry => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? collectFiles(root, path, extension) : [path];
    })
    .filter(path => path.endsWith(extension))
    .sort();
}

// { modules: ["js/app.js", ...], styles: ["css/app.css", ...], versions: Map(path -> version), build }
export function computeAssetVersions(root = ".") {
  const modules = collectFiles(root, "js", ".js");
  const styles = collectFiles(root, "css", ".css");
  const versions = new Map([...modules, ...styles].map(path => [path, assetVersion(readFileSync(join(root, path)))]));
  const build = assetVersion([...versions].map(([path, version]) => `${path} ${version}`).join("\n"));
  return { modules, styles, versions, build };
}

const versioned = (path, versions) => `./${path}?v=${versions.get(path)}`;

export function assetVersionsBlock({ modules, versions, build }) {
  const imports = modules.map(path => `      "./${path}": "${versioned(path, versions)}"`).join(",\n");
  return [
    ASSET_VERSIONS_START,
    `  <meta name="app-build" content="${build}">`,
    "  <script type=\"importmap\">",
    "  {",
    "    \"imports\": {",
    imports,
    "    }",
    "  }",
    "  </script>",
    `  ${ASSET_VERSIONS_END}`
  ].join("\n");
}

const STYLE_LINK = /<link rel="stylesheet" href="\.\/(css\/[^"?]+\.css)(?:\?v=[0-9a-f]+)?">/g;
const ENTRY_SCRIPT = /<script type="module" src="\.\/js\/app\.js(?:\?v=[0-9a-f]+)?"><\/script>/;

// index.html with the current versions written in.
export function stampIndexHtml(html, assets) {
  let next = html;
  const start = next.indexOf(ASSET_VERSIONS_START);
  const end = next.indexOf(ASSET_VERSIONS_END);
  if (start >= 0 && end > start) {
    next = next.slice(0, start) + assetVersionsBlock(assets) + next.slice(end + ASSET_VERSIONS_END.length);
  } else {
    // First stamp: the block goes before the first style sheet.
    const firstStyle = next.search(/<link rel="stylesheet"/);
    if (firstStyle < 0) throw new Error("index.htmlにスタイルシートの読み込みがありません。");
    next = `${next.slice(0, firstStyle)}${assetVersionsBlock(assets)}\n  ${next.slice(firstStyle)}`;
  }
  next = next.replace(STYLE_LINK, (match, path) => (
    assets.versions.has(path) ? `<link rel="stylesheet" href="${versioned(path, assets.versions)}">` : match
  ));
  if (!ENTRY_SCRIPT.test(next)) throw new Error("index.htmlに./js/app.jsの読み込みがありません。");
  next = next.replace(ENTRY_SCRIPT, `<script type="module" src="${versioned("js/app.js", assets.versions)}"></script>`);
  return next;
}

// What in index.html does not match the current files (empty when stamped).
export function assetVersionProblems(html, assets) {
  const problems = [];
  const start = html.indexOf(ASSET_VERSIONS_START);
  const end = html.indexOf(ASSET_VERSIONS_END);
  if (start < 0 || end < start) return ["index.htmlに資産の版の欄（asset-versions）がありません。"];
  const block = html.slice(start, end);
  const build = /<meta name="app-build" content="([0-9a-f]+)">/.exec(block)?.[1];
  if (build !== assets.build) problems.push(`app-buildが${build || "なし"}です（${assets.build}が正しい）。`);
  let imports = {};
  try {
    imports = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(block)?.[1] || "{}").imports || {};
  } catch (error) {
    problems.push(`import mapを読めません: ${error.message}`);
  }
  for (const path of assets.modules) {
    const expected = versioned(path, assets.versions);
    if (imports[`./${path}`] !== expected) problems.push(`${path}: import mapが${imports[`./${path}`] || "なし"}です（${expected}が正しい）。`);
  }
  for (const key of Object.keys(imports)) {
    if (!assets.modules.includes(key.replace(/^\.\//, ""))) problems.push(`import mapに存在しないファイル${key}があります。`);
  }
  for (const path of assets.styles) {
    if (!html.includes(`<link rel="stylesheet" href="${versioned(path, assets.versions)}">`)) problems.push(`${path}: 読み込みの版が古いか、ありません。`);
  }
  if (!html.includes(`<script type="module" src="${versioned("js/app.js", assets.versions)}"></script>`)) {
    problems.push("js/app.js: 読み込みの版が古いか、ありません。");
  }
  return problems;
}
