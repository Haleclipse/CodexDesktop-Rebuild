/**
 * 构建后补丁脚本：解锁 i18n 多语言功能
 *
 * Codex 内置完整的 react-intl 多语言体系（59 语言、1,598 条翻译），
 * 但被 Statsig feature gate `codex-i18n` 控制。
 *
 * 即使修改 .get() 的默认值也不够 —— 当 Statsig 后端可达时，
 * 服务端返回的 enable_i18n=false 会覆盖默认值。
 *
 * 因此本脚本直接将整个 gate 调用 `?.get("enable_i18n", ...)` 替换为 `!0`，
 * 彻底绕过 Statsig 控制。
 *
 * 用法：
 *   node scripts/patch-i18n.js          # 执行 patch
 *   node scripts/patch-i18n.js --check  # 仅检查匹配情况，不修改
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

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

/**
 * 规则数组 — 可扩展
 *
 * 策略：替换整个 ?.get("enable_i18n", ...) 调用为 !0
 * 这样无论 Statsig 服务端返回什么值，i18n 都强制启用
 */
const RULES = [
  {
    id: "enable_i18n",
    description: "gate 调用 ?.get(\"enable_i18n\", ...) → !0",
    /**
     * 匹配条件：
     *   CallExpression（可能被 ChainExpression 包裹）
     *   - callee 是 MemberExpression，property.name === "get"
     *   - arguments[0] 是 Literal "enable_i18n"
     *   - arguments[1] 存在（任意值）
     *
     * 替换范围：整个 CallExpression（含 optional chain 包裹）
     *   ?.get("enable_i18n", !1)  →  !0
     *   ?.get("enable_i18n", !0)  →  !0
     */
    match(node, source) {
      // 匹配 ChainExpression 包裹的 CallExpression
      // 或直接的 CallExpression
      let callNode = null;
      let replaceNode = null; // 需要替换的最外层节点

      if (node.type === "ChainExpression" && node.expression?.type === "CallExpression") {
        callNode = node.expression;
        replaceNode = node; // 替换整个 ChainExpression
      } else if (node.type === "CallExpression") {
        callNode = node;
        replaceNode = node;
      }

      if (!callNode) return null;

      const callee = callNode.callee;
      if (!callee || callee.type !== "MemberExpression") return null;
      if (getPropertyName(callee) !== "get") return null;

      const args = callNode.arguments;
      if (!args || args.length < 2) return null;
      if (args[0].type !== "Literal" || args[0].value !== "enable_i18n") return null;

      const original = source.slice(replaceNode.start, replaceNode.end);

      // 已经被 patch 过（整个表达式就是 !0）→ 跳过
      if (original === "!0") return null;

      return {
        start: replaceNode.start,
        end: replaceNode.end,
        replacement: "!0",
        original,
      };
    },
  },
];

function getPropertyName(memberExpr) {
  if (!memberExpr || !memberExpr.property) return null;
  if (!memberExpr.computed && memberExpr.property.type === "Identifier") {
    return memberExpr.property.name;
  }
  if (memberExpr.computed && memberExpr.property.type === "Literal") {
    return memberExpr.property.value;
  }
  return null;
}

// ──────────────────────────────────────────────
//  第 3 层：文件定位 + 外科替换
// ──────────────────────────────────────────────

function locateBundle() {
  const assetsDir = path.join(__dirname, "..", "src", "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    console.error("❌ 资源目录不存在:", assetsDir);
    process.exit(1);
  }

  const files = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));

  if (files.length === 0) {
    console.error("❌ 未找到 index-*.js bundle 文件");
    process.exit(1);
  }
  if (files.length > 1) {
    console.error("❌ 发现多个 index-*.js 文件:", files.join(", "));
    process.exit(1);
  }

  return path.join(assetsDir, files[0]);
}

/**
 * 收集所有规则命中的 patch 点
 */
function collectPatches(ast, source) {
  const patches = [];
  const details = [];
  const seen = new Set(); // 防止 ChainExpression 和内部 CallExpression 重复命中

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (result && !seen.has(result.start)) {
        seen.add(result.start);
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
  const CONTEXT_CHARS = 40;
  const matches = [];
  const seen = new Set();

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (result && !seen.has(result.start)) {
        seen.add(result.start);
        const ctxStart = Math.max(0, result.start - CONTEXT_CHARS);
        const ctxEnd = Math.min(source.length, result.end + CONTEXT_CHARS);
        matches.push({
          ruleId: rule.id,
          position: result.start,
          original: result.original,
          context: source.slice(ctxStart, ctxEnd),
          wouldPatch: true,
        });
      }
    }

    // 也检测已 patch 的位置（原表达式已被替换为 !0）
    // 这些不会被 rule.match 命中（因为 original === "!0" 会跳过）
    // 无需额外处理，--check 只展示待 patch 的
  });

  return { matches };
}

/**
 * 统计所有 enable_i18n 相关调用（含已 patch 和未 patch）
 */
function countAllOccurrences(source) {
  let total = 0;
  let idx = -1;
  while ((idx = source.indexOf('"enable_i18n"', idx + 1)) !== -1) {
    total++;
  }
  return total;
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

  // ── --check 模式 ──
  if (isCheck) {
    console.log("\n── 匹配检查 (只读) ──\n");
    const { matches } = scanMatches(ast, source);
    const totalRefs = countAllOccurrences(source);

    if (matches.length === 0) {
      console.log(`📊 共 ${totalRefs} 处 "enable_i18n" 引用, 0 处待 patch`);
      console.log("✅ 所有 gate 调用已被替换为 !0");
    } else {
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        console.log(`  #${i + 1}  [${m.ruleId}]  🔧 待 patch`);
        console.log(`      位置: ${m.position}`);
        console.log(`      原始: ${m.original}`);
        console.log(`      上下文: ...${m.context}...`);
        console.log();
      }
      console.log(
        `📊 共 ${totalRefs} 处 "enable_i18n" 引用, ${matches.length} 处待 patch`
      );
    }
    return;
  }

  // ── patch 模式 ──
  const { patches, details } = collectPatches(ast, source);

  if (patches.length === 0) {
    const totalRefs = countAllOccurrences(source);
    if (totalRefs > 0) {
      console.log(`ℹ️  i18n 已全部启用 (${totalRefs} 处引用, 0 处待 patch), 无需修改`);
    } else {
      console.warn("⚠️  未找到 enable_i18n feature flag");
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
  console.log(`\n✅ i18n 已解锁: ${patches.length} 处 gate 调用 → !0`);
}

main();
