#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  assertLinuxElf,
  isElf,
  isMachO,
} = require("./linux-native-utils");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function usage() {
  console.error("Usage: node scripts/validate-linux-package.js [--arch x64|arm64] [--deb path] [--dir path]");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { arch: "x64", deb: null, dir: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--arch") result.arch = args[++i];
    else if (arg === "--deb") result.deb = args[++i];
    else if (arg === "--dir") result.dir = args[++i];
    else {
      usage();
      process.exit(2);
    }
  }
  if (!["x64", "arm64"].includes(result.arch)) {
    usage();
    process.exit(2);
  }
  return result;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, out);
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

function findDeb(arch) {
  const debDir = path.join(PROJECT_ROOT, "out", "make", "deb", arch);
  if (!fs.existsSync(debDir)) return null;
  const debs = fs.readdirSync(debDir)
    .filter((name) => name.endsWith(".deb"))
    .map((name) => path.join(debDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return debs[0] || null;
}

function extractDeb(debPath) {
  const outDir = path.join(os.tmpdir(), `codex-linux-package-${process.pid}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync("dpkg-deb", ["-x", debPath, outDir], { stdio: "inherit" });
  return outDir;
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function findBySuffix(files, suffix) {
  return files.find((filePath) => relative("/", filePath).endsWith(suffix));
}

function validate(root, arch) {
  const platform = arch === "arm64" ? "linux-arm64" : "linux-x64";
  const files = walk(root);
  const failures = [];

  const machoFiles = files.filter(isMachO);
  if (machoFiles.length > 0) {
    failures.push(`Mach-O files found:\n${machoFiles.map((filePath) => `  - ${relative(root, filePath)}`).join("\n")}`);
  }

  const nodeFiles = files.filter((filePath) => filePath.endsWith(".node"));
  for (const nodeFile of nodeFiles) {
    if (!isElf(nodeFile)) {
      failures.push(`Native module is not ELF: ${relative(root, nodeFile)}`);
    } else {
      try {
        assertLinuxElf(nodeFile, platform, relative(root, nodeFile));
      } catch (e) {
        failures.push(e.message);
      }
    }
  }

  const betterSqlite = findBySuffix(
    files,
    "resources/app.asar.unpacked/src/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  if (!betterSqlite) {
    failures.push("better-sqlite3 native module not found in app.asar.unpacked/src/node_modules");
  } else {
    try {
      assertLinuxElf(betterSqlite, platform, "better_sqlite3.node");
    } catch (e) {
      failures.push(e.message);
    }
  }

  for (const name of ["codex", "rg"]) {
    const resourceBinary = files.find((filePath) => path.basename(filePath) === name && relative(root, filePath).includes("/resources/"));
    if (!resourceBinary) {
      failures.push(`resources/${name} not found`);
      continue;
    }
    try {
      assertLinuxElf(resourceBinary, platform, name);
    } catch (e) {
      failures.push(e.message);
    }
  }

  const macOnlyResources = [
    "resources/native",
    "resources/electron.icns",
    "resources/Assets.car",
    "resources/codex_chronicle",
    "resources/node",
    "resources/node_repl",
  ];
  for (const suffix of macOnlyResources) {
    const found = files.some((filePath) => relative(root, filePath).endsWith(suffix))
      || fs.existsSync(path.join(root, suffix));
    if (found) failures.push(`macOS-only resource found: ${suffix}`);
  }

  console.log(`-- validate-linux-package: ${platform}`);
  console.log(`   root: ${root}`);
  console.log(`   files scanned: ${files.length}`);
  console.log(`   native .node files: ${nodeFiles.length}`);
  console.log(`   Mach-O files: ${machoFiles.length}`);
  if (betterSqlite) console.log(`   better-sqlite3: ${relative(root, betterSqlite)}`);

  if (failures.length > 0) {
    console.error("\n[x] Linux package validation failed");
    for (const failure of failures) console.error(`\n${failure}`);
    process.exit(1);
  }

  console.log("   [ok] no Mach-O files and Linux native modules validated");
}

function main() {
  const args = parseArgs();
  let root = args.dir ? path.resolve(args.dir) : null;

  if (!root) {
    const debPath = args.deb ? path.resolve(args.deb) : findDeb(args.arch);
    if (!debPath) {
      console.error(`[x] No deb found for arch ${args.arch}`);
      process.exit(1);
    }
    console.log(`   [deb] ${path.relative(PROJECT_ROOT, debPath)}`);
    root = extractDeb(debPath);
  }

  if (!fs.existsSync(root)) {
    console.error(`[x] Validation root not found: ${root}`);
    process.exit(1);
  }

  validate(root, args.arch);
}

main();
