#!/usr/bin/env node
/**
 * patch-diff-limits.js — 收紧 git diff 单命令输出上限 32MB -> 8MB（治本缓解）
 *
 * 背景：2026-07-04 22:22 崩溃取证实锤 worker.js 在执行 diff 类任务时
 * V8 堆暴涨到 2.8GB（large_object_space 破 1GB）。代码审查发现：
 *   - git 执行器 $ 支持 maxOutputBytes，超限即 kill 并报 outputLimitExceeded，
 *     上游统一映射为 diff-too-large 错误（业务已有该错误的处理与 UI 文案）；
 *   - diff 封装 b2 的兜底上限 A1=32MB，且最多 8 路并发（F1=8）拉不同文件
 *     的 diff，每路结果同时持有 Uint8Array buffer + 解码后 string 双副本，
 *     再叠加 queryClient 的短期缓存 —— 32MB 上限下瞬时驻留可达数百 MB，
 *     GC 追不上时滚雪球，最终 native OOM 整崩。
 *
 * 修复：A1 32MB -> 8MB。正常代码 review 不会看 8MB 以上的单文件 diff，
 * 超限文件会走 diff-too-large 分支被跳过/提示，不再全量入内存。
 * 不改 I1 的 64MB 总量上限（j1）、cat-file 的 5MB（k1）、turn-diff 的 1MB。
 *
 * 锚点：`k1=5*1024*1024,A1=32*1024*1024,j1=64*1024*1024`（bundle 内唯一）。
 * 幂等：已是 A1=8*1024*1024 则跳过。写入前 acorn 校验。
 *
 * Usage:
 *   node scripts/patch-diff-limits.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-diff-limits.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const ANCHOR_OLD = "k1=5*1024*1024,A1=32*1024*1024,j1=64*1024*1024";
const ANCHOR_NEW = "k1=5*1024*1024,A1=8*1024*1024,j1=64*1024*1024";

function parseOk(code) {
  try {
    acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
    return true;
  } catch {
    try {
      acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
      return true;
    } catch {
      return false;
    }
  }
}

function count(haystack, needle) {
  let c = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    c++;
    i += needle.length;
  }
  return c;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBundles({
    dir: "build",
    pattern: /^worker\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] worker.js not found");
    return;
  }

  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes(ANCHOR_NEW)) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }

    const n = count(code, ANCHOR_OLD);
    if (n !== 1) {
      console.log(
        `  [!] ${relPath(bundle.path)}: expected exactly 1 anchor, found ${n}, skipping`,
      );
      continue;
    }

    const next = code.replace(ANCHOR_OLD, ANCHOR_NEW);

    if (!parseOk(next)) {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-patch parse failed, aborting`,
      );
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would tighten diff output limit 32MB -> 8MB`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, next);
    console.log(
      `  [ok] ${relPath(bundle.path)}: diff output limit tightened 32MB -> 8MB`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();
