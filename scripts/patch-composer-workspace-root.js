#!/usr/bin/env node
/**
 * Post-build patch: make new local conversations honor the active workspace root.
 *
 * Upstream bundle behavior:
 *   a?.workspaceRoots ?? n.workspaceRoots ?? [`~`]
 *
 * If the composer context misses workspaceRoots, `[`~`]` is treated as a
 * projectless conversation and the app creates/uses ~/Documents/Codex.  The
 * desktop project picker already updates the active-workspace-roots query, so
 * this patch uses that query as the local-only fallback before falling back to
 * projectless.
 *
 * Usage:
 *   node scripts/patch-composer-workspace-root.js [platform]   # Apply patch
 *   node scripts/patch-composer-workspace-root.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const PATCHED_MARKER = "c===`local`?(e.get(Oi)?.data?.roots??[]).filter";

const OLD_SNIPPET =
  "E=async(n,r,i,a)=>{let o=a?.workspaceRoots??n.workspaceRoots??[`~`],s=Ks(o),c=a?.hostId??v,u=C(a),{context:f,goal:h}=await T(n,c),g=MF(f,c),E=!1,D=Dn(f.imageAttachments),O=e.get(Ok),k=er(f);try{let n=await FF({hostId:c,prompt:k,projectlessPrewarmReservation:_,workspaceRoots:o}),a=n.cwd??r,l=await AF({activeCollaborationMode:t,context:f,hostId:c,scope:e,serviceTier:y}),v=await Cg({context:f,prompt:k,workspaceRoots:n.workspaceRoots,cwd:a,hostId:c,agentMode:u.agentMode,permissionProfileId:u.permissionProfileId,serviceTier:l.serviceTier,collaborationMode:l.collaborationMode,memoryPreferences:O??void 0,workspaceKind:s?`projectless`:`project`,projectlessOutputDirectory:n.projectlessOutputDirectory,projectAssignment:n.projectAssignment})";

const NEW_SNIPPET =
  "E=async(n,r,i,a)=>{let c=a?.hostId??v,o=a?.workspaceRoots??n.workspaceRoots??(c===`local`?(e.get(Oi)?.data?.roots??[]).filter(e=>e!=null&&e!==`~`):[]);o.length===0&&(o=[`~`]);let s=Ks(o),u=C(a),{context:f,goal:h}=await T(n,c),g=MF(f,c),E=!1,D=Dn(f.imageAttachments),O=e.get(Ok),k=er(f);try{let n=await FF({hostId:c,prompt:k,projectlessPrewarmReservation:_,workspaceRoots:o}),a=n.cwd??r,l=await AF({activeCollaborationMode:t,context:f,hostId:c,scope:e,serviceTier:y}),v=await Cg({context:f,prompt:k,workspaceRoots:n.workspaceRoots,cwd:a,hostId:c,agentMode:u.agentMode,permissionProfileId:u.permissionProfileId,serviceTier:l.serviceTier,collaborationMode:l.collaborationMode,memoryPreferences:O??void 0,workspaceKind:s?`projectless`:`project`,projectlessOutputDirectory:n.projectlessOutputDirectory,projectAssignment:n.projectAssignment})";

function getPlatforms(platform) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((p) =>
    fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
  );
}

function findComposerBundles(platform) {
  const targets = [];
  for (const plat of getPlatforms(platform)) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!/^composer-.*\.js$/.test(file)) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf-8");
      if (
        source.includes("projectlessPrewarmReservation") &&
        source.includes("workspaceRoots") &&
        (source.includes(OLD_SNIPPET) || source.includes(PATCHED_MARKER))
      ) {
        targets.push({ platform: plat, path: filePath, source });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const targets = findComposerBundles(platform);
  if (targets.length === 0) {
    console.log("  [skip] No matching composer bundle found");
    return;
  }

  let patched = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    if (target.source.includes(PATCHED_MARKER)) {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }

    const count = target.source.split(OLD_SNIPPET).length - 1;
    if (count !== 1) {
      console.log(`  [!] ${label}: expected 1 patch site, found ${count}`);
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${label}: would patch local workspace fallback`);
      patched++;
      continue;
    }

    const next = target.source.replace(OLD_SNIPPET, NEW_SNIPPET);
    fs.writeFileSync(target.path, next, "utf-8");
    console.log(`  [ok] ${label}: local workspace fallback patched`);
    patched++;
  }

  if (isCheck) {
    console.log(`  [check] ${patched} composer bundle(s) would be patched`);
  } else {
    console.log(`  [done] ${patched} composer bundle(s) patched`);
  }
}

main();
