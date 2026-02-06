/**
 * 构建后补丁脚本：修改版权信息
 *
 * 使用 AST 精确定位 `setAboutPanelOptions({ copyright: "© OpenAI" })`
 * 并将版权文本替换为自定义值。
 *
 * 用法：
 *   node scripts/patch-copyright.js          # 执行 patch
 *   node scripts/patch-copyright.js --check  # 仅检查匹配情况，不修改
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

// ──────────────────────────────────────────────
//  配置
// ──────────────────────────────────────────────

const OLD_COPYRIGHT = "\u00A9 OpenAI"; // © OpenAI
const NEW_COPYRIGHT = "\u00A9 OpenAI \u00B7 Cometix Space"; // © OpenAI · Cometix Space

// ──────────────────────────────────────────────
//  第 1 层：AST 引擎 — 解析 + 递归遍历
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") {
          walk(item, visitor);
        }
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  第 2 层：声明式 Patch 规则
// ──────────────────────────────────────────────

const RULES = [
  {
    id: "copyright",
    description: `copyright 文本: "${OLD_COPYRIGHT}" → "${NEW_COPYRIGHT}"`,
    /**
     * 匹配条件：
     *   Property 节点:
     *     key.name === "copyright" 或 key.value === "copyright"
     *     value 是 Literal，且 value.value === OLD_COPYRIGHT
     *
     * 替换目标：value 节点的 Literal（含引号）
     */
    match(node) {
      if (node.type !== "Property") return null;

      // key 匹配 "copyright"
      const keyName =
        node.key.type === "Identifier"
          ? node.key.name
          : node.key.type === "Literal"
            ? node.key.value
            : null;
      if (keyName !== "copyright") return null;

      // value 是 Literal 且内容为旧版权
      if (
        node.value.type === "Literal" &&
        node.value.value === OLD_COPYRIGHT
      ) {
        return {
          start: node.value.start,
          end: node.value.end,
          replacement: JSON.stringify(NEW_COPYRIGHT),
          original: JSON.stringify(OLD_COPYRIGHT),
        };
      }

      return null;
    },
  },
];

// ──────────────────────────────────────────────
//  第 3 层：文件定位 + 外科替换
// ──────────────────────────────────────────────

/**
 * 自动定位 main bundle 文件
 * 优先匹配 main-{hash}.js，回退到 main.js
 */
function locateBundle() {
  const buildDir = path.join(__dirname, "..", "src", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.error("❌ 构建目录不存在:", buildDir);
    process.exit(1);
  }

  const files = fs.readdirSync(buildDir).filter((f) => /^main(-[^.]+)?\.js$/.test(f));

  if (files.length === 0) {
    console.error("❌ 未找到 main*.js bundle 文件");
    process.exit(1);
  }

  // 优先选择带 hash 的文件（main-xxx.js），回退到 main.js
  const hashed = files.find((f) => f !== "main.js");
  const target = hashed || files[0];
  return path.join(buildDir, target);
}

/**
 * 收集所有规则命中的 patch 点
 */
function collectPatches(ast) {
  const patches = [];
  const details = [];

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node);
      if (result) {
        patches.push({ ...result, ruleId: rule.id });
        details.push({
          ruleId: rule.id,
          position: result.start,
          change: `${result.original} → ${result.replacement}`,
        });
      }
    }
  });

  return { patches, details };
}

/**
 * 扫描所有匹配情况（用于 --check 模式）
 */
function scanMatches(ast, source) {
  const CONTEXT_CHARS = 50;
  const matches = [];

  walk(ast, (node) => {
    if (node.type !== "Property") return;

    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;
    if (node.value.type !== "Literal") return;

    const ctxStart = Math.max(0, node.start - CONTEXT_CHARS);
    const ctxEnd = Math.min(source.length, node.end + CONTEXT_CHARS);

    // 判断是否会被规则命中
    let wouldPatch = false;
    for (const rule of RULES) {
      if (rule.match(node)) {
        wouldPatch = true;
        break;
      }
    }

    matches.push({
      ruleId: "copyright",
      position: node.start,
      currentValue: node.value.value,
      snippet: source.slice(node.start, node.end),
      context: source.slice(ctxStart, ctxEnd),
      wouldPatch,
    });
  });

  return { matches };
}

// ──────────────────────────────────────────────
//  主流程
// ──────────────────────────────────────────────

function main() {
  const isCheck = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const relPath = path.relative(path.join(__dirname, ".."), bundlePath);

  console.log(`📄 目标文件: ${relPath}`);

  const source = fs.readFileSync(bundlePath, "utf-8");
  console.log(`📏 文件大小: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

  const t0 = Date.now();
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const parseTime = Date.now() - t0;
  console.log(`🔍 AST 解析: ${parseTime}ms`);

  // ── --check 模式：展示匹配情况，不修改文件 ──
  if (isCheck) {
    console.log("\n── 匹配检查 (只读) ──\n");
    const { matches } = scanMatches(ast, source);

    if (matches.length === 0) {
      console.log("⚠️  未找到任何 copyright 属性节点");
      return;
    }

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const tag = m.wouldPatch ? "🔧 待 patch" : "── 跳过";
      console.log(`  #${i + 1}  [${m.ruleId}]  ${tag}`);
      console.log(`      位置: ${m.position}  当前值: "${m.currentValue}"`);
      console.log(`      节点: ${m.snippet}`);
      console.log(`      上下文: ...${m.context}...`);
      console.log();
    }

    const patchable = matches.filter((m) => m.wouldPatch).length;
    console.log(
      `📊 共 ${matches.length} 处匹配, ${patchable} 处待 patch, ${matches.length - patchable} 处跳过`
    );
    return;
  }

  // ── patch 模式 ──
  const { patches, details } = collectPatches(ast);

  if (patches.length === 0) {
    const { matches } = scanMatches(ast, source);
    if (matches.length > 0) {
      console.log(
        `ℹ️  版权信息已是最新 (${matches.length} 处匹配, 0 处待 patch), 无需修改`
      );
    } else {
      console.warn("⚠️  未找到 copyright 属性节点");
    }
    return;
  }

  // 按 start 降序排列，避免偏移漂移
  patches.sort((a, b) => b.start - a.start);

  let code = source;
  for (const p of patches) {
    code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
  }

  fs.writeFileSync(bundlePath, code);

  for (const d of details) {
    console.log(`  ✏️  位置 ${d.position}: ${d.change}`);
  }
  console.log(`\n✅ 版权信息已更新: ${NEW_COPYRIGHT}`);
}

main();
