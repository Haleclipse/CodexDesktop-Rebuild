#!/usr/bin/env node
/**
 * Smart development startup script
 * Automatically detects system architecture and sets correct CLI path
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Detect platform and architecture
const platform = process.platform;
const arch = os.arch();

// Map to CLI binary paths
const platformMap = {
  darwin: {
    x64: 'darwin-x64',
    arm64: 'darwin-arm64',
  },
  linux: {
    x64: 'linux-x64',
    arm64: 'linux-arm64',
  },
  win32: {
    x64: 'win32-x64',
  },
};

const binDir = platformMap[platform]?.[arch];
if (!binDir) {
  console.error(`Unsupported platform/arch: ${platform}/${arch}`);
  process.exit(1);
}

const cliName = platform === 'win32' ? 'codex.exe' : 'codex';
const cliPath = path.join(__dirname, '..', 'resources', 'bin', binDir, cliName);

// Verify CLI exists
if (!fs.existsSync(cliPath)) {
  console.error(`CLI not found at: ${cliPath}`);
  console.error('Please ensure the CLI binary exists in resources/bin/');
  process.exit(1);
}

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] CLI Path: ${cliPath}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, ['.'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || 'dev',
    // 使用 app:// 自定义协议加载静态资源（而非 Vite dev server）
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'app://-/index.html',
  },
});

child.on('close', (code) => {
  process.exit(code);
});
