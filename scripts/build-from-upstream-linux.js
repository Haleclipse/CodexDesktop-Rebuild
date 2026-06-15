#!/usr/bin/env node
/**
 * build-from-upstream-linux.js — Build Linux distributables (.deb/.rpm/.zip)
 *
 * Linux has no upstream Codex installer, so unlike mac/win we must build the
 * Electron app from scratch using @electron/packager directly, then invoke
 * maker-deb/rpm/zip programmatically. This bypasses electron-forge make,
 * which exits silently in CI after Packaging without producing artifacts.
 *
 * Prereq: prepare-src.js --platform linux-{arch} has already populated src/
 *         (app code) and src/mac-{arch}/ (Linux codex/rg vendor binaries).
 *
 * Usage:
 *   node scripts/build-from-upstream-linux.js --platform linux-x64
 *   node scripts/build-from-upstream-linux.js --platform linux-arm64
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");
const RESOURCES_DIR = path.join(PROJECT_ROOT, "resources");

const IGNORE_ALLOWED = [
  "/src/.vite/build",
  "/src/webview",
  "/src/skills",
  "/src/native-menu-locales",
  "/src/node_modules",
];

const MACOS_ONLY_FILES = new Set([
  "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
  "app.asar", "codex-notification.wav",
]);
const MACOS_ONLY_DIRS = new Set(["native", "app.asar.unpacked"]);

function packagerIgnore(filePath) {
  if (filePath === "") return false;
  if (filePath === "/package.json") return false;
  for (const p of IGNORE_ALLOWED) {
    if (p.startsWith(filePath) || filePath.startsWith(p)) return false;
  }
  return true;
}

function copyLinuxResources(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    console.log(`   [!] ${srcDir} not found, skipping resource copy`);
    return 0;
  }
  console.log(`-- afterCopy: ${path.relative(PROJECT_ROOT, srcDir)} -> ${path.relative(PROJECT_ROOT, destDir)}`);
  const skip = new Set(["_asar"]);
  for (const f of MACOS_ONLY_FILES) skip.add(f);
  for (const d of MACOS_ONLY_DIRS) skip.add(d);

  let copied = 0;
  const copyDir = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) copyDir(sp, dp);
      else if (!e.isSymbolicLink()) { fs.copyFileSync(sp, dp); copied++; }
    }
  };
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    if (entry.name.endsWith(".lproj")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!entry.isSymbolicLink()) {
      fs.copyFileSync(srcPath, destPath);
      try { fs.chmodSync(destPath, 0o755); } catch {}
      copied++;
    }
  }
  console.log(`   [ok] ${copied} files copied`);
  return copied;
}

async function runMaker(kind, factory, packageDir, makeDir, targetArch, packageJSON, results) {
  console.log(`\n-- maker:${kind}`);
  try {
    const maker = factory();
    if (typeof maker.isSupportedOnCurrentPlatform === "function" && !maker.isSupportedOnCurrentPlatform()) {
      throw new Error(`maker-${kind} reports unsupported on current platform (missing binary or installer package?)`);
    }
    if (typeof maker.ensureExternalBinariesExist === "function") {
      maker.ensureExternalBinariesExist();
    }
    if (typeof maker.prepareConfig === "function") {
      await maker.prepareConfig(targetArch);
    }
    const artifacts = await maker.make({
      dir: packageDir,
      makeDir,
      appName: "Codex",
      targetPlatform: "linux",
      targetArch,
      forgeConfig: { packagerConfig: {}, rebuildConfig: {}, makers: [], publishers: [], plugins: [], pluginInterface: {} },
      packageJSON,
    });
    console.log(`   [ok] ${kind}: ${artifacts.length} artifact(s)`);
    for (const a of artifacts) console.log(`        ${a}`);
    results.push({ kind, ok: true, artifacts });
  } catch (err) {
    console.error(`   [x] ${kind} failed: ${err.stack || err.message || err}`);
    results.push({ kind, ok: false, error: err.message || String(err) });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;
  if (!platform || !["linux-x64", "linux-arm64"].includes(platform)) {
    console.error("Usage: build-from-upstream-linux.js --platform linux-x64|linux-arm64");
    process.exit(1);
  }
  const arch = platform.split("-")[1];
  const sourcePlatformDir = path.join(SRC_DIR, `mac-${arch}`);

  if (!fs.existsSync(path.join(SRC_DIR, ".build-mode"))) {
    console.error(`[x] src/ not prepared. Run: node scripts/prepare-src.js --platform ${platform}`);
    process.exit(1);
  }

  console.log(`\n== electron-packager: linux-${arch} ==`);
  console.log(`   dir:    ${PROJECT_ROOT}`);
  console.log(`   out:    ${OUT_DIR}`);
  console.log(`   source: ${sourcePlatformDir}`);

  const { packager } = require("@electron/packager");
  const packagePaths = await packager({
    dir: PROJECT_ROOT,
    out: OUT_DIR,
    platform: "linux",
    arch,
    asar: { unpack: "{**/*.node,**/node-pty/build/Release/spawn-helper,**/node-pty/prebuilds/*/spawn-helper}" },
    overwrite: true,
    name: "Codex",
    executableName: "Codex",
    appBundleId: "com.openai.codex",
    icon: path.join(RESOURCES_DIR, "electron.png"),
    prune: true,
    ignore: packagerIgnore,
    afterCopy: [(buildPath, electronVersion, plat, ar, cb) => {
      try {
        const resourcesPath = path.dirname(buildPath);
        copyLinuxResources(sourcePlatformDir, resourcesPath);
        cb();
      } catch (err) { cb(err); }
    }],
  });

  if (!packagePaths || packagePaths.length === 0) {
    console.error("[x] @electron/packager returned no package paths");
    process.exit(1);
  }
  const packageDir = packagePaths[0];
  console.log(`\n   [ok] packaged at ${packageDir}`);

  const packageJSON = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
  const makeDir = path.join(OUT_DIR, "make");
  fs.mkdirSync(makeDir, { recursive: true });

  console.log(`\n== makers: deb, rpm, zip (arch=${arch}) ==`);
  const results = [];

  await runMaker("deb", () => {
    const { default: MakerDeb } = require("@electron-forge/maker-deb");
    return new MakerDeb({
      options: {
        name: "codex",
        productName: "Codex",
        genericName: "AI Coding Assistant",
        categories: ["Development", "Utility"],
        bin: "Codex",
        maintainer: "Cometix Space",
        homepage: "https://github.com/Haleclipse/CodexDesktop-Rebuild",
        icon: path.join(RESOURCES_DIR, "electron.png"),
      },
    });
  }, packageDir, makeDir, arch, packageJSON, results);

  await runMaker("rpm", () => {
    const { default: MakerRpm } = require("@electron-forge/maker-rpm");
    return new MakerRpm({
      options: {
        name: "codex",
        productName: "Codex",
        genericName: "AI Coding Assistant",
        categories: ["Development", "Utility"],
        bin: "Codex",
        license: "Apache-2.0",
        homepage: "https://github.com/Haleclipse/CodexDesktop-Rebuild",
        icon: path.join(RESOURCES_DIR, "electron.png"),
      },
    });
  }, packageDir, makeDir, arch, packageJSON, results);

  await runMaker("zip", () => {
    const { default: MakerZip } = require("@electron-forge/maker-zip");
    return new MakerZip();
  }, packageDir, makeDir, arch, packageJSON, results);

  console.log(`\n== summary ==`);
  for (const r of results) {
    if (r.ok) {
      console.log(`   [ok]   ${r.kind}: ${r.artifacts.join(", ")}`);
    } else {
      console.log(`   [FAIL] ${r.kind}: ${r.error}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length === results.length) {
    console.error(`\n[x] all makers failed`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`\n[!] ${failed.length}/${results.length} makers failed (partial success)`);
    process.exit(1);
  }
  console.log(`\n[ok] all ${results.length} makers succeeded`);
}

main().catch(err => {
  console.error("\n[x] Fatal:", err.stack || err.message || err);
  process.exit(1);
});
