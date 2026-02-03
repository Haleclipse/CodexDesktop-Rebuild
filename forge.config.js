const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

// 平台架构 -> @cometix/codex target triple 映射
const TARGET_TRIPLE_MAP = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
};

// 获取 codex 二进制路径（优先本地，其次 npm）
function getCodexBinaryPath(platform, arch) {
  const platformArch = `${platform}-${arch}`;
  const binaryName = platform === "win32" ? "codex.exe" : "codex";

  // 路径1: 本地 resources/bin/
  const localPath = path.join(__dirname, "resources", "bin", platformArch, binaryName);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // 路径2: npm @cometix/codex/vendor/
  const targetTriple = TARGET_TRIPLE_MAP[platformArch];
  if (targetTriple) {
    const npmPath = path.join(
      __dirname, "node_modules", "@cometix", "codex", "vendor",
      targetTriple, "codex", binaryName
    );
    if (fs.existsSync(npmPath)) {
      return npmPath;
    }
  }

  return null;
}

module.exports = {
  packagerConfig: {
    name: "Codex",
    executableName: "Codex",
    appBundleId: "com.openai.codex",
    icon: "./resources/electron",
    asar: {
      unpack: "**/*.node",
    },
    extraResource: ["./resources/notification.wav"],
    // macOS 签名配置
    osxSign: process.env.SKIP_SIGN
      ? undefined
      : {
          identity: process.env.APPLE_IDENTITY,
          identityValidation: false,
        },
    osxNotarize: process.env.SKIP_NOTARIZE
      ? undefined
      : {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        },
    // Windows 元数据
    win32metadata: {
      CompanyName: "OpenAI",
      ProductName: "Codex",
    },
  },
  rebuildConfig: {},
  makers: [
    // macOS DMG
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
        icon: "./resources/electron.icns",
      },
    },
    // macOS ZIP
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    // Windows Squirrel
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Codex",
        authors: "OpenAI, Cometix Space",
        description: "Codex Desktop App",
      },
    },
    // Windows ZIP
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
    },
    // Linux DEB
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          name: "codex",
          productName: "Codex",
          genericName: "AI Coding Assistant",
          categories: ["Development", "Utility"],
          bin: "Codex",
        },
      },
    },
    // Linux RPM
    {
      name: "@electron-forge/maker-rpm",
      config: {
        options: {
          name: "codex",
          productName: "Codex",
          genericName: "AI Coding Assistant",
          categories: ["Development", "Utility"],
          bin: "Codex",
        },
      },
    },
    // Linux ZIP
    {
      name: "@electron-forge/maker-zip",
      platforms: ["linux"],
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      },
    },
  ],
  hooks: {
    // 打包后复制对应平台的 codex 二进制
    packageAfterCopy: async (config, buildPath, electronVersion, platform, arch) => {
      console.log(`\n📦 Packaging for ${platform}-${arch}...`);
      console.log(`   buildPath: ${buildPath}`);

      const codexSrc = getCodexBinaryPath(platform, arch);
      const binaryName = platform === "win32" ? "codex.exe" : "codex";

      // buildPath 指向 app 目录，其父目录即为 Resources (macOS) 或 resources (其他)
      const resourcesPath = path.dirname(buildPath);
      const codexDest = path.join(resourcesPath, binaryName);

      if (codexSrc && fs.existsSync(codexSrc)) {
        fs.copyFileSync(codexSrc, codexDest);
        fs.chmodSync(codexDest, 0o755);
        console.log(`✅ Copied codex binary: ${codexSrc} -> ${codexDest}`);
      } else {
        console.error(`❌ Codex binary not found for ${platform}-${arch}`);
        console.error(`   Tried: resources/bin/${platform}-${arch}/${binaryName}`);
        console.error(`   Tried: node_modules/@cometix/codex/vendor/.../codex/${binaryName}`);
        process.exit(1);
      }
    },
  },
};
