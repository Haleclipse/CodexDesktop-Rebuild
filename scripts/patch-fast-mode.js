#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector)
 *
 * The speed selector is gated by authMethod === "chatgpt" checks.
 * API-key users never see it because their authMethod differs.
 *
 * This patch locates auth gates inside functions that also reference
 * "fast_mode", and either removes legacy negative gates or extends
 * positive ChatGPT-only gates to include API-key auth.
 *
 * Target: service-tier / permissions chunks that contain the pattern.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const CHATGPT_AUTH = "chatgpt";
const APIKEY_AUTH = "apikey";
const ALWAYS_FALSE = "!1";

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
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

function sourceFor(source, node) {
  return source.slice(node.start, node.end);
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isStringLiteral(node, value) {
  if (node.type === "Literal") return node.value === value;
  if (node.type !== "TemplateLiteral") return false;
  return (
    node.expressions.length === 0 &&
    node.quasis.length === 1 &&
    node.quasis[0].value.cooked === value
  );
}

function isFalseLiteral(node, source) {
  if (node.type === "Literal") return node.value === false;
  return sourceFor(source, node) === ALWAYS_FALSE;
}

function getChatGptEqualityOperand(node, source) {
  if (node.type !== "BinaryExpression" || node.operator !== "===") return null;
  if (isStringLiteral(node.right, CHATGPT_AUTH)) return sourceFor(source, node.left);
  if (isStringLiteral(node.left, CHATGPT_AUTH)) return sourceFor(source, node.right);
  return null;
}

function buildApiKeyAuthExpression(operand) {
  return `${operand}===\`${CHATGPT_AUTH}\`||${operand}===\`${APIKEY_AUTH}\``;
}

function hasApiKeyEquality(node, source, operand) {
  let found = false;
  walk(node, (child) => {
    if (found || child.type !== "BinaryExpression" || child.operator !== "===") {
      return;
    }
    const left = sourceFor(source, child.left);
    const right = sourceFor(source, child.right);
    found =
      (left === operand && isStringLiteral(child.right, APIKEY_AUTH)) ||
      (right === operand && isStringLiteral(child.left, APIKEY_AUTH));
  });
  return found;
}

function isAlreadyApiKeyAuthGate(node, parent, source, operand) {
  if (parent?.type !== "LogicalExpression" || parent.operator !== "||") {
    return false;
  }
  return hasApiKeyEquality(parent, source, operand);
}

function addPatch(patches, patch) {
  if (patches.some((p) => p.start === patch.start)) return;
  patches.push(patch);
}

function collectLegacyNegativeGatePatches(node, source, patches) {
  if (node.type !== "BinaryExpression" || node.operator !== "!==") return;

  const original = sourceFor(source, node);
  if (!original.includes("authMethod") || !original.includes(CHATGPT_AUTH)) return;
  if (original === ALWAYS_FALSE) return;

  addPatch(patches, {
    id: "fast_mode_legacy_auth_gate",
    start: node.start,
    end: node.end,
    replacement: ALWAYS_FALSE,
    original,
  });
}

function collectPositiveAuthGatePatches(node, parent, source, patches) {
  const original = sourceFor(source, node);
  const operand = getChatGptEqualityOperand(node, source);
  if (operand == null || !original.includes("authMethod")) return;
  if (isAlreadyApiKeyAuthGate(node, parent, source, operand)) return;

  addPatch(patches, {
    id: "fast_mode_positive_auth_gate",
    start: node.start,
    end: node.end,
    replacement: buildApiKeyAuthExpression(operand),
    original,
  });
}

function collectConditionalAuthGatePatches(node, source, patches) {
  if (node.type !== "ConditionalExpression") return;
  if (!sourceFor(source, node.consequent).includes("fast_mode")) return;
  if (!sourceFor(source, node).includes("authMethod")) return;
  if (!isFalseLiteral(node.alternate, source)) return;

  const operand = getChatGptEqualityOperand(node.test, source);
  if (operand == null) return;

  addPatch(patches, {
    id: "fast_mode_conditional_auth_gate",
    start: node.test.start,
    end: node.test.end,
    replacement: buildApiKeyAuthExpression(operand),
    original: sourceFor(source, node.test),
  });
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and fast_mode
    if (!isFunctionNode(node)) return;

    const fnSrc = sourceFor(source, node);
    if (!fnSrc.includes("authMethod") || !fnSrc.includes("fast_mode")) return;

    // Inside this function, find auth gates tied to Fast mode.
    walk(node, (child, parent) => {
      collectLegacyNegativeGatePatches(child, source, patches);
      collectPositiveAuthGatePatches(child, parent, source, patches);
      collectConditionalAuthGatePatches(child, source, patches);
    });
  });

  return patches;
}

function findTargets(platforms) {
  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("authMethod") && src.includes("fast_mode")) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

function parseBundle(bundle, source) {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`${relPath(bundle.path)} parse failed: ${error.message}`);
  }
}

function applyPatches(source, patches) {
  let code = source;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    console.log(`    * ${patch.original} -> ${patch.replacement}`);
    code =
      code.slice(0, patch.start) +
      patch.replacement +
      code.slice(patch.end);
  }
  return code;
}

function getPlatforms(platform) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((p) =>
    fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
  );
}

function processBundle(bundle, isCheck) {
  const source = fs.readFileSync(bundle.path, "utf-8");
  const t0 = Date.now();
  const ast = parseBundle(bundle, source);
  const patches = collectPatches(ast, source);

  if (patches.length === 0) return { candidates: 0, patched: 0 };

  console.log(
    `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
  );

  if (isCheck) {
    for (const patch of patches) {
      console.log(`    [?] offset ${patch.start}: ${patch.original} -> ${patch.replacement}`);
    }
    return { candidates: patches.length, patched: 0 };
  }

  fs.writeFileSync(bundle.path, applyPatches(source, patches), "utf-8");
  return { candidates: patches.length, patched: patches.length };
}

function printSummary({ isCheck, totalCandidates, totalPatched }) {
  if (isCheck && totalCandidates > 0) {
    console.log(`  [ok] ${totalCandidates} auth gate(s) would be patched`);
  } else if (isCheck) {
    console.log("  [ok] no fast_mode auth gates need patching");
  } else if (totalPatched > 0) {
    const candidateSuffix =
      totalCandidates && totalCandidates !== totalPatched
        ? ` (out of ${totalCandidates} candidate auth gate(s))`
        : "";
    console.log(`  [ok] ${totalPatched} auth gate(s) patched${candidateSuffix}`);
  } else {
    console.log("  [ok] fast_mode auth gates already patched or absent");
  }
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const targets = findTargets(getPlatforms(platform));

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;
  let totalCandidates = 0;

  for (const bundle of targets) {
    const result = processBundle(bundle, isCheck);
    totalCandidates += result.candidates;
    totalPatched += result.patched;
  }

  printSummary({ isCheck, totalCandidates, totalPatched });
}

if (require.main === module) {
  main();
}

module.exports = { collectPatches };
