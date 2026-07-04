#!/usr/bin/env node
/**
 * patch-worker-limits.js — 给主进程 git/diff worker 线程加 V8 堆上限（保命线）
 *
 * 背景：2026-07-04 22:22 崩溃取证（V3 主进程采样 + V2 worker 采样）实锤：
 * worker-manager 创建的 worker.js 线程在执行任务时 V8 堆从 52MB 暴涨到
 * 2.8GB（large_object_space 破 1GB，即巨型字符串/数组），把整个主进程
 * commit 顶到 3GB+，最终 chrome.dll 在 native 分配失败后写空指针整崩。
 *
 * worker_threads 默认不限制堆大小，失控任务会拖死整个应用。本补丁在
 * new Worker(...) 处加 resourceLimits：
 *   - maxOldGenerationSizeMb: 1024 —— 老生代上限 1GB。正常观测基线为
 *     52MB、任务高峰几百 MB，1GB 足够正常任务；失控时 worker 以
 *     ERR_WORKER_OUT_OF_MEMORY 终止，业务侧 worker-manager 已有
 *     error/exit 监听与懒重建逻辑（ensureWorker），应用本体不受影响。
 *   - maxYoungGenerationSizeMb: 128 —— 新生代宽松上限。
 *
 * 2026-07-04 22:49 复崩后从 1536 降到 1024：当时 worker 堆到 1189MB
 * 时进程先因 V8 共享指针压缩 cage（同进程全部 isolate 共享 4GB 保留
 * 地址空间）分配失败而主动 OOM crash，1536 的优雅上限来不及触发。
 * resourceLimits 只在 GC 检查点核对，必须显著低于 cage 崩溃线才有
 * 机会先优雅 OOM；1024 仍是正常基线（52MB）的 20 倍。
 *
 * 只动 worker-manager 的 ensureWorker 构造点（锚点唯一）；
 * child-process-snapshot 等短命 worker 不动。
 *
 * 幂等：构造点已含 resourceLimits 即跳过。写入前 acorn 校验。
 *
 * Usage:
 *   node scripts/patch-worker-limits.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-worker-limits.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const LIMITS = "resourceLimits:{maxOldGenerationSizeMb:1024,maxYoungGenerationSizeMb:128}";
// 已注入的旧上限（用于降级/升级替换）
const STALE_LIMITS = [
  "resourceLimits:{maxOldGenerationSizeMb:1536,maxYoungGenerationSizeMb:128}",
];

// ensureWorker(){...new X.Worker(i,{name:this.id,workerData:l})...}
const CTOR_RE =
  /new ([\w$]+)\.Worker\(([\w$]+),\{name:this\.id,workerData:([\w$]+)\}\)/;

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

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBundles({
    dir: "build",
    pattern: /^main-.*\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] main bundle not found");
    return;
  }

  let patched = 0;
  for (const bundle of bundles) {
    let code = fs.readFileSync(bundle.path, "utf-8");

    // 旧上限值升级：直接替换常量串
    let upgraded = false;
    for (const stale of STALE_LIMITS) {
      if (code.includes(stale)) {
        code = code.split(stale).join(LIMITS);
        upgraded = true;
      }
    }

    // 幂等：worker 构造点已带最新 resourceLimits
    if (code.includes(LIMITS)) {
      if (upgraded) {
        if (!parseOk(code)) {
          console.log(
            `  [x] ${relPath(bundle.path)}: post-upgrade parse failed, aborting`,
          );
          continue;
        }
        if (isCheck) {
          console.log(
            `  [?] ${relPath(bundle.path)}: would upgrade resourceLimits to old-gen 1024MB`,
          );
          continue;
        }
        fs.writeFileSync(bundle.path, code);
        console.log(
          `  [ok] ${relPath(bundle.path)}: resourceLimits upgraded (old-gen 1024MB)`,
        );
        patched++;
      } else {
        console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      }
      continue;
    }

    const matches = code.match(new RegExp(CTOR_RE.source, "g")) || [];
    if (matches.length !== 1) {
      console.log(
        `  [!] ${relPath(bundle.path)}: expected exactly 1 worker ctor anchor, found ${matches.length}, skipping`,
      );
      continue;
    }

    const next = code.replace(
      CTOR_RE,
      (_, x, file, data) =>
        `new ${x}.Worker(${file},{name:this.id,workerData:${data},${LIMITS}})`,
    );

    if (!parseOk(next)) {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-patch parse failed, aborting`,
      );
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would add worker resourceLimits (old-gen 1024MB)`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, next);
    console.log(
      `  [ok] ${relPath(bundle.path)}: worker resourceLimits added (old-gen 1024MB)`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();
