const fs = require("fs");
const path = require("path");

/**
 * 构建后补丁脚本：
 * 1) 强制启用 i18n（显示语言选项，自动检测默认）
 * 2) 汉化主菜单与相关弹窗文字
 */

const rootDir = path.join(__dirname, "..");
const mainJsPath = path.join(rootDir, "src", ".vite", "build", "main.js");
const assetsDir = path.join(rootDir, "src", "webview", "assets");

function findRendererBundle() {
  if (!fs.existsSync(assetsDir)) return null;
  const files = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));
  if (files.length === 0) return null;
  if (files.length === 1) return path.join(assetsDir, files[0]);
  const pick = files
    .map((f) => ({ f, size: fs.statSync(path.join(assetsDir, f)).size }))
    .sort((a, b) => b.size - a.size)[0].f;
  return path.join(assetsDir, pick);
}

function patchRendererI18n() {
  const bundlePath = findRendererBundle();
  if (!bundlePath) {
    console.warn("⚠️  未找到 renderer bundle (index-*.js)");
    return;
  }
  let content = fs.readFileSync(bundlePath, "utf-8");
  const before = content;
  const reTrue = /\w+\?\.get\("enable_i18n",!0\)/g;
  const reFalse = /\w+\?\.get\("enable_i18n",!1\)/g;
  const c1 = (content.match(reTrue) || []).length;
  const c2 = (content.match(reFalse) || []).length;
  content = content.replace(reTrue, "!0").replace(reFalse, "!0");

  if (content !== before) {
    fs.writeFileSync(bundlePath, content);
    console.log(`✅ 已强制启用 i18n: ${path.basename(bundlePath)} (替换 ${c1 + c2} 处)`);
  } else {
    console.log("ℹ️  renderer bundle 未发现 enable_i18n 模式（可能已补丁）");
  }
}

function patchMainMenu() {
  if (!fs.existsSync(mainJsPath)) {
    console.warn("⚠️  未找到 main.js");
    return;
  }
  let content = fs.readFileSync(mainJsPath, "utf-8");
  let changed = 0;

  const replacements = [
    ["label:\"Settings…\"", "label:\"设置…\""],
    ["label:\"New Thread\"", "label:\"新对话\""],
    ["label:\"Open Folder…\"", "label:\"打开文件夹…\""],
    ["label:\"Log Out\"", "label:\"退出登录\""],
    ["label:\"Command Menu…\"", "label:\"命令菜单…\""],
    ["label:\"Increase Font Size\"", "label:\"增大字体\""],
    ["label:\"Decrease Font Size\"", "label:\"减小字体\""],
    ["label:`About ${F.app.getName()}`", "label:`关于 ${F.app.getName()}`"],
    ["title:\"About Codex\"", "title:\"关于 Codex\""],
    ["detail:`Version ${F.app.getVersion()}", "detail:`版本 ${F.app.getVersion()}"],
    ["label:\"Toggle Sidebar\"", "label:\"切换侧边栏\""],
    ["label:\"Toggle Terminal\"", "label:\"切换终端\""],
    ["label:\"Reload Window\"", "label:\"重新加载窗口\""],
    ["label:\"Toggle Diff Panel\"", "label:\"切换差异面板\""],
    ["label:\"Find\"", "label:\"查找\""],
    ["label:\"Previous Thread\"", "label:\"上一对话\""],
    ["label:\"Next Thread\"", "label:\"下一对话\""],
    ["label:\"Open Debug Window\"", "label:\"打开调试窗口\""],
    ["label:\"Toggle Query Devtools\"", "label:\"切换查询开发者工具\""],
    ["label:\"Back\"", "label:\"后退\""],
    ["label:\"Forward\"", "label:\"前进\""],
    ["label:\"Check for Updates…\"", "label:\"检查更新…\""],
    ["title:\"Updates Unavailable\"", "title:\"更新不可用\""],
    ["message:\"Automatic updates are unavailable right now.\"", "message:\"当前无法自动更新。\""],
    ["detail:`Sparkle initialization skipped: ${Fe}`", "detail:`已跳过 Sparkle 初始化：${Fe}`"],
    ["label:\"View\"", "label:\"视图\""],
    ["label:\"Codex documentation\"", "label:\"Codex 文档\""],
    ["label:\"Troubleshooting\"", "label:\"故障排除\""],
    ["label:\"Keyboard shortcuts\"", "label:\"键盘快捷键\""],
    ["label:\"Local Environments\"", "label:\"本地环境\""],
    ["label:\"Worktrees\"", "label:\"工作区\""],
    ["label:\"Hosts\"", "label:\"主机\""],
    ["label:\"Skills\"", "label:\"技能\""],
    ["label:\"Automations\"", "label:\"自动化\""],
    ["label:\"Model Context Protocol\"", "label:\"模型上下文协议\""],
    ["role:\"fileMenu\"", "label:\"文件\",role:\"fileMenu\""],
    ["{role:\"editMenu\"}", "{label:\"编辑\",role:\"editMenu\"}"],
    ["{role:\"windowMenu\"}", "{label:\"窗口\",role:\"windowMenu\"}"],
    ["{role:\"help\",submenu:[", "{label:\"帮助\",role:\"help\",submenu:["],
  ];

  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      const count = content.split(from).length - 1;
      content = content.replaceAll(from, to);
      changed += count;
    } else if (!content.includes(to)) {
      console.warn(`⚠️  未找到替换目标: ${from}`);
    }
  }

  if (changed > 0) {
    fs.writeFileSync(mainJsPath, content);
    console.log(`✅ 主菜单已汉化：替换 ${changed} 处`);
  } else {
    console.log("ℹ️  主菜单似乎已是中文或未命中可替换项");
  }
}

patchRendererI18n();
patchMainMenu();
