#!/usr/bin/env node
/**
 * 根据当前操作系统和 CPU 架构分发到对应平台构建脚本。
 */
const { spawnSync } = require("child_process");

const TARGET_SCRIPT = (() => {
  if (process.platform === "win32") return "build:win-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "build:mac-arm64" : "build:mac-x64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "build:linux-arm64" : "build:linux-x64";
  }
  return null;
})();

if (!TARGET_SCRIPT) {
  console.error(`[x] Unsupported platform: ${process.platform}-${process.arch}`);
  process.exit(1);
}

console.log(`[build] current platform ${process.platform}-${process.arch} -> npm run ${TARGET_SCRIPT}`);

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmBin, ["run", TARGET_SCRIPT], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`[x] Failed to run npm: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
