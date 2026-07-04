#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch all generated platforms
 *   node scripts/patch-all.js unix         # Patch mac-arm64 + mac-x64 only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PATCHES = [
  "patch-i18n.js",
  "patch-copyright.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-composer-workspace-root.js",
  "patch-updater.js",
  "patch-archive-delete.js",
  "patch-crash-forensics.js",
  "patch-worker-forensics.js",
  "patch-worker-limits.js",
  "patch-diff-limits.js",
  "patch-git-output-cap.js",
  "patch-sentry-scope.js",
  "patch-cdp-screenshot.js",
];

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const extra = args.filter((a) => a.startsWith("--"));
  const targetPlatforms = platform === "unix"
    ? ["mac-arm64", "mac-x64"].filter((p) =>
        fs.existsSync(path.join(__dirname, "..", "src", p, "_asar")),
      )
    : platform
      ? [platform]
      : [null];

  if (platform === "unix" && targetPlatforms.length === 0) {
    console.log("[skip] No generated unix/mac platform sources found");
    return;
  }

  let failed = 0;

  for (const targetPlatform of targetPlatforms) {
    const passArgs = [...(targetPlatform ? [targetPlatform] : []), ...extra];
    const scope = targetPlatform ? ` (${targetPlatform})` : "";

    for (const script of PATCHES) {
      const scriptPath = path.join(__dirname, script);
      const label = script.replace(".js", "");
      console.log(`\n== ${label}${scope} ==`);

      try {
        execFileSync("node", [scriptPath, ...passArgs], { stdio: "inherit" });
      } catch (e) {
        console.error(`[x] ${label}${scope} failed (exit ${e.status})`);
        failed++;
      }
    }
  }

  const total = PATCHES.length * targetPlatforms.length;
  console.log(`\n== Summary: ${total - failed}/${total} succeeded ==`);
  if (failed > 0) process.exit(1);
}

main();
