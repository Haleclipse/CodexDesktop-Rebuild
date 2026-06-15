#!/usr/bin/env node
/**
 * build-from-upstream-linux.js — Build Linux distributables (.deb/.rpm/.zip)
 *
 * Avoids @electron/packager entirely. Its dependency extract-zip 2.0.1
 * silently exits the Node process during extraction on Node 24 + Ubuntu CI
 * (no error, no stack — process just ends with exit code 0 mid-await).
 * Two CI runs reproduced this deterministically with full DEBUG.
 *
 * Instead this script does the same work via:
 *   - @electron/get        — download the Electron Linux template zip
 *   - system `unzip`       — extract reliably (apt: unzip is preinstalled)
 *   - @electron/asar       — pack src/ into app.asar
 *   - maker-deb/rpm/zip    — programmatic make()
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
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");
const RESOURCES_DIR = path.join(PROJECT_ROOT, "resources");

const ASAR_UNPACK_GLOB = "{**/*.node,**/node-pty/build/Release/spawn-helper,**/node-pty/prebuilds/*/spawn-helper}";

const MACOS_ONLY_FILES = new Set([
  "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
  "app.asar", "codex-notification.wav",
]);
const MACOS_ONLY_DIRS = new Set(["native", "app.asar.unpacked"]);

function readElectronVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
  const raw = pkg.devDependencies?.electron;
  if (!raw) throw new Error("devDependencies.electron not set in package.json");
  // strip leading ^ or ~ or = etc.
  return raw.replace(/^[^\d]*/, "");
}

function copyLinuxResources(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source platform dir not found: ${srcDir}`);
  }
  const skip = new Set(["_asar"]);
  for (const f of MACOS_ONLY_FILES) skip.add(f);
  for (const d of MACOS_ONLY_DIRS) skip.add(d);

  let copied = 0;
  const copyDir = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) copyDir(sp, dp);
      else if (!e.isSymbolicLink()) {
        fs.copyFileSync(sp, dp);
        try { fs.chmodSync(dp, 0o755); } catch {}
        copied++;
      }
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
  return copied;
}

async function runMaker(kind, factory, packageDir, makeDir, targetArch, packageJSON, results) {
  console.log(`\n-- maker:${kind}`);
  try {
    const maker = factory();
    if (typeof maker.isSupportedOnCurrentPlatform === "function" && !maker.isSupportedOnCurrentPlatform()) {
      throw new Error(`maker-${kind} reports unsupported on current platform (missing peer installer pkg?)`);
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
  if (!fs.existsSync(sourcePlatformDir)) {
    console.error(`[x] ${sourcePlatformDir} not found.`);
    process.exit(1);
  }

  const electronVersion = readElectronVersion();
  const packageDir = path.join(OUT_DIR, `Codex-linux-${arch}`);
  const resourcesPath = path.join(packageDir, "resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");

  console.log(`\n== build-linux: ${platform} ==`);
  console.log(`   electron: v${electronVersion}`);
  console.log(`   package:  ${packageDir}`);
  console.log(`   source:   ${path.relative(PROJECT_ROOT, sourcePlatformDir)}`);

  // ─── 1. Download Electron Linux template zip ───
  console.log(`\n-- downloading electron-v${electronVersion}-linux-${arch}.zip`);
  const { downloadArtifact, initializeProxy } = require("@electron/get");
  initializeProxy();
  const zipPath = await downloadArtifact({
    version: electronVersion,
    platform: "linux",
    arch,
    artifactName: "electron",
  });
  const zipSize = fs.statSync(zipPath).size;
  console.log(`   [ok] ${zipPath} (${(zipSize / 1024 / 1024).toFixed(1)} MB)`);

  // ─── 2. Extract via system unzip (bypasses extract-zip silent-exit) ───
  console.log(`\n-- extracting via system unzip -> ${packageDir}`);
  if (fs.existsSync(packageDir)) fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(packageDir, { recursive: true });
  execFileSync("unzip", ["-qq", "-o", zipPath, "-d", packageDir], { stdio: ["ignore", "inherit", "inherit"] });
  const extractedCount = fs.readdirSync(packageDir).length;
  console.log(`   [ok] ${extractedCount} top-level entries extracted`);
  if (extractedCount === 0) throw new Error("unzip produced no files");

  // ─── 3. Rename `electron` binary -> `Codex` ───
  const electronBin = path.join(packageDir, "electron");
  const codexBin = path.join(packageDir, "Codex");
  if (!fs.existsSync(electronBin)) throw new Error(`Electron binary not found at ${electronBin}`);
  fs.renameSync(electronBin, codexBin);
  fs.chmodSync(codexBin, 0o755);
  console.log(`   [ok] electron -> Codex`);

  // ─── 4. Remove default_app + chrome-sandbox SUID (forge does same) ───
  for (const name of ["default_app.asar", "default_app"]) {
    const p = path.join(resourcesPath, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  // ─── 5. Pack src/ -> app.asar (excludes src/mac-* via root filter) ───
  console.log(`\n-- packing app.asar from src/`);
  const asar = require("@electron/asar");
  await asar.createPackageWithOptions(SRC_DIR, appAsarPath, {
    unpack: ASAR_UNPACK_GLOB,
    dot: true,
    // Exclude src/mac-x64/, src/mac-arm64/, src/win/ subdirs — these are
    // upstream platform trees retained alongside src/ for the afterCopy
    // step, not part of the runtime app.
    globOptions: { ignore: ["mac-x64/**", "mac-arm64/**", "win/**"] },
  });
  const asarSize = fs.statSync(appAsarPath).size;
  console.log(`   [ok] app.asar: ${(asarSize / 1024 / 1024).toFixed(1)} MB`);

  // ─── 6. Copy Linux-specific resources from src/mac-{arch}/ ───
  console.log(`\n-- copying Linux resources from ${path.relative(PROJECT_ROOT, sourcePlatformDir)}`);
  const copied = copyLinuxResources(sourcePlatformDir, resourcesPath);
  console.log(`   [ok] ${copied} files copied to ${path.relative(PROJECT_ROOT, resourcesPath)}`);

  // ─── 7. Run makers ───
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
    if (r.ok) console.log(`   [ok]   ${r.kind}: ${r.artifacts.join(", ")}`);
    else      console.log(`   [FAIL] ${r.kind}: ${r.error}`);
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length === results.length) {
    console.error(`\n[x] all makers failed`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`\n[!] ${failed.length}/${results.length} makers failed`);
    process.exit(1);
  }
  console.log(`\n[ok] all ${results.length} makers succeeded`);
}

main().catch(err => {
  console.error("\n[x] Fatal:", err.stack || err.message || err);
  process.exit(1);
});
