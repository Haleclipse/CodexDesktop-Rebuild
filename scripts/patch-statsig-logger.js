/**
 * Post-build patch: Inject Statsig SDK cloud-control value logger
 *
 * Injects logging code into StatsigClientBase._setStatus method.
 * When Statsig completes initialization/update (values_updated event),
 * iterates and prints all feature gates, dynamic configs, layers.
 *
 * Intercept point:
 *   _setStatus(g, v) { this.loadingStatus = g, ... }
 *   -> inject console logger block at method body head
 *
 * Target file: statsig-*.js chunk (moved out of index-*.js in newer builds)
 * Fallback: index-*.js (older builds)
 *
 * Usage:
 *   node scripts/patch-statsig-logger.js [platform]   # mac-arm64 | mac-x64 | win | omit=all
 *   node scripts/patch-statsig-logger.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

// ──────────────────────────────────────────────
//  Injected code template
// ──────────────────────────────────────────────

const LOGGER_CODE = `
try {
  if (g === "Ready" && this._store) {
    const _container = this._store._values;
    const _raw = _container?._values || _container;
    const _fg = _raw.feature_gates || {};
    const _dc = _raw.dynamic_configs || {};
    const _lc = _raw.layer_configs || {};
    const _ps = _raw.param_stores || {};
    const _vals = _raw.values || {};
    console.group("[Statsig] values_updated -- status:", g, "source:", this._store._source);

    console.group("Feature Gates (" + Object.keys(_fg).length + ")");
    for (const [k, v] of Object.entries(_fg)) {
      console.log(k, "=", v?.v === true ? "TRUE" : "FALSE", v?.r ? "(rule:" + v.r + ")" : "");
    }
    console.groupEnd();

    console.group("Dynamic Configs (" + Object.keys(_dc).length + ")");
    for (const [k, v] of Object.entries(_dc)) {
      console.log(k, "=", JSON.stringify(v?.v || {}), v?.r ? "(rule:" + v.r + ")" : "");
    }
    console.groupEnd();

    console.group("Layers (" + Object.keys(_lc).length + ")");
    for (const [k, v] of Object.entries(_lc)) {
      const layerValues = _vals[v?.v] || v?.v || {};
      console.log(k, "=", JSON.stringify(layerValues), v?.r ? "(rule:" + v.r + ")" : "");
    }
    console.groupEnd();

    if (Object.keys(_ps).length > 0) {
      console.group("Param Stores (" + Object.keys(_ps).length + ")");
      for (const [k, v] of Object.entries(_ps)) {
        console.log(k, "=", JSON.stringify(v));
      }
      console.groupEnd();
    }

    console.log("[raw keys]", Object.keys(_raw));
    console.groupEnd();
  }
} catch(_e) { console.warn("[Statsig Logger] error:", _e); }
`.trim();

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

function collectPatches(ast, source) {
  const patches = [];
  const seen = new Set();

  walk(ast, (node) => {
    if (node.type !== "Property" && node.type !== "MethodDefinition") return;

    const keyName = getPropertyName(node.key);
    if (keyName !== "_setStatus") return;

    const func = node.value || node;
    if (!func.body || func.body.type !== "BlockStatement") return;

    const funcSrc = source.slice(func.body.start, func.body.end);
    if (!funcSrc.includes("values_updated")) return;

    // Idempotent: skip if already injected
    if (funcSrc.includes("[Statsig] values_updated")) return;

    const insertPos = func.body.start + 1;
    if (seen.has(insertPos)) return;
    seen.add(insertPos);

    patches.push({
      start: insertPos,
      end: insertPos,
      replacement: LOGGER_CODE,
      original: "",
    });
  });

  return patches;
}

// ──────────────────────────────────────────────
//  Bundle location: try statsig-*.js first, fall back to index-*.js
// ──────────────────────────────────────────────

function locateTargets(platform) {
  // Try statsig chunk first (newer builds)
  let bundles = locateBundles({
    dir: "assets",
    pattern: /^statsig-.*\.js$/,
    platform,
  });

  if (bundles.length > 0) return bundles;

  // Fallback to index bundle (older builds)
  return locateBundles({
    dir: "assets",
    pattern: /^index-.*\.js$/,
    platform,
  });
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateTargets(platform);

  if (bundles.length === 0) {
    console.error("[x] No statsig or index bundle found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      if (source.includes("[Statsig] values_updated")) {
        console.log("   [ok] Logger already injected");
      } else if (!source.includes("_setStatus")) {
        console.log("   [!] _setStatus not found in this file");
      } else {
        console.log("   [!] _setStatus found but did not match pattern");
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > insert at offset ${p.start}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * insert at offset ${p.start}: Statsig cloud-control logger`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Statsig logger injected: ${patches.length} insertion points`);
  }
}

main();
