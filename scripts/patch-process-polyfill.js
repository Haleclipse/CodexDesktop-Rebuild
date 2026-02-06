/**
 * 构建后补丁脚本：注入 process polyfill（Windows 兼容性）
 *
 * Codex webview bundle 中存在对 `process` 全局对象的直接访问
 * （如 process.env、process.platform 等），这在浏览器环境中不存在。
 * macOS/Linux 的 Electron 预加载脚本会注入 process，
 * 但 Windows 环境下可能缺失，导致白屏。
 *
 * 此脚本：
 *   1. 生成 process-polyfill.js 文件
 *   2. 在 index.html 中注入 <script> 标签（bundle 之前加载）
 *
 * 用法：
 *   node scripts/patch-process-polyfill.js          # 执行 patch
 *   node scripts/patch-process-polyfill.js --check  # 仅检查状态，不修改
 */
const fs = require("fs");
const path = require("path");

// ──────────────────────────────────────────────
//  Polyfill 内容
// ──────────────────────────────────────────────

const POLYFILL_CONTENT = `// Process polyfill for browser/Windows compatibility
(function() {
  if (typeof window.process === "object" && typeof window.process.cwd === "function") return;
  function detectPlatform() {
    var ua = navigator.userAgent.toLowerCase();
    if (ua.indexOf("win") !== -1) return "win32";
    if (ua.indexOf("mac") !== -1) return "darwin";
    if (ua.indexOf("linux") !== -1) return "linux";
    return "browser";
  }
  window.process = window.process || {
    cwd: function() { return "/"; },
    env: {},
    platform: detectPlatform(),
    version: "",
    versions: {},
    nextTick: function(fn) { setTimeout(fn, 0); }
  };
})();
`;

const POLYFILL_FILENAME = "process-polyfill.js";
const SCRIPT_TAG = `<script src="./assets/${POLYFILL_FILENAME}"></script>`;

// ──────────────────────────────────────────────
//  文件定位
// ──────────────────────────────────────────────

function locateFiles() {
  const webviewDir = path.join(__dirname, "..", "src", "webview");
  const indexHtml = path.join(webviewDir, "index.html");
  const assetsDir = path.join(webviewDir, "assets");
  const polyfillJs = path.join(assetsDir, POLYFILL_FILENAME);

  if (!fs.existsSync(indexHtml)) {
    console.error("❌ index.html 不存在:", indexHtml);
    process.exit(1);
  }

  return { webviewDir, indexHtml, assetsDir, polyfillJs };
}

// ──────────────────────────────────────────────
//  检查状态
// ──────────────────────────────────────────────

function checkStatus({ indexHtml, polyfillJs }) {
  const htmlContent = fs.readFileSync(indexHtml, "utf-8");
  const hasScriptTag = htmlContent.includes(POLYFILL_FILENAME);
  const hasPolyfillFile = fs.existsSync(polyfillJs);

  return { htmlContent, hasScriptTag, hasPolyfillFile };
}

// ──────────────────────────────────────────────
//  主流程
// ──────────────────────────────────────────────

function main() {
  const isCheck = process.argv.includes("--check");
  const files = locateFiles();
  const relHtml = path.relative(path.join(__dirname, ".."), files.indexHtml);
  const relPolyfill = path.relative(path.join(__dirname, ".."), files.polyfillJs);

  const status = checkStatus(files);

  // ── --check 模式 ──
  if (isCheck) {
    console.log("\n── process polyfill 检查 (只读) ──\n");
    console.log(`  📄 ${relPolyfill}: ${status.hasPolyfillFile ? "✅ 存在" : "🔧 缺失"}`);
    console.log(`  📄 ${relHtml} <script> 标签: ${status.hasScriptTag ? "✅ 已注入" : "🔧 缺失"}`);

    if (status.hasPolyfillFile && status.hasScriptTag) {
      console.log("\n✅ process polyfill 已就绪");
    } else {
      console.log("\n💡 运行 node scripts/patch-process-polyfill.js 以修复");
    }
    return;
  }

  // ── patch 模式 ──
  let changes = 0;

  // 1. 确保 polyfill 文件存在
  if (!status.hasPolyfillFile) {
    fs.writeFileSync(files.polyfillJs, POLYFILL_CONTENT);
    console.log(`  ✏️  创建 ${relPolyfill}`);
    changes++;
  } else {
    // 检查内容是否需要更新
    const existing = fs.readFileSync(files.polyfillJs, "utf-8");
    if (existing !== POLYFILL_CONTENT) {
      fs.writeFileSync(files.polyfillJs, POLYFILL_CONTENT);
      console.log(`  ✏️  更新 ${relPolyfill}`);
      changes++;
    }
  }

  // 2. 确保 index.html 中有 <script> 标签
  if (!status.hasScriptTag) {
    let html = status.htmlContent;

    // 在第一个 <script type="module" ...> 之前插入 polyfill script
    const moduleScriptRegex = /<script\s+type="module"/;
    const match = html.match(moduleScriptRegex);

    if (match && match.index !== undefined) {
      html =
        html.slice(0, match.index) +
        SCRIPT_TAG +
        "\n    " +
        html.slice(match.index);
      fs.writeFileSync(files.indexHtml, html);
      console.log(`  ✏️  注入 <script> 到 ${relHtml}`);
      changes++;
    } else {
      // 回退：在 <title> 之后插入
      const titleEnd = html.indexOf("</title>");
      if (titleEnd !== -1) {
        const insertPos = titleEnd + "</title>".length;
        html =
          html.slice(0, insertPos) +
          "\n    " +
          SCRIPT_TAG +
          html.slice(insertPos);
        fs.writeFileSync(files.indexHtml, html);
        console.log(`  ✏️  注入 <script> 到 ${relHtml} (title 之后)`);
        changes++;
      } else {
        console.error("❌ 无法定位 index.html 中的注入点");
        process.exit(1);
      }
    }
  }

  if (changes === 0) {
    console.log("ℹ️  process polyfill 已就绪, 无需修改");
  } else {
    console.log(`\n✅ process polyfill 已注入: ${changes} 处修改`);
  }
}

main();
