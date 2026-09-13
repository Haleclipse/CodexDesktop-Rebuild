const fs = require("fs");
const path = require("path");
const BUNDLE_RE = /^main(-[^.]+)?\.js$/;
function locateBundle() {
  const buildDir = path.join(__dirname, "..", "src", ".vite", "build");
  const files = fs.readdirSync(buildDir).filter((file) => BUNDLE_RE.test(file));
  if (!files.length) throw new Error("No main*.js bundle found under src/.vite/build");
  const main = files.find((file) => file !== "main.js") || files[0];
  return path.join(buildDir, main);
}
function applyPatch(source) {
  if (source.includes("__codex_open_targets_win_patch")) return source;
  source = source.replace(
    'const fS=vt("open-in-targets"),Yi=process.platform==="darwin",',
    'const fS=vt("open-in-targets"),Yi=process.platform==="darwin",__codexOpenTargetsIsWin=process.platform==="win32",',
  );
  const targetMapStart =
    "let Lh=null;const yce=mS.map(({id:t,label:e,icon:n})=>({id:t,label:e,icon:n}));";
  if (!source.includes(targetMapStart)) {
    throw new Error("Unable to find open target map marker in bundle.");
  }
  const winTargets = `function __codexOpenTargetWinFromEnv(t,...e){const n=process.env[t];return n?ne.join(n,...e):null}function __codexOpenTargetWinFind(...t){for(const e of t){const n=Array.isArray(e)?e:[e];for(const r of n){if(!r)continue;if(ve.existsSync(r))return r}}return null}function __codexOpenTargetWinWhere(t){try{const n=Dn.spawnSync("where",[t],{encoding:"utf8",timeout:1e3}),r=(n.stdout?.split(/\\r?\\n/).map(e=>e.trim()).filter(Boolean))||[];for(const e of r)if(__codexOpenTargetWinFind(e))return e}catch{}return null}function __codexOpenTargetWinCodeArgs(t,e){if(e&&typeof e.line=="number"){const n=typeof e.column=="number"?e.column:1;return["-g",t+":"+e.line+":"+n]}return["-g",t]}function __codexOpenTargetWinExplorerArgs(t){return["/select,",ne.normalize(t)]}const __codexOpenTargetsWin=[{id:"vscode",label:"VS Code",icon:"apps/vscode.png",detect:()=>__codexOpenTargetWinFind(__codexOpenTargetWinFromEnv("LOCALAPPDATA","Programs","Microsoft VS Code","bin","code.cmd"),__codexOpenTargetWinFromEnv("LOCALAPPDATA","Programs","Microsoft VS Code","Code.exe"),__codexOpenTargetWinFromEnv("ProgramFiles","Microsoft VS Code","bin","code.cmd"),__codexOpenTargetWinFromEnv("ProgramFiles","Microsoft VS Code","Code.exe"),__codexOpenTargetWinFromEnv("ProgramFiles(x86)","Microsoft VS Code","bin","code.cmd"),__codexOpenTargetWinFromEnv("ProgramFiles(x86)","Microsoft VS Code","Code.exe"),__codexOpenTargetWinWhere("code.cmd"),__codexOpenTargetWinWhere("code"),__codexOpenTargetWinWhere("Code.exe")),args:(t,e)=>__codexOpenTargetWinCodeArgs(t,e)},{id:"vscodeInsiders",label:"VS Code Insiders",icon:"apps/vscode-insiders.png",detect:()=>__codexOpenTargetWinFind(__codexOpenTargetWinFromEnv("LOCALAPPDATA","Programs","Microsoft VS Code Insiders","bin","code-insiders.cmd"),__codexOpenTargetWinFromEnv("LOCALAPPDATA","Programs","Microsoft VS Code Insiders","Code - Insiders.exe"),__codexOpenTargetWinFromEnv("ProgramFiles","Microsoft VS Code Insiders","bin","code-insiders.cmd"),__codexOpenTargetWinFromEnv("ProgramFiles","Microsoft VS Code Insiders","Code - Insiders.exe"),__codexOpenTargetWinFromEnv("ProgramFiles(x86)","Microsoft VS Code Insiders","bin","code-insiders.cmd"),__codexOpenTargetWinFromEnv("ProgramFiles(x86)","Microsoft VS Code Insiders","Code - Insiders.exe"),__codexOpenTargetWinWhere("code-insiders.cmd"),__codexOpenTargetWinWhere("code-insiders"),__codexOpenTargetWinWhere("Code - Insiders.exe")),args:(t,e)=>__codexOpenTargetWinCodeArgs(t,e)},{id:"cursor",label:"Cursor",icon:"apps/cursor.png",detect:()=>__codexOpenTargetWinFind(__codexOpenTargetWinFromEnv("LOCALAPPDATA","Programs","Cursor","Cursor.exe"),__codexOpenTargetWinFromEnv("ProgramFiles","Cursor","Cursor.exe"),__codexOpenTargetWinFromEnv("ProgramFiles(x86)","Cursor","Cursor.exe"),__codexOpenTargetWinWhere("cursor"),__codexOpenTargetWinWhere("cursor.cmd"),__codexOpenTargetWinWhere("Cursor.exe")),args:(t,e)=>__codexOpenTargetWinCodeArgs(t,e)},{id:"windsurf",label:"Windsurf",icon:"apps/windsurf.png",detect:()=>__codexOpenTargetWinFind(__codexOpenTargetWinFromEnv("LOCALAPPDATA","Programs","Windsurf","Windsurf.exe"),__codexOpenTargetWinFromEnv("ProgramFiles","Windsurf","Windsurf.exe"),__codexOpenTargetWinFromEnv("ProgramFiles(x86)","Windsurf","Windsurf.exe"),__codexOpenTargetWinWhere("windsurf"),__codexOpenTargetWinWhere("windsurf.cmd"),__codexOpenTargetWinWhere("Windsurf.exe")),args:(t,e)=>__codexOpenTargetWinCodeArgs(t,e)},{id:"finder",label:"File Manager",icon:"apps/finder.png",detect:()=>__codexOpenTargetWinFind(__codexOpenTargetWinWhere("explorer"),__codexOpenTargetWinWhere("explorer.exe"),__codexOpenTargetWinWhere("explorer.com"),"C:\\\\Windows\\\\explorer.exe"),args:t=>__codexOpenTargetWinExplorerArgs(t)}];let Lh=null;const __codexOpenTargets=Yi?mS:__codexOpenTargetsIsWin?__codexOpenTargetsWin:[],yce=__codexOpenTargets.map(({id:t,label:e,icon:n})=>({id:t,label:e,icon:n}));`;
  source = source.replace(targetMapStart, winTargets);
  source = source.replace(
    'async function kO(){if(!Yi)return[];if(Lh)return Lh;const t=[];for(const e of mS)try{e.detect()&&t.push(e.id)}catch(n){fS().error(`Failed to detect open target "${e.id}" (${xe(n)})`)}return Lh=t,t}',
    'async function kO(){if(!Yi&&!__codexOpenTargetsIsWin)return[];if(Lh)return Lh;const t=[];for(const e of __codexOpenTargets)try{e.detect()&&t.push(e.id)}catch(n){fS().error(`Failed to detect open target "${e.id}" (${xe(n)})`)}return Lh=t,t}',
  );
  source = source.replace(
    'async function Tce(t,e,n){if(!Yi)throw new Error("Opening external editors is only supported on macOS");',
    'async function Tce(t,e,n){if(!Yi&&!__codexOpenTargetsIsWin)throw new Error("Opening external editors is only supported on macOS and Windows");',
  );
  source = source.replace(
    "const r=mS.find(a=>a.id===t);",
    "const r=__codexOpenTargets.find(a=>a.id===t);",
  );
  return `${source}/*__codex_open_targets_win_patch*/`;
}
function main() {
  const bundlePath = locateBundle();
  const source = fs.readFileSync(bundlePath, "utf8");
  const patched = applyPatch(source);
  if (patched === source) return;
  fs.writeFileSync(bundlePath, patched);
}
main();
