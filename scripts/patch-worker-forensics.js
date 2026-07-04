#!/usr/bin/env node
/**
 * patch-worker-forensics.js — app-server / worker 进程未捕获异常落盘取证
 *
 * 背景：审查发现 worker.js（Node 子进程 / app-server）里 Sentry 的
 * OnUncaughtException 集成配置为 exitEvenIfOtherHandlersAreRegistered:false，
 * 该进程一旦抛出未捕获异常且无其他 handler，就会 process.exit(1) 静默退出。
 * 这是“进程直接没了”的另一条可能路径（JS 层，区别于主进程 native 崩溃）。
 *
 * 主进程的 crash-forensics 只覆盖 browser 进程；worker 退出虽会触发主进程
 * child-process-gone（已落盘），但拿不到 worker 内部的 JS 异常栈。本补丁向
 * worker.js 顶部注入一段取证钩子，在 worker 抛异常时把栈落盘到同一
 * CodexForensics 目录。
 *
 * 关键：用 process.on("uncaughtExceptionMonitor", ...) 而非 "uncaughtException"。
 * 前者是 Node 专为“只观测”设计的事件——监听器执行后，原有的 uncaughtException
 * 处理（含 Sentry 的 handler 与退出决策）照常进行，绝不改变行为。unhandledRejection
 * 同样只记录不干预。
 *
 * V2 新增：worker 线程内存自采样（纯观测）。
 * 背景：2026-07-04 15:03 崩溃取证显示主进程 RSS 冲到 2.9GB 时主线程 JS 堆
 * 仅 30-50MB、截图计数为 0，dump 中 640/415/320MB 巨型私有块位于 V8 堆保留区
 * ——矛盾指向跑在主进程里的 worker 线程（worker 的 V8 堆/ArrayBuffer 计入
 * RSS 但不计入主线程 heapUsed）。worker_threads 里 process.memoryUsage() 的
 * heapUsed/external/arrayBuffers 是本线程 isolate 的，正好让每个 worker 自报家门：
 *   - 每 30s 一条 wmem 采样（heapUsed/heapTotal/external/arrayBuffers/v8malloc/rss）
 *   - 本线程 heapUsed+external >= 500MB 视为高水位：加密到 5s 采样，
 *     并限频落一份 V8 堆空间分布（old_space/large_object_space/...），
 *     直接看出是普通对象堆积还是大字符串/大数组
 *
 * V3 新增：任务归因（纯观测）。
 * 背景：22:22 崩溃锁定 worker#1 大字符串暴涨后，收紧 diff 上限 8MB 仍在
 * 22:49 复崩（堆 1.2GB 时 V8 共享指针压缩 cage 分配失败主动 OOM crash，
 * 系统内存充足）——说明另有任务在搬大数据，需要精确到"哪个 RPC 任务"。
 * worker 的 RPC 走 parentPort 消息：入向 {type:'worker-request',
 * request:{id,method}}，出向 {type:'worker-response', response:{id,method}}。
 * 注入体在业务代码注册前：
 *   - 给 parentPort 加一个额外 message listener（EventEmitter 多 listener
 *     互不影响）记录 in-flight 任务与最近任务环形缓冲；
 *   - 包一层 parentPort.postMessage 观测 worker-response 以清除 in-flight
 *     （apply 透传所有参数，不改行为）。
 * 每条 wmem 带 task=[进行中任务]，高水位再补 recent=[最近完成/开始的任务]。
 * 堆暴涨瞬间即可从日志读出正在执行的任务名，一锤定音。
 *
 * 全部逻辑包在 try/catch 内，任何失败都不影响 worker 本身。
 * 写入前用 acorn 校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-worker-forensics.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-worker-forensics.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const MARKER = "__CODEX_WORKER_FORENSICS_V3__";
const LEGACY_MARKERS = [
  "__CODEX_WORKER_FORENSICS__",
  "__CODEX_WORKER_FORENSICS_V2__",
];

// 注入体：自包含 CJS，不依赖 electron（worker/utility 进程无 app）。
function __codexWorkerForensics() {
  try {
    var fs = require("node:fs");
    var path = require("node:path");
    var os = require("node:os");
    var baseDir =
      process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
    var dir = path.join(baseDir, "CodexForensics");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
    var logFile = path.join(
      dir,
      "forensics-" + new Date().toISOString().slice(0, 10) + ".log",
    );

    // 标注进程角色：worker_threads 主线程 / 工作线程 / 独立进程
    var role = "worker";
    try {
      var wt = require("node:worker_threads");
      role = wt.isMainThread ? "worker-main" : "worker-thread#" + wt.threadId;
    } catch (e) {}

    function write(line) {
      try {
        fs.appendFileSync(
          logFile,
          "[" +
            new Date().toISOString() +
            "] [" +
            role +
            " pid=" +
            process.pid +
            "] " +
            line +
            "\n",
        );
      } catch (e) {}
    }

    write("worker boot argv=" + JSON.stringify(process.argv.slice(1)));

    // uncaughtExceptionMonitor：只观测，不改变默认/Sentry 退出决策
    process.on("uncaughtExceptionMonitor", function (err) {
      write(
        "WORKER uncaughtException: " +
          (err && err.stack ? err.stack : String(err)),
      );
    });
    // unhandledRejection：只记录，不干预
    process.on("unhandledRejection", function (reason) {
      write(
        "WORKER unhandledRejection: " +
          (reason && reason.stack ? reason.stack : String(reason)),
      );
    });

    // ===== V3：任务归因（纯观测，不改业务） =====
    // 记录 in-flight 的 worker-request 与最近完成的任务；堆暴涨时直接
    // 从 wmem 行读出正在执行的任务名。
    var inflight = {}; // id -> {m: method, t: startedAt}
    var inflightCount = 0;
    var recent = []; // 最近完成/取消的任务 ["method:1234ms", ...]
    function recordRecent(entry) {
      try {
        recent.push(entry);
        if (recent.length > 8) recent.shift();
      } catch (e) {}
    }
    function taskSummary() {
      try {
        var now = Date.now();
        var parts = [];
        for (var k in inflight) {
          var it = inflight[k];
          parts.push(it.m + "(" + Math.round((now - it.t) / 1000) + "s)");
          if (parts.length >= 5) break;
        }
        return parts.length ? parts.join(",") : "-";
      } catch (e) {
        return "?";
      }
    }
    try {
      var wt2 = require("node:worker_threads");
      var pp = wt2.parentPort;
      if (pp && !wt2.isMainThread) {
        // 入向：记录 worker-request / worker-request-cancel
        pp.on("message", function (e) {
          try {
            if (!e || typeof e !== "object") return;
            if (e.type === "worker-request" && e.request && e.request.id != null) {
              var m = String(e.request.method || "?").slice(0, 48);
              if (inflightCount < 64) {
                if (!(e.request.id in inflight)) inflightCount++;
                inflight[e.request.id] = { m: m, t: Date.now() };
              }
            } else if (e.type === "worker-request-cancel" && e.id != null) {
              var it = inflight[e.id];
              if (it) {
                recordRecent(it.m + ":cancelled");
                delete inflight[e.id];
                inflightCount--;
              }
            }
          } catch (e2) {}
        });
        // 出向：worker-response 表示任务结束（apply 透传，不改行为）
        var origPost = pp.postMessage.bind(pp);
        pp.postMessage = function (msg, transfer) {
          try {
            if (
              msg &&
              typeof msg === "object" &&
              msg.type === "worker-response" &&
              msg.response &&
              msg.response.id != null
            ) {
              var it = inflight[msg.response.id];
              if (it) {
                recordRecent(it.m + ":" + (Date.now() - it.t) + "ms");
                delete inflight[msg.response.id];
                inflightCount--;
              }
            }
          } catch (e2) {}
          return arguments.length > 1
            ? origPost(msg, transfer)
            : origPost(msg);
        };
      }
    } catch (e) {}

    // ===== V2：worker 内存自采样（纯观测，不改业务） =====
    // heapUsed/external/arrayBuffers 是本线程 isolate 的，rss 是全进程的。
    var v8mod = null;
    try {
      v8mod = require("node:v8");
    } catch (e) {}

    var seq = 0;
    var NORMAL_INTERVAL = 30000;
    var FAST_INTERVAL = 5000;
    var curInterval = NORMAL_INTERVAL;
    var HIGH_BYTES = 500 * 1024 * 1024; // 本线程 heapUsed+external 高水位
    var lastSpacesAt = 0;
    var timer = null;

    function sample() {
      try {
        seq++;
        var mu = process.memoryUsage();
        var v8part = "";
        try {
          if (v8mod) {
            var hs = v8mod.getHeapStatistics();
            v8part =
              " v8totalMB=" +
              Math.round(hs.total_heap_size / 1048576) +
              " v8mallocMB=" +
              Math.round(hs.malloced_memory / 1048576);
          }
        } catch (e) {}
        var hot = mu.heapUsed + mu.external >= HIGH_BYTES;
        write(
          (hot ? "WORKER-HIGH " : "") +
            "wmem#" +
            seq +
            " heapUsedMB=" +
            Math.round(mu.heapUsed / 1048576) +
            " heapTotalMB=" +
            Math.round(mu.heapTotal / 1048576) +
            " extMB=" +
            Math.round(mu.external / 1048576) +
            " abMB=" +
            Math.round((mu.arrayBuffers || 0) / 1048576) +
            v8part +
            " rssMB=" +
            Math.round(mu.rss / 1048576) +
            " task=[" +
            taskSummary() +
            "]",
        );

        // 高水位时限频补一份堆空间分布：old_space 涨=对象堆积，
        // large_object_space 涨=大字符串/大数组；同时落最近完成的任务
        if (hot && v8mod && Date.now() - lastSpacesAt > 60000) {
          lastSpacesAt = Date.now();
          try {
            var sp = v8mod
              .getHeapSpaceStatistics()
              .filter(function (s) {
                return s.space_used_size > 16 * 1048576;
              })
              .map(function (s) {
                return (
                  s.space_name +
                  "=" +
                  Math.round(s.space_used_size / 1048576) +
                  "MB"
                );
              })
              .join(" ");
            write("WORKER-HEAP-SPACES " + (sp || "(all<16MB)"));
          } catch (e) {}
          try {
            write("WORKER-RECENT-TASKS [" + recent.join(", ") + "]");
          } catch (e) {}
        }

        // 动态采样频率：高水位 5s，回落 30s
        var want = hot ? FAST_INTERVAL : NORMAL_INTERVAL;
        if (want !== curInterval) {
          curInterval = want;
          try {
            clearInterval(timer);
          } catch (e) {}
          timer = setInterval(sample, curInterval);
          try {
            timer.unref && timer.unref();
          } catch (e) {}
        }
      } catch (e) {}
    }

    timer = setInterval(sample, curInterval);
    try {
      timer.unref && timer.unref();
    } catch (e) {}
    try {
      sample(); // 启动基线
    } catch (e) {}
  } catch (e) {
    try {
      require("node:fs").appendFileSync(
        require("node:path").join(
          require("node:os").tmpdir(),
          "codex-forensics-fatal.log",
        ),
        "worker-forensics: " + String((e && e.stack) || e) + "\n",
      );
    } catch (e2) {}
  }
}

const INJECT =
  "/*" + MARKER + "*/;(" + __codexWorkerForensics.toString() + ")();\n";

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

function startsWithWorkerInjection(code) {
  const trimmed = code.trimStart();
  if (trimmed.startsWith("/*" + MARKER + "*/;(")) return true;
  for (const legacy of LEGACY_MARKERS) {
    if (trimmed.startsWith("/*" + legacy + "*/;(")) return true;
  }
  return trimmed.startsWith("(function __codexWorkerForensics()");
}

// 去掉文件顶部的旧版注入（按 AST 第一条语句切除，避免手工数括号）
function stripLeadingWorkerInjection(code) {
  if (!startsWithWorkerInjection(code)) return { code, stripped: false };
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    try {
      ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    } catch {
      return { code, stripped: false };
    }
  }
  const first =
    ast.body && ast.body.find((node) => node.type !== "EmptyStatement");
  if (!first || first.end == null) return { code, stripped: false };
  return { code: code.slice(first.end).replace(/^\s*\n?/, ""), stripped: true };
}

function stripKnownWorkerInjections(code) {
  let next = code;
  let stripped = false;
  while (true) {
    const before = next;
    const result = stripLeadingWorkerInjection(next);
    next = result.code;
    stripped = stripped || result.stripped;
    if (next === before) break;
  }
  return { code: next, stripped };
}

// 确认是运行 Sentry OnUncaughtException 的 worker（避免误注入其它同名文件）
function isSentryWorker(code) {
  return (
    code.includes("worker_threads") &&
    code.includes("we are exiting the process now")
  );
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

    if (code.includes(MARKER)) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched (V3)`);
      continue;
    }

    // 去掉旧版注入后再判断/重注入，实现 V1/V2 -> V3 升级
    const { code: baseCode, stripped } = stripKnownWorkerInjections(code);

    if (!isSentryWorker(baseCode)) {
      console.log(
        `  [!] ${relPath(bundle.path)}: not the Sentry worker, skipping`,
      );
      continue;
    }

    const next = INJECT + baseCode;

    if (!parseOk(next)) {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-inject parse failed, aborting`,
      );
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would ${stripped ? "upgrade" : "inject"} worker forensics (+${INJECT.length} bytes)`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, next);
    console.log(
      `  [ok] ${relPath(bundle.path)}: ${stripped ? "upgraded" : "injected"} worker forensics`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();
