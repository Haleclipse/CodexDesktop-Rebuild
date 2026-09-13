#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector)
 *
 * The speed selector and request-time service_tier plumbing are gated by
 * authMethod === "chatgpt" checks. API-key users never see/use it because
 * their authMethod differs.
 *
 * This patch locates BinaryExpression nodes matching the old gate:
 *   X.authMethod !== "chatgpt"
 * inside functions that also reference "fast_mode", and replaces
 * the comparison with !1 (always false), removing the auth gate.
 *
 * It also handles the newer gate shape:
 *   X.authMethod === "chatgpt"
 *   authMethod === "chatgpt"
 * inside fast_mode functions, and expands it to also allow "apikey".
 *
 * Target: chunks containing "fast_mode" + "chatgpt".
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type)
          walk(item, visitor, node);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

function isChatGptLiteral(node) {
  return (
    (node.type === "Literal" && node.value === "chatgpt") ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.length === 1 &&
      node.quasis[0].value.cooked === "chatgpt")
  );
}

function expressionSourceForApiKeySide(binary, source) {
  if (isChatGptLiteral(binary.right)) return source.slice(binary.left.start, binary.left.end);
  if (isChatGptLiteral(binary.left)) return source.slice(binary.right.start, binary.right.end);
  return null;
}

function isAlreadyExpandedToApiKey(parent, source) {
  if (!parent || parent.type !== "LogicalExpression" || parent.operator !== "||")
    return false;
  return source.slice(parent.start, parent.end).includes("apikey");
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and fast_mode
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("fast_mode") || !fnSrc.includes("chatgpt")) return;

    walk(node, (child, parent) => {
      if (child.type !== "BinaryExpression") return;

      const childSrc = source.slice(child.start, child.end);

      // Old shape: X.authMethod !== "chatgpt" gates the fast-mode selector.
      if (child.operator === "!==") {
        if (!childSrc.includes("authMethod") || !childSrc.includes("chatgpt"))
          return;

        if (childSrc === "!1") return;

        // Avoid duplicate patches at same offset
        if (patches.some((p) => p.start === child.start)) return;

        patches.push({
          id: "fast_mode_auth_gate",
          start: child.start,
          end: child.end,
          replacement: "!1",
          original: childSrc,
        });
        return;
      }

      // New shape: authMethod === "chatgpt" or authKind === "chatgpt".
      // Expand it to allow API-key auth as well.
      if (child.operator === "===") {
        const apiKeySide = expressionSourceForApiKeySide(child, source);
        if (apiKeySide == null) return;
        if (isAlreadyExpandedToApiKey(parent, source)) return;

        // Avoid duplicate patches at same offset
        if (patches.some((p) => p.start === child.start)) return;

        patches.push({
          id: "fast_mode_api_auth_gate",
          start: child.start,
          end: child.end,
          replacement: `${childSrc}||${apiKeySide}===\`apikey\``,
          original: childSrc,
        });
      }
    });
  });

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("chatgpt") && src.includes("fast_mode")) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;
  let totalFound = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      continue;
    }

    const patches = collectPatches(ast, source);

    if (patches.length === 0) continue;
    totalFound += patches.length;

    console.log(
      `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
    );

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`    * ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} auth gate(s) removed`);
  } else if (isCheck && totalFound > 0) {
    console.log(`  [check] ${totalFound} auth gate(s) would be patched`);
  } else {
    console.log("  [ok] fast_mode auth gates already patched or absent");
  }
}

main();
