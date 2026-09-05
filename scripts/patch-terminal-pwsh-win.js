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
function findMatchingBrace(source, openBraceIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("Failed to find matching brace.");
}
function replaceFunction(source, startNeedle, replacementHeader) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing function marker: ${startNeedle}`);
  const open = source.indexOf("{", start);
  const close = findMatchingBrace(source, open);
  const end = close + 1;
  return {
    source: `${source.slice(0, start)}${replacementHeader}${source.slice(end)}`,
    replaced: source.slice(start, end),
  };
}
function applyPatch(source) {
  if (source.includes("__codex_terminal_pwsh_windows_patch")) return source;
  const resolveNeedle =
    'resolveShell(){return process.platform==="win32"?process.env.COMSPEC||"cmd.exe":process.env.SHELL||"/bin/bash"}';
  const resolveReplacement =
    'resolveShell(){if(process.platform!=="win32")return process.env.SHELL||"/bin/bash";const t=process.env.WINDIR??"C:\\\\Windows",e=process.env.ProgramFiles??"C:\\\\Program Files",r=process.env["ProgramFiles(x86)"]??"C:\\\\Program Files (x86)",i=process.env.LOCALAPPDATA??`${process.env.HOMEDRIVE??"C:"}\\\\Users\\\\Public\\\\AppData\\\\Local`;const o=[ne.join(e,"PowerShell","7","pwsh.exe"),ne.join(e,"PowerShell","7-preview","pwsh.exe"),ne.join(e,"PowerShell","7","pwsh.exe"),ne.join(r,"PowerShell","7","pwsh.exe"),ne.join(r,"PowerShell","7-preview","pwsh.exe"),ne.join(r,"PowerShell","7","pwsh.exe"),ne.join(i,"Microsoft","WindowsApps","pwsh.exe")];for(const s of o)if(s&&ve.existsSync(s))return s;try{const s=Dn.spawnSync("where",["pwsh.exe"],{encoding:"utf8",timeout:1e3}),u=(s.stdout?.split(/\\r?\\n/)??[]).map(v=>v.trim()).filter(Boolean);for(const a of u)if(ve.existsSync(a))return a}catch{}try{const s=Dn.spawnSync("where",["powershell.exe"],{encoding:"utf8",timeout:1e3}),u=(s.stdout?.split(/\\r?\\n/)??[]).map(v=>v.trim()).filter(Boolean);for(const a of u)if(ve.existsSync(a))return a}catch{}return ne.join(t,"System32","WindowsPowerShell","v1.0","powershell.exe")}';
  source = source.replace(resolveNeedle, resolveReplacement);
  const createReplacement =
    'async create(e,n){const r=n.sessionId??$t.randomUUID(),i=this.resolveRequestedCwd(n.cwd),a=this.resolveLocalCwd(i),o=this.resolveShell(),s=this.terminalCommand&&this.terminalCommand.length>0?this.terminalCommand:[o],c=typeof s==="string"?s.trim().split(/\\s+/).filter(Boolean):Array.isArray(s)?s:[String(s)],l=c.length>0?c:[String(s)],u=typeof l[0]==="string"?l[0].toLowerCase():"",[m,...p]=process.platform==="win32"&&(u==="cmd"||u==="cmd.exe"||u==="pwsh"||u==="pwsh.exe"||u==="powershell"||u==="powershell.exe")?[o,...l.slice(1)]:l,d=this.buildTerminalEnv(),f=[m,...p].join(" ");try{const{spawn:h}=await import("node-pty"),_=h(m,p,{cols:n.cols??80,rows:n.rows??24,cwd:i,env:d,shell:f}),v={id:r,pty:_,owner:e,ownerId:e.id,buffer:"",cwd:i,shell:f,attached:!1,conversationId:n.conversationId,preserveOnOwnerDestroy:n.preserveOnOwnerDestroy??!1};return this.sessions.set(r,v),n.conversationId&&this.sessionsByConversation.set(String(n.conversationId),r),this.bindSessionEvents(v),i!==a&&this.seedShellCwd(v,i),this.flushInit(v),this.sendAttached(v),r}catch(c){return this.sendError(e,r,String(c)),null}}';
  const replaced = replaceFunction(source, "async create(e,n){", createReplacement);
  source = replaced.source;
  return `${source}/*__codex_terminal_pwsh_windows_patch*/`;
}
function main() {
  const bundlePath = locateBundle();
  const source = fs.readFileSync(bundlePath, "utf8");
  const patched = applyPatch(source);
  if (patched === source) return;
  fs.writeFileSync(bundlePath, patched);
}
main();
