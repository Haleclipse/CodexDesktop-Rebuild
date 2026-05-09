const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");
const {
  copyLinuxExecutable,
  resolveCodexVendor,
  resolveRipgrepVendor,
} = require("./scripts/linux-native-utils");

function hasCommand(command) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  return pathEntries.some((entry) => {
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function buildMode() {
  try {
    return fs.readFileSync(path.join(__dirname, "src", ".build-mode"), "utf-8").trim();
  } catch {
    return "upstream-asar";
  }
}

function linuxPlatformKey(arch) {
  return arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function copyStagedOrResolvedLinuxResource(resourcesPath, platformKey, name, resolver) {
  const staged = path.join(__dirname, "src", ".linux-resources", platformKey, name);
  const source = fs.existsSync(staged) ? staged : resolver(platformKey);
  if (!source) {
    throw new Error(`Linux ${name} ELF not found for ${platformKey}`);
  }
  const dest = path.join(resourcesPath, name);
  copyLinuxExecutable(source, dest, platformKey, name);
  console.log(`   [linux] ${name}: ${path.relative(__dirname, source)} -> Resources/${name}`);
}

function copyLinuxResources(resourcesPath, platformKey) {
  const stagedDir = path.join(__dirname, "src", ".linux-resources", platformKey);
  if (!fs.existsSync(stagedDir)) return 0;

  let copied = 0;
  const copyDir = (sourceDir, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name === "app.asar" || entry.name === "app.asar.unpacked") continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyDir(sourcePath, destPath);
      } else if (!entry.isSymbolicLink()) {
        fs.copyFileSync(sourcePath, destPath);
        copied++;
      }
    }
  };

  copyDir(stagedDir, resourcesPath);
  return copied;
}

module.exports = {
  packagerConfig: {
    name: "Codex",
    executableName: "Codex",
    appBundleId: "com.openai.codex",
    icon: "./resources/electron",
    // Build mode is set by prepare-src.js via src/.build-mode marker file.
    // "upstream-asar": mac/win — we provide pre-built app.asar, forge skips ASAR packing.
    // "linux": forge packs ASAR from src/ content (needs electron-rebuild).
    asar: (() => buildMode() === "upstream-asar"
      ? false
      : { unpack: "{**/*.node,**/node-pty/build/Release/spawn-helper,**/node-pty/prebuilds/*/spawn-helper}" }
    )(),
    ignore: (() => {
      const mode = buildMode();
      return mode === "upstream-asar"
        ? (filePath) => {
            // Allow only package.json + stub main entry (forge validates it)
            if (filePath === "") return false;
            if (filePath === "/package.json") return false;
            if (filePath === "/src" || filePath.startsWith("/src/.vite")) return false;
            return true;
          }
        : (filePath) => {
            if (filePath === "") return false;
            if (filePath === "/package.json") return false;
            const allowed = ["/src/.vite/build", "/src/webview", "/src/skills", "/src/native-menu-locales", "/src/node_modules"];
            for (const p of allowed) {
              if (p.startsWith(filePath) || filePath.startsWith(p)) return false;
            }
            return true;
          };
    })(),
    osxSign: process.env.SKIP_SIGN ? undefined : {
      identity: process.env.APPLE_IDENTITY,
      identityValidation: false,
    },
    osxNotarize: process.env.SKIP_NOTARIZE ? undefined : {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    },
    win32metadata: {
      CompanyName: "OpenAI",
      ProductName: "Codex",
    },
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-dmg", config: { format: "ULFO", icon: "./resources/electron.icns" } },
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Codex",
        authors: "OpenAI, Cometix Space",
        description: "Codex Desktop App",
        setupIcon: "./resources/electron.ico",
        iconUrl: "https://raw.githubusercontent.com/Haleclipse/CodexDesktop-Rebuild/master/resources/electron.ico",
      },
    },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
    {
      name: "@electron-forge/maker-deb",
      config: { options: { name: "codex", productName: "Codex", genericName: "AI Coding Assistant", categories: ["Development", "Utility"], bin: "Codex", maintainer: "Cometix Space", homepage: "https://github.com/Haleclipse/CodexDesktop-Rebuild", icon: "./resources/electron.png" } },
    },
    ...(!["linux"].includes(process.platform) || hasCommand("rpm") ? [{
      name: "@electron-forge/maker-rpm",
      config: { options: { name: "codex", productName: "Codex", genericName: "AI Coding Assistant", categories: ["Development", "Utility"], bin: "Codex", license: "Apache-2.0", homepage: "https://github.com/Haleclipse/CodexDesktop-Rebuild", icon: "./resources/electron.png" } },
    }] : []),
    { name: "@electron-forge/maker-zip", platforms: ["linux"] },
  ],
  plugins: [
    // No auto-unpack-natives: mac/win provide upstream app.asar.unpacked;
    // Linux uses Forge ASAR packing after electron-rebuild in src/node_modules.
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: true,
        [FuseV1Options.EnableCookieEncryption]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
        [FuseV1Options.EnableNodeCliInspectArguments]: true,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
        [FuseV1Options.OnlyLoadAppFromAsar]: false,
      },
    },
  ],
  hooks: {
    // Copy everything from the platform dir to the app's Resources for mac/win:
    // - app.asar (repacked by prepare-src with patches applied)
    // - app.asar.unpacked/ (upstream native modules, untouched)
    // - All other resources (codex CLI, rg, plugins, native, etc.)
    //
    // Forge's own ASAR packing is disabled for upstream-asar builds.
    // Linux must not copy app.asar/app.asar.unpacked from src/mac-*.
    packageAfterCopy: async (config, buildPath, electronVersion, platform, arch) => {
      console.log(`\n-- packageAfterCopy: ${platform}-${arch}`);

      const resourcesPath = path.dirname(buildPath);

      if (platform === "linux") {
        const platformKey = linuxPlatformKey(arch);
        const copied = copyLinuxResources(resourcesPath, platformKey);
        console.log(`   [linux] copied ${copied} sanitized resource files`);
        copyStagedOrResolvedLinuxResource(resourcesPath, platformKey, "codex", resolveCodexVendor);
        copyStagedOrResolvedLinuxResource(resourcesPath, platformKey, "rg", resolveRipgrepVendor);
        console.log("   [linux] app.asar/app.asar.unpacked left to Forge output");
        return;
      }

      const platformKey = platform === "win32" ? "win"
        : `mac-${arch}`;

      const platformDir = path.join(__dirname, "src", platformKey);
      if (!fs.existsSync(platformDir)) {
        console.log(`   [!] src/${platformKey}/ not found`);
        return;
      }

      // Keep buildPath (app/) with package.json — forge needs it after this hook.
      // Our app.asar goes alongside it in Resources/.

      const skip = new Set(["_asar"]); // _asar is working dir, already repacked into app.asar
      let copied = 0;

      const copyDir = (s, d) => {
        fs.mkdirSync(d, { recursive: true });
        for (const e of fs.readdirSync(s, { withFileTypes: true })) {
          const sp = path.join(s, e.name), dp = path.join(d, e.name);
          if (e.isDirectory()) copyDir(sp, dp);
          else if (!e.isSymbolicLink()) { fs.copyFileSync(sp, dp); copied++; }
        }
      };

      for (const entry of fs.readdirSync(platformDir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        if (entry.name.endsWith(".lproj")) continue;

        const srcPath = path.join(platformDir, entry.name);
        const destPath = path.join(resourcesPath, entry.name);

        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else if (!entry.isSymbolicLink()) {
          fs.copyFileSync(srcPath, destPath);
          try { fs.chmodSync(destPath, 0o755); } catch {}
          copied++;
        }
      }

      console.log(`   [ok] ${copied} files (app.asar + unpacked + resources)`);
    },
  },
};
