const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win": "x86_64-pc-windows-msvc",
};

const COMETIX_PLATFORM_PACKAGE = {
  "linux-x64": "codex-linux-x64",
  "linux-arm64": "codex-linux-arm64",
  "mac-arm64": "codex-darwin-arm64",
  "mac-x64": "codex-darwin-x64",
  "win": "codex-win32-x64",
};

const PLATFORM_SUFFIX = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "mac-arm64": "darwin-arm64",
  "mac-x64": "darwin-x64",
  "win": "win32-x64",
};

const EXPECTED_ELF_MACHINE = {
  "linux-x64": 62,
  "linux-arm64": 183,
};

function readMagic(filePath, size = 20) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function isElf(filePath) {
  try {
    const magic = readMagic(filePath, 4);
    return magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
  } catch {
    return false;
  }
}

function isMachO(filePath) {
  try {
    const magic = readMagic(filePath, 4);
    const hex = magic.toString("hex");
    return [
      "feedface",
      "feedfacf",
      "cefaedfe",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
    ].includes(hex);
  } catch {
    return false;
  }
}

function getElfMachine(filePath) {
  if (!isElf(filePath)) return null;
  const header = readMagic(filePath, 20);
  const endian = header[5];
  if (endian === 1) return header.readUInt16LE(18);
  if (endian === 2) return header.readUInt16BE(18);
  return null;
}

function assertLinuxElf(filePath, platform, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  if (!isElf(filePath)) {
    throw new Error(`${label} is not an ELF binary: ${filePath}`);
  }
  const expected = EXPECTED_ELF_MACHINE[platform];
  const actual = getElfMachine(filePath);
  if (expected && actual !== expected) {
    throw new Error(`${label} has ELF machine ${actual}, expected ${expected} for ${platform}: ${filePath}`);
  }
}

function commandPath(command) {
  try {
    return execSync(`command -v ${command}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function findExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function npmPackCometix(platform) {
  const suffix = PLATFORM_SUFFIX[platform];
  if (!suffix) return null;

  let baseVer;
  try {
    baseVer = execSync("npm view @cometix/codex version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }

  const spec = `@cometix/codex@${baseVer}-${suffix}`;
  console.log(`   [codex] fetching ${spec} via npm pack...`);

  const tmpDir = path.join(os.tmpdir(), "cometix-codex-pack", platform);
  const extractDir = path.join(tmpDir, "extracted");
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const tgzName = execSync(`npm pack ${spec} --pack-destination "${tmpDir}"`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();

    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });
    return path.join(extractDir, "package");
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
    return null;
  }
}

function resolveVendorFile(platform, relativeParts) {
  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;

  const cometixPlatformPackage = COMETIX_PLATFORM_PACKAGE[platform];
  const candidates = [
    cometixPlatformPackage && path.join(PROJECT_ROOT, "node_modules", "@cometix", cometixPlatformPackage, "vendor", triple, ...relativeParts),
    path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple, ...relativeParts),
    path.join(PROJECT_ROOT, "node_modules", "@openai", "codex", "vendor", triple, ...relativeParts),
  ];

  const existing = findExisting(candidates);
  if (existing) return existing;

  const packed = npmPackCometix(platform);
  if (!packed) return null;

  const packedPath = path.join(packed, "vendor", triple, ...relativeParts);
  return fs.existsSync(packedPath) ? packedPath : null;
}

function resolveCodexVendor(platform) {
  const binName = platform === "win" ? "codex.exe" : "codex";
  const resolved = resolveVendorFile(platform, ["codex", binName]);
  if (resolved) return resolved;

  const triple = TARGET_TRIPLE_MAP[platform];
  const rgPath = commandPath("rg");
  if (triple && rgPath) {
    const vendorNeedle = `${path.sep}vendor${path.sep}${triple}${path.sep}path${path.sep}rg`;
    if (rgPath.endsWith(vendorNeedle)) {
      const vendorRoot = rgPath.slice(0, -vendorNeedle.length);
      const siblingCodex = path.join(vendorRoot, "vendor", triple, "codex", binName);
      if (fs.existsSync(siblingCodex)) return siblingCodex;
    }
  }

  return null;
}

function resolveRipgrepVendor(platform) {
  const systemRg = commandPath("rg");
  if (systemRg && isElf(systemRg)) {
    const expected = EXPECTED_ELF_MACHINE[platform];
    if (!expected || getElfMachine(systemRg) === expected) return systemRg;
  }
  return resolveVendorFile(platform, ["path", platform === "win" ? "rg.exe" : "rg"]);
}

function copyLinuxExecutable(source, dest, platform, label) {
  assertLinuxElf(source, platform, label);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
}

module.exports = {
  TARGET_TRIPLE_MAP,
  assertLinuxElf,
  copyLinuxExecutable,
  getElfMachine,
  isElf,
  isMachO,
  resolveCodexVendor,
  resolveRipgrepVendor,
};
