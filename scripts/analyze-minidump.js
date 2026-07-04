// Minidump 解析：异常、崩溃线程、RIP 模块归属、伪栈回溯、内存分布统计
const fs = require("fs");

const file = process.argv[2];
const buf = fs.readFileSync(file);

const streamCount = buf.readUInt32LE(8);
const streamDirRva = buf.readUInt32LE(12);

const streams = {};
for (let i = 0; i < streamCount; i++) {
  const off = streamDirRva + i * 12;
  const type = buf.readUInt32LE(off);
  const size = buf.readUInt32LE(off + 4);
  const rva = buf.readUInt32LE(off + 8);
  streams[type] = { size, rva };
}
console.log(
  "streams: " +
    Object.keys(streams)
      .map((t) => t + "(" + streams[t].size + "B)")
      .join(", "),
);

// ---- ModuleListStream (4) ----
const mods = [];
if (streams[4]) {
  const { rva } = streams[4];
  const n = buf.readUInt32LE(rva);
  for (let i = 0; i < n; i++) {
    const off = rva + 4 + i * 108;
    const base = buf.readBigUInt64LE(off);
    const size = buf.readUInt32LE(off + 8);
    const nameRva = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt32LE(nameRva);
    const name = buf
      .slice(nameRva + 4, nameRva + 4 + nameLen)
      .toString("utf16le");
    mods.push({ base, size, name });
  }
}
function findMod(addr) {
  for (const m of mods) {
    if (addr >= m.base && addr < m.base + BigInt(m.size)) return m;
  }
  return null;
}
function shortName(p) {
  return p.split("\\").pop();
}

// ---- SystemInfoStream (7) ----
if (streams[7]) {
  const r = streams[7].rva;
  console.log(
    "cpu_arch=" +
      buf.readUInt16LE(r) +
      " ncpus=" +
      buf.readUInt8(r + 6) +
      " winver=" +
      buf.readUInt32LE(r + 8) +
      "." +
      buf.readUInt32LE(r + 12) +
      " build=" +
      buf.readUInt32LE(r + 16),
  );
}

// ---- MiscInfoStream (15): 进程 ID/时间 ----
if (streams[15]) {
  const r = streams[15].rva;
  const flags = buf.readUInt32LE(r + 4);
  if (flags & 1) console.log("process_id=" + buf.readUInt32LE(r + 8));
  if (flags & 2) {
    const createT = buf.readUInt32LE(r + 12);
    console.log(
      "process_create_time=" + new Date(createT * 1000).toISOString(),
    );
  }
}

// ---- ExceptionStream (6) ----
let crashTid = null;
let ctxRva = null,
  ctxSize = null;
if (streams[6]) {
  const r = streams[6].rva;
  crashTid = buf.readUInt32LE(r);
  const code = buf.readUInt32LE(r + 8);
  const addr = buf.readBigUInt64LE(r + 24);
  const nParams = buf.readUInt32LE(r + 32);
  const params = [];
  for (let i = 0; i < Math.min(nParams, 4); i++) {
    params.push(buf.readBigUInt64LE(r + 40 + i * 8));
  }
  ctxSize = buf.readUInt32LE(r + 160);
  ctxRva = buf.readUInt32LE(r + 164);
  console.log(
    "\nEXCEPTION tid=" +
      crashTid +
      " code=0x" +
      code.toString(16) +
      " addr=0x" +
      addr.toString(16) +
      " params=" +
      params.map((p) => "0x" + p.toString(16)).join(","),
  );
  // params[0]: 0=read 1=write 8=dep; params[1]=访问的地址
}

// ---- ThreadListStream (3): 找崩溃线程的栈与 context ----
let rip = null,
  rsp = null,
  stackStart = null,
  stackMem = null;
if (streams[3] && crashTid !== null) {
  const r = streams[3].rva;
  const n = buf.readUInt32LE(r);
  for (let i = 0; i < n; i++) {
    const off = r + 4 + i * 48;
    const tid = buf.readUInt32LE(off);
    if (tid !== crashTid) continue;
    stackStart = buf.readBigUInt64LE(off + 24);
    const stackSize = buf.readUInt32LE(off + 32);
    const stackRva = buf.readUInt32LE(off + 36);
    stackMem = buf.slice(stackRva, stackRva + stackSize);
    const tCtxSize = buf.readUInt32LE(off + 40);
    const tCtxRva = buf.readUInt32LE(off + 44);
    if (!ctxRva) {
      ctxRva = tCtxRva;
      ctxSize = tCtxSize;
    }
  }
}

// x64 CONTEXT: Rip@0xf8, Rsp@0x98
if (ctxRva) {
  rip = buf.readBigUInt64LE(ctxRva + 0xf8);
  rsp = buf.readBigUInt64LE(ctxRva + 0x98);
  const ripMod = findMod(rip);
  console.log(
    "RIP=0x" +
      rip.toString(16) +
      (ripMod
        ? " -> " +
          shortName(ripMod.name) +
          "+0x" +
          (rip - ripMod.base).toString(16)
        : " -> <no module>"),
  );
  console.log("RSP=0x" + rsp.toString(16));
}

// ---- 伪栈回溯：扫描栈内存中落在模块内的地址 ----
if (stackMem && stackStart !== null && rsp !== null) {
  console.log("\npseudo-stack (top 40 module hits from RSP):");
  const startOff = Number(rsp - stackStart);
  let hits = 0;
  for (
    let o = Math.max(0, startOff);
    o + 8 <= stackMem.length && hits < 40;
    o += 8
  ) {
    const v = stackMem.readBigUInt64LE(o);
    const m = findMod(v);
    if (m) {
      console.log(
        "  rsp+0x" +
          (o - startOff).toString(16).padStart(5, "0") +
          "  0x" +
          v.toString(16) +
          "  " +
          shortName(m.name) +
          "+0x" +
          (v - m.base).toString(16),
      );
      hits++;
    }
  }
}

// ---- MemoryInfoListStream (16): 虚拟内存分布统计 ----
if (streams[16]) {
  const r = streams[16].rva;
  const hdrSize = buf.readUInt32LE(r);
  const entrySize = buf.readUInt32LE(r + 4);
  const n = Number(buf.readBigUInt64LE(r + 8));
  let commitPrivate = 0n,
    commitImage = 0n,
    commitMapped = 0n,
    reserve = 0n;
  const bigPrivate = [];
  for (let i = 0; i < n; i++) {
    const off = r + hdrSize + i * entrySize;
    const base = buf.readBigUInt64LE(off);
    const size = buf.readBigUInt64LE(off + 24);
    const state = buf.readUInt32LE(off + 32);
    const type = buf.readUInt32LE(off + 40);
    if (state === 0x1000) {
      // MEM_COMMIT
      if (type === 0x20000) commitPrivate += size;
      else if (type === 0x1000000) commitImage += size;
      else if (type === 0x40000) commitMapped += size;
      if (type === 0x20000 && size >= 0x1000000n) {
        bigPrivate.push({ base, size });
      }
    } else if (state === 0x2000) {
      reserve += size;
    }
  }
  const MB = (v) => (Number(v) / 1048576).toFixed(0);
  console.log(
    "\nmemory: commit_private=" +
      MB(commitPrivate) +
      "MB commit_image=" +
      MB(commitImage) +
      "MB commit_mapped=" +
      MB(commitMapped) +
      "MB reserved=" +
      MB(reserve) +
      "MB regions=" +
      n,
  );
  bigPrivate.sort((a, b) => (b.size > a.size ? 1 : -1));
  console.log("largest private commits (>=16MB):");
  for (const bp of bigPrivate.slice(0, 15)) {
    console.log("  0x" + bp.base.toString(16) + "  " + MB(bp.size) + "MB");
  }
}

// ---- 可疑模块清单 ----
console.log("\nnon-system modules:");
for (const m of mods) {
  if (/\\Windows\\/i.test(m.name)) continue;
  console.log(
    "  " +
      shortName(m.name) +
      " @0x" +
      m.base.toString(16) +
      " (" +
      (m.size / 1048576).toFixed(1) +
      "MB)",
  );
}
