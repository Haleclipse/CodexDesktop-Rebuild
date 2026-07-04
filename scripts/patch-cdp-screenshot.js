#!/usr/bin/env node
/**
 * patch-cdp-screenshot.js — 驯服 browser-use 的 CDP 全页截图，防主进程内存风暴
 *
 * 背景：崩溃取证（minidump + 内存采样）证实主进程崩溃源于 native 内存压力：
 * RSS 周期性冲到 3GB+，崩溃瞬间 commit 2.6GB、最大单块 634MB，chrome.dll 内部
 * 分配失败后近空指针读写（两次 dump 位置漂移：读 0x2 / 写 0x0）。
 *
 * 元凶是 agent browser-use 的 CDP 截图管线：`Page.captureScreenshot` 带
 * `captureBeyondViewport:true` + 整页 clip + PNG——整页光栅化位图 → PNG 编码
 * → base64 经 CDP JSON 回传主进程 → 解码副本，单次几百 MB，agent 每步操作
 * 都截一张。
 *
 * 修复：在主进程 CDP 统一转发点（sendDebuggerCommand → debugger.sendCommand）
 * 注入参数守卫，仅拦截 captureBeyondViewport===true 的整页截图请求：
 *   1. captureBeyondViewport → false，删除整页 clip（只截可视区，
 *      OpenAI/Anthropic 官方 computer-use 均为视口截图，agent 可滚动后再截）
 *   2. format 未指定或为 png 时改为 jpeg quality=60（buffer 与 base64 体积
 *      缩一个数量级）
 * 视口/小区域截图（annotation、comment、剪贴板等）不受任何影响。
 *
 * 上游 waitForCaptureSurface 仍按原始参数等待整页 surface，等不到时 1 秒
 * (TJ=1e3) 超时后照常继续，功能无损，最坏多 1 秒延迟。
 *
 * 写入前用 acorn 对整份文件做语法校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-cdp-screenshot.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-cdp-screenshot.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const MARKER = "__codexCdpGuard";

// 守卫函数：挂在 globalThis 上，避免与压缩后的模块作用域变量冲突。
// 只动整页截图请求，其余参数原样透传；任何异常都回退为原参数。
const GUARD_DEF =
  ";globalThis." +
  MARKER +
  "=function(m,p){try{if(m===`Page.captureScreenshot`&&p&&typeof p==`object`&&p.captureBeyondViewport===!0){var q={};for(var k in p)q[k]=p[k];q.captureBeyondViewport=!1;delete q.clip;(q.format==null||q.format===`png`)&&(q.format=`jpeg`,q.quality=60);return q}}catch(e){}return p};\n";

// CDP 统一转发点（sendDebuggerCommand 内部）——main bundle 中唯一
const ANCHOR =
  "return await hY(e.webContents.debugger.sendCommand(t,n,i),this.cdpCommandTimeoutMs,";
const REPLACEMENT =
  "return await hY(e.webContents.debugger.sendCommand(t,globalThis." +
  MARKER +
  "(t,n),i),this.cdpCommandTimeoutMs,";

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
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes(MARKER)) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }

    // 锚点可能因不同平台的压缩变量名不同而变化，用正则放宽标识符
    let next = null;
    if (code.includes(ANCHOR)) {
      next = GUARD_DEF + code.replace(ANCHOR, REPLACEMENT);
    } else {
      const re =
        /return await ([\w$]+)\((\w+)\.webContents\.debugger\.sendCommand\((\w+),(\w+),(\w+)\),this\.cdpCommandTimeoutMs,/;
      const m = code.match(re);
      if (m) {
        const rep = `return await ${m[1]}(${m[2]}.webContents.debugger.sendCommand(${m[3]},globalThis.${MARKER}(${m[3]},${m[4]}),${m[5]}),this.cdpCommandTimeoutMs,`;
        next = GUARD_DEF + code.replace(re, rep);
      }
    }

    if (next == null) {
      console.log(
        `  [!] ${relPath(bundle.path)}: CDP forward anchor not found, skipping`,
      );
      continue;
    }

    if (!parseOk(next)) {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-inject parse failed, aborting`,
      );
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would patch CDP screenshot guard`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, next);
    console.log(
      `  [ok] ${relPath(bundle.path)}: CDP fullpage screenshot -> viewport jpeg q60`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();
