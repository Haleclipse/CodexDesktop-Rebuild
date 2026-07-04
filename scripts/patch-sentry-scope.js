#!/usr/bin/env node
/**
 * patch-sentry-scope.js — 限制 Sentry breadcrumbs 体积，防 scope_v3.json 膨胀
 *
 * 背景：实测发现 %APPDATA%/Codex/web/Codex/sentry/scope_v3.json 在长会话中
 * 膨胀到 40MB。原因是 app_state_snapshot 等 breadcrumb 的 data 字段随会话
 * 增长（单条可达数百 KB），而 @sentry/electron 的 SentryMinidump 集成会在
 * 每次 breadcrumb 更新时把整个 scope 同步序列化落盘。40MB JSON 的反复
 * stringify + 写盘发生在主进程，带来明显的内存波动与 CPU 开销，加剧了
 * 主进程的内存压力（WER 已记录到 RADAR_PRE_LEAK_64）。
 *
 * 修复：向两处 Sentry.init(...) 注入：
 *   1. maxBreadcrumbs: 20        —— scope 内最多保留 20 条（默认 100）
 *   2. beforeBreadcrumb: <fn>    —— 单条 data 序列化超过 4KB 时替换为占位符
 *
 * 注入点特征（worker.js 与 workspace-root-drop-handler-*.js 各一处）：
 *   dsn:XX,environment:...
 * 替换为：
 *   dsn:XX,maxBreadcrumbs:20,beforeBreadcrumb:<fn>,environment:...
 *
 * 写入前用 acorn 对整份文件做语法校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-sentry-scope.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-sentry-scope.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const MARKER = "__codex_bc_truncated";

// 内联注入的 beforeBreadcrumb：data 序列化超 4KB 就替换为占位符。
// 任何异常（如循环引用）都吞掉并原样返回，绝不影响上报流程。
const TRIM_FN =
  "e=>{try{if(e&&e.data){var t=JSON.stringify(e.data);" +
  "t.length>4096&&(e.data={" +
  MARKER +
  ":!0,bytes:t.length})}}catch(n){}return e}";

const OPTS = "maxBreadcrumbs:20,beforeBreadcrumb:" + TRIM_FN + ",";

// dsn:<标识符或成员访问>,environment: —— 两处 init 共同的锚点
const INIT_RE = /dsn:([\w$]+(?:\.[\w$]+)*),environment:/g;

const TARGETS = [/^worker\.js$/, /^workspace-root-drop-handler-.*\.js$/];

function patchOne(bundlePath, isCheck) {
  const code = fs.readFileSync(bundlePath, "utf-8");

  if (code.includes(MARKER)) {
    console.log(`  [ok] ${relPath(bundlePath)}: already patched`);
    return false;
  }

  let count = 0;
  const next = code.replace(INIT_RE, (_m, dsnExpr) => {
    count++;
    return `dsn:${dsnExpr},${OPTS}environment:`;
  });

  if (count === 0) {
    console.log(`  [!] ${relPath(bundlePath)}: no Sentry init anchor found`);
    return false;
  }

  try {
    acorn.parse(next, { ecmaVersion: 2022, sourceType: "module" });
  } catch (e) {
    try {
      acorn.parse(next, { ecmaVersion: 2022, sourceType: "script" });
    } catch (e2) {
      console.log(
        `  [x] ${relPath(bundlePath)}: post-inject parse failed, aborting (${e2.message})`,
      );
      return false;
    }
  }

  if (isCheck) {
    console.log(
      `  [?] ${relPath(bundlePath)}: would patch ${count} Sentry init site(s)`,
    );
    return false;
  }

  fs.writeFileSync(bundlePath, next);
  console.log(
    `  [ok] ${relPath(bundlePath)}: patched ${count} Sentry init site(s) (maxBreadcrumbs=20, data>4KB truncated)`,
  );
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  let patched = 0;
  let found = 0;

  for (const pattern of TARGETS) {
    const bundles = locateBundles({ dir: "build", pattern, platform });
    for (const bundle of bundles) {
      found++;
      if (patchOne(bundle.path, isCheck)) patched++;
    }
  }

  if (found === 0) {
    console.log("  [skip] no target bundles found");
    return;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();
