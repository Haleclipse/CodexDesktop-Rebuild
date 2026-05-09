#!/usr/bin/env node
/**
 * Pre-build: Repack patched ASAR, replace codex CLI, assemble for forge.
 *
 * Flow:
 *   1. Repack _asar/ -> app.asar (with patches applied)
 *   2. Replace codex binary with @cometix/codex version
 *   3. Copy everything to src/ for forge (app.asar + unpacked + resources)
 *
 * For Linux: copy patched ASAR content into src/ and stage Linux-only resources.
 *
 * Usage:
 *   node scripts/prepare-src.js --platform mac-arm64
 *   node scripts/prepare-src.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  copyLinuxExecutable,
  isMachO,
  resolveCodexVendor,
  resolveRipgrepVendor,
} = require("./linux-native-utils");

const SRC = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

// macOS-only resources to strip for Linux
const MACOS_STRIP = new Set([
  "codex_chronicle", "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
]);
const MACOS_STRIP_DIRS = new Set(["native"]);

function copyRecursive(src, dest, skipFiles, skipDirs) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs?.has(e.name)) continue;
    if (skipFiles?.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d, skipFiles, skipDirs); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function rmIfExists(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function removeMachOFiles(dir, options = {}) {
  let removed = 0;
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (options.skipDirNames?.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += removeMachOFiles(target, options);
      try {
        if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      } catch {}
    } else if (entry.isFile() && isMachO(target)) {
      fs.unlinkSync(target);
      removed++;
    }
  }
  return removed;
}

function removeNonLinuxPrebuilds(dir, platform) {
  let removed = 0;
  if (!fs.existsSync(dir)) return removed;
  const keepLinuxArch = platform === "linux-arm64" ? "linux-arm64" : "linux-x64";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "prebuilds") {
        for (const prebuild of fs.readdirSync(target, { withFileTypes: true })) {
          const prebuildPath = path.join(target, prebuild.name);
          if (prebuild.isDirectory() && prebuild.name !== keepLinuxArch) {
            rmIfExists(prebuildPath);
            removed++;
          }
        }
      } else {
        removed += removeNonLinuxPrebuilds(target, platform);
      }
    }
  }
  return removed;
}

function copyNpmPackageSource(moduleName, version, dest) {
  const tmpDir = path.join(require("os").tmpdir(), "codex-native-source-pack", `${moduleName}-${version}`);
  const extractDir = path.join(tmpDir, "extracted");
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`   [linux] fetching ${moduleName}@${version} source via npm pack...`);
  const tgzName = execSync(`npm pack ${moduleName}@${version} --pack-destination "${tmpDir}"`, {
    cwd: tmpDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim().split("\n").pop();

  rmIfExists(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });
  copyRecursive(path.join(extractDir, "package"), dest);
}

function copyNativeSourceModule(moduleName) {
  const source = path.join(PROJECT_ROOT, "node_modules", moduleName);
  const dest = path.join(SRC, "node_modules", moduleName);
  const runtimePkgPath = path.join(dest, "package.json");
  const runtimeVersion = fs.existsSync(runtimePkgPath)
    ? JSON.parse(fs.readFileSync(runtimePkgPath, "utf-8")).version
    : null;
  if (!runtimeVersion) {
    console.error(`[x] Upstream runtime dependency not found: ${moduleName}`);
    process.exit(1);
  }

  let copiedFrom = null;
  const sourcePkgPath = path.join(source, "package.json");
  if (fs.existsSync(sourcePkgPath)) {
    const sourceVersion = JSON.parse(fs.readFileSync(sourcePkgPath, "utf-8")).version;
    if (sourceVersion === runtimeVersion) copiedFrom = source;
  }

  rmIfExists(dest);
  if (copiedFrom) {
    copyRecursive(copiedFrom, dest);
  } else {
    copyNpmPackageSource(moduleName, runtimeVersion, dest);
  }
  console.log(`   [linux] ${moduleName}: copied buildable sources (${runtimeVersion})`);
}

function stageLinuxResources(platform, sourceDir) {
  const resourceDir = path.join(SRC, ".linux-resources", platform);
  rmIfExists(resourceDir);
  fs.mkdirSync(resourceDir, { recursive: true });

  const skipFiles = new Set([
    ...MACOS_STRIP,
    "app.asar",
    "codex",
    "rg",
  ]);
  const skipDirs = new Set([
    ...MACOS_STRIP_DIRS,
    "_asar",
    "app.asar.unpacked",
  ]);
  let resourceCount = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".lproj")) continue;
    if (skipFiles.has(entry.name) || skipDirs.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(resourceDir, entry.name);
    if (entry.isDirectory()) resourceCount += copyRecursive(sourcePath, destPath);
    else if (!entry.isSymbolicLink()) {
      fs.copyFileSync(sourcePath, destPath);
      resourceCount++;
    }
  }
  const removed = removeMachOFiles(resourceDir);
  const removedPrebuilds = removeNonLinuxPrebuilds(resourceDir, platform);
  console.log(`   [linux] staged ${resourceCount} sanitized resource files (${removed} Mach-O, ${removedPrebuilds} non-target prebuild dirs removed)`);

  const codex = resolveCodexVendor(platform);
  if (!codex) {
    console.error(`[x] Linux codex ELF not found for ${platform}`);
    process.exit(1);
  }
  copyLinuxExecutable(codex, path.join(resourceDir, "codex"), platform, "codex");
  console.log("   [linux] staged codex ELF");

  const rg = resolveRipgrepVendor(platform);
  if (!rg) {
    console.error(`[x] Linux ripgrep ELF not found for ${platform}`);
    process.exit(1);
  }
  copyLinuxExecutable(rg, path.join(resourceDir, "rg"), platform, "rg");
  console.log("   [linux] staged rg ELF");
}

function stripLinuxMacArtifacts(linuxRoot) {
  let removed = 0;
  for (const name of MACOS_STRIP) {
    const target = path.join(linuxRoot, name);
    if (fs.existsSync(target)) {
      rmIfExists(target);
      removed++;
    }
  }
  for (const name of MACOS_STRIP_DIRS) {
    const target = path.join(linuxRoot, name);
    if (fs.existsSync(target)) {
      rmIfExists(target);
      removed++;
    }
  }

  const linuxNodeModules = path.join(linuxRoot, "node_modules");
  const knownNativeStripPaths = [
    path.join(linuxNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    path.join(linuxNodeModules, "node-pty", "build", "Release", "pty.node"),
    path.join(linuxNodeModules, "node-pty", "build", "Release", "spawn-helper"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "darwin-x64"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "darwin-arm64"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "win32-x64"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "win32-arm64"),
  ];

  for (const target of knownNativeStripPaths) {
    if (fs.existsSync(target)) {
      rmIfExists(target);
      removed++;
    }
  }

  removed += removeMachOFiles(linuxRoot, { skipDirNames: new Set(["mac-arm64", "mac-x64"]) });

  console.log(`   [linux] stripped ${removed} macOS-only native/resource paths`);
}

function stripLinuxNativeBuildExtras() {
  let removed = 0;
  const linuxNodeModules = path.join(SRC, "node_modules");
  const stripPaths = [
    path.join(linuxNodeModules, "node-pty", "prebuilds", "darwin-x64"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "darwin-arm64"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "win32-x64"),
    path.join(linuxNodeModules, "node-pty", "prebuilds", "win32-arm64"),
    path.join(linuxNodeModules, "node-pty", "build", "Release", "obj.target"),
    path.join(linuxNodeModules, "better-sqlite3", "build", "Release", "obj.target"),
    path.join(linuxNodeModules, "better-sqlite3", "build", "Release", "obj"),
    path.join(linuxNodeModules, "better-sqlite3", "build", "Release", "test_extension.node"),
  ];
  for (const target of stripPaths) {
    if (fs.existsSync(target)) {
      rmIfExists(target);
      removed++;
    }
  }
  removed += removeMachOFiles(SRC, { skipDirNames: new Set(["mac-arm64", "mac-x64"]) });
  console.log(`-- strip-linux-native-extras: removed ${removed} non-Linux/intermediate native paths`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--strip-linux-native-extras")) {
    stripLinuxNativeBuildExtras();
    return;
  }

  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  const VALID = ["mac-arm64", "mac-x64", "win", "linux-x64", "linux-arm64"];
  if (!platform || !VALID.includes(platform)) {
    console.error(`[x] Usage: prepare-src.js --platform <${VALID.join("|")}>`);
    process.exit(1);
  }

  const isLinux = platform.startsWith("linux");
  const sourceDir = isLinux
    ? path.join(SRC, platform === "linux-arm64" ? "mac-arm64" : "mac-x64")
    : path.join(SRC, platform);

  if (!fs.existsSync(sourceDir)) {
    console.error(`[x] Source not found: ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  const asarContentDir = path.join(sourceDir, "_asar");
  if (!fs.existsSync(asarContentDir)) {
    console.error(`[x] _asar/ not found in ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  console.log(`-- prepare-src: ${platform}`);
  console.log(`   source: ${path.relative(PROJECT_ROOT, sourceDir)}/`);

  // 1. Repack _asar/ -> app.asar for platforms that ship upstream Resources.
  // Linux must let Electron Forge create app.asar/app.asar.unpacked from src/.
  if (!isLinux) {
    const repackedAsar = path.join(sourceDir, "app.asar");
    console.log("   [repack] _asar/ -> app.asar");
    execSync(`npx asar pack "${asarContentDir}" "${repackedAsar}"`);
    const asarSize = (fs.statSync(repackedAsar).size / 1048576).toFixed(1);
    console.log(`   [ok] app.asar: ${asarSize} MB`);
  } else {
    console.log("   [linux] Forge will pack app.asar from src/");
  }

  // 2. Replace or stage codex binary
  const isWin = platform === "win";
  const codexBinName = isWin ? "codex.exe" : "codex";
  if (isLinux) {
    stageLinuxResources(platform, sourceDir);
  } else {
    const vendorCodex = resolveCodexVendor(platform);
    if (vendorCodex) {
      const dest = path.join(sourceDir, codexBinName);
      fs.copyFileSync(vendorCodex, dest);
      try { fs.chmodSync(dest, 0o755); } catch {}
      console.log(`   [codex] replaced with @cometix/codex`);
    } else {
      console.log(`   [!] @cometix/codex vendor not found for ${platform}, keeping upstream`);
    }
  }

  // 3. For Linux: copy _asar/ content to flat src/ (forge packs ASAR from src/)
  if (isLinux) {
    // Clear flat src/ dirs
    for (const d of [".vite", "webview", "skills", "native-menu-locales", "node_modules"]) {
      const p = path.join(SRC, d);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    for (const f of fs.readdirSync(SRC)) {
      const p = path.join(SRC, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
    const count = copyRecursive(asarContentDir, SRC);
    console.log(`   [linux] _asar/ -> src/ (${count} files for forge ASAR packing)`);
    copyNativeSourceModule("better-sqlite3");
    copyNativeSourceModule("node-pty");
    stripLinuxMacArtifacts(SRC);
  }

  // 4. Sync version to root package.json
  const upstreamPkg = path.join(asarContentDir, "package.json");
  if (fs.existsSync(upstreamPkg)) {
    const upstream = JSON.parse(fs.readFileSync(upstreamPkg, "utf-8"));
    const rootPkgPath = path.join(PROJECT_ROOT, "package.json");
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    const oldVer = rootPkg.version;
    rootPkg.version = upstream.version || rootPkg.version;
    rootPkg.main = "src/.vite/build/bootstrap.js";
    for (const key of [
      "codexBuildNumber", "codexBuildFlavor",
      "codexSparkleFeedUrl", "codexSparklePublicKey",
      "codexWindowsUpdateUrl", "codexWindowsPackageIdentity",
      "codexWindowsPackagePublisher",
    ]) {
      if (upstream[key]) rootPkg[key] = upstream[key];
    }
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`   version: ${oldVer} -> ${rootPkg.version}`);
  }

  // For mac/win: create stub main entry so forge validation passes.
  // The real code is in app.asar which we copy in packageAfterCopy.
  if (!isLinux) {
    const stubDir = path.join(SRC, ".vite", "build");
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, "bootstrap.js"), "// stub - real code in app.asar\n");
    // Also need package.json in src/ for forge
    const asarPkg = path.join(asarContentDir, "package.json");
    if (fs.existsSync(asarPkg)) {
      fs.copyFileSync(asarPkg, path.join(SRC, "package.json"));
    }
  }

  // Write build mode marker for forge.config.js
  const marker = path.join(SRC, ".build-mode");
  fs.writeFileSync(marker, isLinux ? "linux" : "upstream-asar");
  console.log(`   [mode] ${isLinux ? "linux (forge packs ASAR)" : "upstream-asar (pre-built)"}`);

  console.log(`   [ok] src/ ready for ${platform} build`);
}

main();
