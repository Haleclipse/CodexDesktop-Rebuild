const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

const githubRepository = process.env.GITHUB_REPOSITORY || "";
const githubRefName = process.env.GITHUB_REF_NAME || "master";
const repositoryUrl =
  process.env.CODEX_REPOSITORY_URL ||
  (githubRepository ? `https://github.com/${githubRepository}` : undefined);
const remoteIconUrl =
  process.env.CODEX_ICON_URL ||
  (githubRepository
    ? `https://raw.githubusercontent.com/${githubRepository}/${githubRefName}/resources/electron.ico`
    : undefined);

function withRepositoryHomepage(options) {
  return repositoryUrl ? { ...options, homepage: repositoryUrl } : options;
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
    asar: (() => {
      try {
        return fs.readFileSync(path.join(__dirname, "src", ".build-mode"), "utf-8").trim() === "upstream-asar"
          ? false
          : { unpack: "{**/*.node,**/node-pty/build/Release/spawn-helper,**/node-pty/prebuilds/*/spawn-helper}" };
      } catch { return false; }
    })(),
    ignore: (() => {
      let mode = "upstream-asar";
      try { mode = fs.readFileSync(path.join(__dirname, "src", ".build-mode"), "utf-8").trim(); } catch {}
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
        ...(remoteIconUrl ? { iconUrl: remoteIconUrl } : {}),
      },
    },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
    {
      name: "@electron-forge/maker-deb",
      config: { options: withRepositoryHomepage({ name: "codex", productName: "Codex", genericName: "AI Coding Assistant", categories: ["Development", "Utility"], bin: "Codex", maintainer: "Cometix Space", icon: "./resources/electron.png" }) },
    },
    {
      name: "@electron-forge/maker-rpm",
      config: { options: withRepositoryHomepage({ name: "codex", productName: "Codex", genericName: "AI Coding Assistant", categories: ["Development", "Utility"], bin: "Codex", license: "Apache-2.0", icon: "./resources/electron.png" }) },
    },
    { name: "@electron-forge/maker-zip", platforms: ["linux"] },
  ],
  plugins: [
    // No auto-unpack-natives — we provide upstream app.asar.unpacked directly
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
    // Copy everything from the platform dir to the app's Resources:
    // - app.asar (repacked by prepare-src with patches applied)
    // - app.asar.unpacked/ (upstream native modules, untouched)
    // - All other resources (codex CLI, rg, plugins, native, etc.)
    //
    // Forge's own ASAR packing is disabled (asar: false).
    // buildPath points to the app dir — we put app.asar alongside it.
    packageAfterCopy: async (config, buildPath, electronVersion, platform, arch) => {
      console.log(`\n-- packageAfterCopy: ${platform}-${arch}`);

      const resourcesPath = path.dirname(buildPath);
      const isLinux = platform === "linux";
      const platformKey = platform === "win32" ? "win" : `mac-${arch}`;

      const platformDir = path.join(__dirname, "src", platformKey);
      if (!fs.existsSync(platformDir)) {
        console.log(`   [!] src/${platformKey}/ not found`);
        return;
      }

      // Skip _asar (already repacked into app.asar or packed by forge for Linux).
      // For Linux: also skip macOS-only binaries and app.asar (forge packs its own).
      const skip = new Set(["_asar"]);
      const MACOS_ONLY_FILES = new Set([
        "node", "node_repl",
        "electron.icns", "Assets.car",
        "codexTemplate.png", "codexTemplate@2x.png",
        "app.asar", "codex-notification.wav",
      ]);
      const MACOS_ONLY_DIRS = new Set(["native", "app.asar.unpacked"]);
      if (isLinux) {
        for (const f of MACOS_ONLY_FILES) skip.add(f);
        for (const d of MACOS_ONLY_DIRS) skip.add(d);
      }
      let copied = 0;
      let skippedForeignArch = 0;

      // @oai/sky ships Linux binaries for multiple CPU architectures.
      // rpm's brp-strip runs target-arch strip over every executable in the package;
      // leaving the foreign one inside the RPM makes linux-x64 fail on sky_linux_arm64
      // (and vice versa for arm64).
      const shouldSkipForeignLinuxBinary = (name) => {
        if (!isLinux) return false;
        if (arch === "x64" && name === "sky_linux_arm64") return true;
        if (arch === "arm64" && name === "sky_linux_x64") return true;
        return false;
      };

      const copyDir = (s, d) => {
        fs.mkdirSync(d, { recursive: true });
        for (const e of fs.readdirSync(s, { withFileTypes: true })) {
          const sp = path.join(s, e.name), dp = path.join(d, e.name);
          if (e.isDirectory()) copyDir(sp, dp);
          else if (!e.isSymbolicLink()) {
            if (shouldSkipForeignLinuxBinary(e.name)) { skippedForeignArch++; continue; }
            fs.copyFileSync(sp, dp);
            copied++;
          }
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
          if (shouldSkipForeignLinuxBinary(entry.name)) { skippedForeignArch++; continue; }
          fs.copyFileSync(srcPath, destPath);
          try { fs.chmodSync(destPath, 0o755); } catch {}
          copied++;
        }
      }

      console.log(`   [ok] ${copied} files (app.asar + unpacked + resources)`);
      if (skippedForeignArch) console.log(`   [ok] skipped ${skippedForeignArch} foreign-arch Linux binaries`);
    },
  },
};
