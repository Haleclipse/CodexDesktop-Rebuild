#!/usr/bin/env node
/**
 * Linux compositor patch for upstream macOS app bundles.
 *
 * The upstream desktop UI is optimized for macOS vibrancy/transparent windows.
 * On Linux, transparent or semi-transparent Electron surfaces can leave repaint
 * trails under some compositors when moving the window or hovering sidebar rows.
 * Force Linux primary/secondary windows onto the opaque rendering path while
 * leaving small overlay/popup windows transparent.
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function replaceOnce(code, from, to, label, patches) {
  if (code.includes(to)) return code;
  const index = code.indexOf(from);
  if (index === -1) {
    throw new Error(`Pattern not found for ${label}`);
  }
  patches.push(label);
  return code.slice(0, index) + to + code.slice(index + from.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchOpaqueBackground(code, patches) {
  const label = "linux opaque BrowserWindow background";
  const from = "function QW({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return e===`win32`&&!YW(t)?n?{backgroundColor:r?AW:jW,backgroundMaterial:`none`}:{backgroundColor:kW,backgroundMaterial:`mica`}:{backgroundColor:kW,backgroundMaterial:null}}";
  const to = "function QW({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return e===`linux`&&!YW(t)?{backgroundColor:r?AW:jW,backgroundMaterial:null}:e===`win32`&&!YW(t)?n?{backgroundColor:r?AW:jW,backgroundMaterial:`none`}:{backgroundColor:kW,backgroundMaterial:`mica`}:{backgroundColor:kW,backgroundMaterial:null}}";

  if (code.includes(to)) return code;
  if (code.includes(from)) {
    patches.push(label);
    return code.replace(from, to);
  }

  const fnPattern = /function\s+([A-Za-z_$][\w$]*)\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return ([\s\S]*?backgroundMaterial:null\}\})/g;
  let match;
  while ((match = fnPattern.exec(code)) !== null) {
    const [, , platformVar, appearanceVar, opaqueVar, , body] = match;
    if (body.includes(`${platformVar}===\`linux\`&&!`)) return code;

    const winCondition = `${platformVar}===\`win32\`&&!`;
    if (!body.startsWith(winCondition)) continue;

    const winPattern = new RegExp(
      `${escapeRegExp(platformVar)}===\`win32\`&&!([A-Za-z_$][\\w$]*)\\(${escapeRegExp(appearanceVar)}\\)\\?${escapeRegExp(opaqueVar)}\\?\\{backgroundColor:([\\s\\S]*?),backgroundMaterial:\`none\`\\}:`,
    );
    const winMatch = body.match(winPattern);
    if (!winMatch) continue;

    const transparentAppearanceFn = winMatch[1];
    const opaqueBackgroundColor = winMatch[2];
    const prefix = match[0].slice(0, match[0].length - body.length);
    const replacement = `${prefix}${platformVar}===\`linux\`&&!${transparentAppearanceFn}(${appearanceVar})?{backgroundColor:${opaqueBackgroundColor},backgroundMaterial:null}:${body}`;
    patches.push(label);
    return code.slice(0, match.index) + replacement + code.slice(match.index + match[0].length);
  }

  throw new Error(`Pattern not found for ${label}`);
}

function patchLinuxWindowOptions(code, patches) {
  const label = "linux non-transparent primary windows";
  const from = "function eG({appearance:e,opaqueWindowsEnabled:t,platform:n}){switch(e){case`browserCommentPopup`:";
  const to = "function eG({appearance:e,opaqueWindowsEnabled:t,platform:n}){if(n===`linux`&&(e===`primary`||e===`secondary`))return{titleBarStyle:`default`,transparent:!1};switch(e){case`browserCommentPopup`:";

  if (code.includes(to)) return code;
  if (code.includes(from)) {
    patches.push(label);
    return code.replace(from, to);
  }

  const fnPattern = /(function\s+[A-Za-z_$][\w$]*\(\{appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:([A-Za-z_$][\w$]*),platform:([A-Za-z_$][\w$]*)\}\)\{)(switch\(\2\)\{case`browserCommentPopup`:)/;
  const match = code.match(fnPattern);
  if (!match) throw new Error(`Pattern not found for ${label}`);

  const [, prefix, appearanceVar, , platformVar, switchBody] = match;
  const guard = `if(${platformVar}===\`linux\`&&(${appearanceVar}===\`primary\`||${appearanceVar}===\`secondary\`))return{titleBarStyle:\`default\`,transparent:!1};`;
  if (code.includes(guard)) return code;

  patches.push(label);
  return code.slice(0, match.index) + prefix + guard + switchBody + code.slice(match.index + match[0].length);
}

function patchElectronOpaqueStartup(code, patches) {
  const label = "linux electron-opaque class at startup";
  const from = "document.documentElement.dataset.codexOs=FF(),";
  const to = "document.documentElement.dataset.codexOs=FF(),document.documentElement.dataset.codexOs===`linux`&&document.documentElement.classList.add(`electron-opaque`),";

  if (code.includes(to)) return code;
  if (code.includes(from)) {
    patches.push(label);
    return code.replace(from, to);
  }

  const pattern = /document\.documentElement\.dataset\.codexOs=([A-Za-z_$][\w$]*)\(\),/;
  const match = code.match(pattern);
  if (!match) throw new Error(`Pattern not found for ${label}`);

  const replacement = `${match[0]}document.documentElement.dataset.codexOs===\`linux\`&&document.documentElement.classList.add(\`electron-opaque\`),`;
  patches.push(label);
  return code.slice(0, match.index) + replacement + code.slice(match.index + match[0].length);
}

function patchKeepElectronOpaque(code, patches) {
  const label = "keep electron-opaque on linux";
  const from = "if(C.opaqueWindows&&!wi()){e.classList.add(`electron-opaque`);return}e.classList.remove(`electron-opaque`)";
  const to = "if((document.documentElement.dataset.codexOs===`linux`||C.opaqueWindows)&&!wi()){e.classList.add(`electron-opaque`);return}e.classList.remove(`electron-opaque`)";

  if (code.includes(to) || code.includes("document.documentElement.dataset.codexOs===`linux`||")) return code;
  if (code.includes(from)) {
    patches.push(label);
    return code.replace(from, to);
  }

  const pattern = /if\(([A-Za-z_$][\w$]*)\.opaqueWindows&&!([A-Za-z_$][\w$]*)\(\)\)\{([A-Za-z_$][\w$]*)\.classList\.add\(`electron-opaque`\);return\}\3\.classList\.remove\(`electron-opaque`\)/;
  const match = code.match(pattern);
  if (!match) throw new Error(`Pattern not found for ${label}`);

  const [, stateVar, translucentFn, elementVar] = match;
  const replacement = `if((document.documentElement.dataset.codexOs===\`linux\`||${stateVar}.opaqueWindows)&&!${translucentFn}()){${elementVar}.classList.add(\`electron-opaque\`);return}${elementVar}.classList.remove(\`electron-opaque\`)`;
  patches.push(label);
  return code.slice(0, match.index) + replacement + code.slice(match.index + match[0].length);
}

function writeIfChanged(bundle, before, after, patches, check) {
  if (patches.length === 0) {
    console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
    return;
  }
  if (check) {
    console.log(`  [?] ${relPath(bundle.path)}: ${patches.join(", ")}`);
    return;
  }
  fs.writeFileSync(bundle.path, after, "utf-8");
  console.log(`  [ok] ${relPath(bundle.path)}: ${patches.join(", ")}`);
}

function patchMainBundle(bundle, check) {
  const before = fs.readFileSync(bundle.path, "utf-8");
  let code = before;
  const patches = [];

  code = patchOpaqueBackground(code, patches);
  code = patchLinuxWindowOptions(code, patches);

  writeIfChanged(bundle, before, code, patches, check);
}

function patchRendererBundle(bundle, check) {
  const before = fs.readFileSync(bundle.path, "utf-8");
  let code = before;
  const patches = [];

  code = patchElectronOpaqueStartup(code, patches);
  code = patchKeepElectronOpaque(code, patches);

  writeIfChanged(bundle, before, code, patches, check);
}

function patchCssBundle(bundle, check) {
  const before = fs.readFileSync(bundle.path, "utf-8");
  const rule = "[data-codex-window-type=electron][data-codex-os=linux]{background-color:var(--color-background-surface-under);background-image:none}[data-codex-window-type=electron][data-codex-os=linux] body{background-color:var(--color-background-surface-under);background-image:none}";
  if (before.includes(rule)) {
    console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
    return;
  }
  if (check) {
    console.log(`  [?] ${relPath(bundle.path)}: append linux opaque CSS`);
    return;
  }
  fs.writeFileSync(bundle.path, before + rule, "utf-8");
  console.log(`  [ok] ${relPath(bundle.path)}: appended linux opaque CSS`);
}

function patchPlatform(platform, check) {
  const mainBundles = locateBundles({ dir: "build", pattern: /^main-.*\.js$/, platform });
  const rendererBundles = locateBundles({ dir: "assets", pattern: /^app-main-.*\.js$/, platform });
  const cssBundles = locateBundles({ dir: "assets", pattern: /^app-main-.*\.css$/, platform });

  if (mainBundles.length === 0) throw new Error(`No main bundle found for ${platform}`);
  if (rendererBundles.length === 0) throw new Error(`No renderer app-main bundle found for ${platform}`);
  if (cssBundles.length === 0) throw new Error(`No renderer app-main CSS found for ${platform}`);

  for (const bundle of mainBundles) patchMainBundle(bundle, check);
  for (const bundle of rendererBundles) patchRendererBundle(bundle, check);
  for (const bundle of cssBundles) patchCssBundle(bundle, check);
}

function locateFlatBundles({ dir, pattern }) {
  const baseDir = dir === "build"
    ? path.join(SRC_DIR, ".vite", "build")
    : path.join(SRC_DIR, "webview", "assets");
  if (!fs.existsSync(baseDir)) return [];
  const files = fs.readdirSync(baseDir).filter((file) => pattern.test(file));
  return files.map((file) => ({ platform: "linux", path: path.join(baseDir, file) }));
}

function patchFlatLinux(check) {
  const mainBundles = locateFlatBundles({ dir: "build", pattern: /^main-.*\.js$/ });
  const rendererBundles = locateFlatBundles({ dir: "assets", pattern: /^app-main-.*\.js$/ });
  const cssBundles = locateFlatBundles({ dir: "assets", pattern: /^app-main-.*\.css$/ });

  if (mainBundles.length === 0) throw new Error("No flat Linux main bundle found in src/.vite/build");
  if (rendererBundles.length === 0) throw new Error("No flat Linux renderer app-main bundle found in src/webview/assets");
  if (cssBundles.length === 0) throw new Error("No flat Linux renderer app-main CSS found in src/webview/assets");

  for (const bundle of mainBundles) patchMainBundle(bundle, check);
  for (const bundle of rendererBundles) patchRendererBundle(bundle, check);
  for (const bundle of cssBundles) patchCssBundle(bundle, check);
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  if (check) console.log("  [info] check mode validates patch targets only");

  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win", "unix", "linux", "linux-x64", "linux-arm64"].includes(arg),
  );
  if (platform === "win") {
    console.log("  [skip] Linux rendering patch does not apply to Windows");
    return;
  }
  if (platform?.startsWith("linux")) {
    patchFlatLinux(check);
    return;
  }

  const platforms = platform && platform !== "unix"
    ? [platform]
    : ["mac-arm64", "mac-x64"].filter((target) =>
        fs.existsSync(path.join(__dirname, "..", "src", target, "_asar")),
      );

  for (const target of platforms) patchPlatform(target, check);
}

try {
  main();
} catch (error) {
  console.error(`  [x] ${error.message}`);
  process.exit(1);
}
