#!/usr/bin/env node
/**
 * Post-build patch: read [proxy] from Codex config.toml and apply it app-wide.
 *
 * Supported config:
 *   [proxy]
 *   enabled = true
 *   server = "http://127.0.0.1:7890"
 *   bypass = "localhost,127.0.0.1,<local>"
 *
 * Optional env override:
 *   CODEX_PROXY_CONFIG_PATH=C:\path\to\config.toml
 *
 * The injected code runs in bootstrap.js before app.whenReady(), so
 * Electron command-line proxy switches are applied early. It also exports
 * HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY for Node and child
 * processes that inherit process.env.
 */
const fs = require("fs");
const path = require("path");

const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "Codex proxy config patch";

const INJECTED = String.raw`
/* Codex proxy config patch */
(function(){
  function stripQuotes(v){
    v=String(v==null?"":v).trim();
    if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) return v.slice(1,-1);
    return v;
  }
  function parseBool(v){
    v=stripQuotes(v).toLowerCase();
    return v==="true"||v==="1"||v==="yes"||v==="on";
  }
  function stripTomlComment(raw){
    var quote=null, escaped=false;
    for(var i=0;i<raw.length;i++){
      var ch=raw[i];
      if(escaped){ escaped=false; continue; }
      if(ch==="\\"&&quote){ escaped=true; continue; }
      if((ch==="\""||ch==="\'")&&!quote){ quote=ch; continue; }
      if(ch===quote){ quote=null; continue; }
      if(ch==="#"&&!quote) return raw.slice(0,i);
    }
    return raw;
  }
  function parseProxyToml(text){
    var inProxy=false,out={};
    for(var raw of String(text||"").split(/\r?\n/)){
      var line=stripTomlComment(raw).trim();
      if(!line) continue;
      var sec=line.match(/^\[([^\]]+)\]$/);
      if(sec){inProxy=sec[1].trim()==="proxy";continue}
      if(!inProxy) continue;
      var m=line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if(!m) continue;
      out[m[1]]=stripQuotes(m[2].replace(/,\s*$/,""));
    }
    return out;
  }
  function codexHome(){
    if(process.env.CODEX_HOME&&process.env.CODEX_HOME.trim()) return process.env.CODEX_HOME.trim();
    var os=require("node:os"), path=require("node:path");
    return path.join(os.homedir(),".codex");
  }
  function loadProxyConfig(){
    var fs=require("node:fs"), path=require("node:path");
    var cfgPath=(process.env.CODEX_PROXY_CONFIG_PATH&&process.env.CODEX_PROXY_CONFIG_PATH.trim())||path.join(codexHome(),"config.toml");
    if(!fs.existsSync(cfgPath)) return null;
    var cfg=parseProxyToml(fs.readFileSync(cfgPath,"utf8"));
    if(!parseBool(cfg.enabled)) return null;
    var server=cfg.server||cfg.proxy||cfg.url||cfg.all_proxy||cfg.https_proxy||cfg.http_proxy;
    if(!server) return null;
    return {
      server:String(server).trim(),
      bypass:String(cfg.bypass||cfg.no_proxy||cfg.noProxy||"").trim()
    };
  }
  try{
    var cfg=loadProxyConfig();
    if(!cfg) return;
    process.env.HTTP_PROXY=process.env.HTTP_PROXY||cfg.server;
    process.env.HTTPS_PROXY=process.env.HTTPS_PROXY||cfg.server;
    process.env.ALL_PROXY=process.env.ALL_PROXY||cfg.server;
    process.env.http_proxy=process.env.http_proxy||cfg.server;
    process.env.https_proxy=process.env.https_proxy||cfg.server;
    process.env.all_proxy=process.env.all_proxy||cfg.server;
    if(cfg.bypass){
      process.env.NO_PROXY=process.env.NO_PROXY||cfg.bypass;
      process.env.no_proxy=process.env.no_proxy||cfg.bypass;
    }
    var electron=require("electron");
    electron.app.commandLine.appendSwitch("proxy-server",cfg.server);
    if(cfg.bypass) electron.app.commandLine.appendSwitch("proxy-bypass-list",cfg.bypass);
    electron.app.once("ready",function(){
      try{
        electron.session.defaultSession.setProxy({
          proxyRules: cfg.server,
          proxyBypassRules: cfg.bypass
        }).catch(function(e){ console.warn("[Codex Proxy] setProxy failed:",e); });
      }catch(e){ console.warn("[Codex Proxy] session proxy failed:",e); }
    });
    console.log("[Codex Proxy] enabled:",cfg.server,cfg.bypass?("bypass="+cfg.bypass):"");
  }catch(e){ console.warn("[Codex Proxy] config failed:",e); }
})();
`.trim();

function buildDirsForPlatform(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p)),
      );

  const dirs = [];
  for (const plat of platforms) {
    for (const rel of [
      [".vite", "build"],
      ["src", ".vite", "build"],
    ]) {
      const dir = path.join(SRC_DIR, plat, ...rel);
      if (fs.existsSync(dir)) dirs.push({ platform: plat, dir });
    }
  }

  // Flat prepared src/ fallback.
  for (const rel of [
    [".vite", "build"],
    ["src", ".vite", "build"],
  ]) {
    const dir = path.join(SRC_DIR, ...rel);
    if (fs.existsSync(dir)) dirs.push({ platform: "legacy", dir });
  }

  return dirs;
}

function locateBootstraps(platform) {
  const targets = [];
  const seen = new Set();
  for (const { platform: plat, dir } of buildDirsForPlatform(platform)) {
    const file = path.join(dir, "bootstrap.js");
    if (!fs.existsSync(file)) continue;
    const real = path.resolve(file);
    if (seen.has(real)) continue;
    seen.add(real);
    targets.push({ platform: plat, path: file });
  }

  // Fallback for upstream layout changes. Keep it conservative:
  // bootstrap.js is the Electron entrypoint, and this patch is idempotent.
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "app.asar.unpacked") continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name === "bootstrap.js") {
        const real = path.resolve(full);
        if (seen.has(real)) continue;
        seen.add(real);
        targets.push({ platform: platform || "auto", path: full });
      }
    }
  }
  if (targets.length === 0) {
    const fallbackRoot = platform ? path.join(SRC_DIR, platform) : SRC_DIR;
    walk(fallbackRoot);
  }

  return targets;
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    const start = source.indexOf("/* " + MARKER + " */");
    const end = source.indexOf("})();", start);

    // If we see the marker but can't find a well-formed injected block,
    // treat this as a mismatch so callers can log/handle the anomaly.
    if (start === -1 || end === -1) {
      return { code: source, status: "no-match" };
    }

    const blockEnd = end + "})();".length;
    const current = source.slice(start, blockEnd);

    if (current === INJECTED) {
      return { code: source, status: "already" };
    }

    return {
      code: `${source.slice(0, start)}${INJECTED}${source.slice(blockEnd)}`,
      status: "updated",
    };
  }

  const electronRequire = /require\((["'`])electron\1\)/.exec(source);
  if (electronRequire) {
    const semicolon = source.indexOf(";", electronRequire.index);
    if (semicolon !== -1) {
      const insertAt = semicolon + 1;
      return {
        code: `${source.slice(0, insertAt)}${INJECTED}\n${source.slice(insertAt)}`,
        status: "patched",
      };
    }
  }

  const legacyNeedle = "var a=`desktop.intelLaunchWarning.message`";
  const legacyIdx = source.indexOf(legacyNeedle);
  if (legacyIdx === -1) {
    return { code: source, status: "no-match" };
  }

  return {
    code: `${source.slice(0, legacyIdx)}${INJECTED}\n${source.slice(legacyIdx)}`,
    status: "patched",
  };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateBootstraps(platform);
  if (targets.length === 0) {
    console.log("[ok] No bootstrap.js found; skipping proxy config patch");
    return;
  }

  let patchedCount = 0;
  for (const target of targets) {
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchSource(source);

    if (result.status === "already") {
      console.log("   [ok] Proxy config patch already injected");
      continue;
    }
    if (result.status === "no-match") {
      console.log("   [!] bootstrap injection point not found");
      continue;
    }

    patchedCount++;
    if (isCheck) {
      console.log("   [?] Would inject proxy config bootstrap");
      continue;
    }

    fs.writeFileSync(target.path, result.code, "utf8");
    console.log(result.status === "updated"
      ? "   [ok] Proxy config bootstrap updated"
      : "   [ok] Proxy config bootstrap injected");
  }

  if (isCheck && patchedCount > 0) {
    console.log(`\n=> Total: ${patchedCount} patchable bootstrap file(s)`);
  }
}

main();
