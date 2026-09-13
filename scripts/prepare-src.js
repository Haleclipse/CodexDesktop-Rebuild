#!/usr/bin/env node
/**
 * Pre-build: Repack patched ASAR, align platform resources, assemble for forge.
 *
 * Flow:
 *   1. Repack _asar/ -> app.asar (with patches applied)
 *   2. Replace codex binary with @cometix/codex version where needed
 *   3. Copy everything to src/ for forge (app.asar + unpacked + resources)
 *
 * For Windows: keep upstream codex.exe so app-server and cua_node/node_repl
 * MCP metadata stay protocol-compatible.
 * For Linux: strip macOS-only resources, add Linux codex from @cometix/codex
 *
 * Usage:
 *   node scripts/prepare-src.js --platform mac-arm64
 *   node scripts/prepare-src.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win": "x86_64-pc-windows-msvc",
};

// macOS-only resources to strip for Linux
const MACOS_STRIP = new Set([
  "codex_chronicle", "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
]);
const MACOS_STRIP_DIRS = new Set(["native"]);

function asarCliPath() {
  return path.join(PROJECT_ROOT, "node_modules", "@electron", "asar", "bin", "asar.mjs");
}

function packAsar(asarDir, asarPath, extraArgs = []) {
  execFileSync(process.execPath, [asarCliPath(), "pack", asarDir, asarPath, ...extraArgs], {
    stdio: "pipe",
  });
}

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

/**
 * Ensure the @cometix/codex platform package is extracted to a temp dir.
 * Returns the vendor root path (e.g. .../vendor/{triple}/) or null.
 * Caches the result so npm pack runs at most once per build.
 */
let _vendorRootCache = null;
function ensureVendorExtracted(platform) {
  if (_vendorRootCache !== undefined && _vendorRootCache !== null) return _vendorRootCache;

  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;

  const PLAT_PKG = {
    "linux-x64": "codex-linux-x64", "linux-arm64": "codex-linux-arm64",
    "mac-arm64": "codex-darwin-arm64", "mac-x64": "codex-darwin-x64", "win": "codex-win32-x64",
  };

  // 1. Try node_modules (platform-specific package)
  const pkg = PLAT_PKG[platform];
  if (pkg) {
    const p = path.join(PROJECT_ROOT, "node_modules", "@cometix", pkg, "vendor", triple);
    if (fs.existsSync(p)) { _vendorRootCache = p; return p; }
  }
  // 2. Try old-style vendor
  const oldPath = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple);
  if (fs.existsSync(oldPath)) { _vendorRootCache = oldPath; return oldPath; }

  // 3. npm pack platform package
  const PLAT_SUFFIX = {
    "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
    "mac-arm64": "darwin-arm64", "mac-x64": "darwin-x64", "win": "win32-x64",
  };
  const suffix = PLAT_SUFFIX[platform];
  if (!suffix) return null;

  let baseVer;
  try {
    baseVer = execSync("npm view @cometix/codex version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }

  const spec = `@cometix/codex@${baseVer}-${suffix}`;
  console.log(`   [vendor] fetching ${spec} via npm pack...`);
  const tmpDir = path.join(require("os").tmpdir(), "cometix-codex-pack");
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const tgzName = execSync(`npm pack ${spec} --pack-destination "${tmpDir}"`, {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();

    const extractDir = path.join(tmpDir, "extracted");
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });

    const vendorRoot = path.join(extractDir, "package", "vendor", triple);
    if (fs.existsSync(vendorRoot)) { _vendorRootCache = vendorRoot; return vendorRoot; }
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
  }

  return null;
}

function resolveCodexVendor(platform) {
  const vendorRoot = ensureVendorExtracted(platform);
  if (!vendorRoot) return null;
  const binName = platform === "win" ? "codex.exe" : "codex";
  const p = path.join(vendorRoot, "codex", binName);
  return fs.existsSync(p) ? p : null;
}

function resolveRgVendor(platform) {
  const vendorRoot = ensureVendorExtracted(platform);
  if (!vendorRoot) return null;
  const binName = platform === "win" ? "rg.exe" : "rg";
  const p = path.join(vendorRoot, "path", binName);
  return fs.existsSync(p) ? p : null;
}

function main() {
  const args = process.argv.slice(2);
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

  // 1. Repack _asar/ -> app.asar
  const repackedAsar = path.join(sourceDir, "app.asar");
  console.log("   [repack] _asar/ -> app.asar");
  const asarPackArgs = isLinux
    ? []
    : platform === "win"
      ? ["--unpack-dir", "{node_modules/better-sqlite3,node_modules/node-pty,node_modules/@worklouder}"]
      : [
          "--unpack-dir", "{node_modules/better-sqlite3,node_modules/node-pty}",
          "--unpack", "{**/*.node,**/node-pty/build/Release/*.exe}",
        ];
  packAsar(asarContentDir, repackedAsar, asarPackArgs);
  const asarSize = (fs.statSync(repackedAsar).size / 1048576).toFixed(1);
  console.log(`   [ok] app.asar: ${asarSize} MB`);

  // 2. Replace codex binary with @cometix/codex where needed.
  // Windows must keep the upstream codex.exe from the MSIX. The Desktop
  // app-server and bundled cua_node/node_repl exchange Codex-specific MCP
  // metadata; mixing a different @cometix/codex build can break browser tools
  // with errors such as "sandboxCwd must use the file URI scheme".
  const isWin = platform === "win";
  const codexBinName = isWin ? "codex.exe" : "codex";
  const vendorCodex = isWin ? null : resolveCodexVendor(platform);
  if (isWin) {
    console.log(`   [codex] keeping upstream ${codexBinName}`);
  } else if (vendorCodex) {
    // For Linux: put codex in sourceDir (mac-x64/) so it can be found,
    // but also mark for later copy to forge output.
    const dest = path.join(sourceDir, codexBinName);
    fs.copyFileSync(vendorCodex, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
    console.log(`   [codex] replaced with @cometix/codex`);
  } else {
    console.log(`   [!] @cometix/codex vendor not found for ${platform}, keeping upstream`);
  }

  // 2b. For Linux: replace rg with platform-native version from @cometix/codex
  if (isLinux) {
    const vendorRg = resolveRgVendor(platform);
    if (vendorRg) {
      const dest = path.join(sourceDir, "rg");
      fs.copyFileSync(vendorRg, dest);
      try { fs.chmodSync(dest, 0o755); } catch {}
      console.log(`   [rg] replaced with Linux rg from @cometix/codex`);
    } else {
      console.log(`   [!] Linux rg not found in vendor, keeping upstream (will fail on Linux)`);
    }
  }

  // 3. For Linux: copy _asar/ content to flat src/ (forge packs ASAR from src/)
  //    Skip node_modules/ — upstream has macOS .node binaries.
  //    Native modules are rebuilt by electron-rebuild and synced separately.
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
    const skipDirs = new Set(["node_modules"]);
    const count = copyRecursive(asarContentDir, SRC, null, skipDirs);
    console.log(`   [linux] _asar/ -> src/ (${count} files, skipped node_modules/)`);
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
