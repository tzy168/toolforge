// 白名单候选检查器：给一个包名，按五条标准逐条给结论，而不是靠印象拍板。
//
// 用法：
//   node scripts/curate-shared-deps.mjs zod yaml papaparse
//   node scripts/curate-shared-deps.mjs uuid@14 marked@18 --probe
//
// 默认就会真的把包装进缓存、做双运行时 require。理由：元数据判断不出 ESM-only——
// uuid@14 与 marked@18 在缩写的 packument 里看起来就是普通 CJS 包，只有 require 一次才暴露。
// 想看纯元数据的快表加 --no-probe，但那种结论不足以作为放进白名单的依据。
//
// 这个脚本不改任何文件：结论给人看，写不写进 shared-deps.json 是人来决定的。
import fs from "node:fs";
import path from "node:path";
import { ensureInstalled, requireIn, findElectronExe, fmtMB, inspectTree, readPackageJson, VENDOR_DIR, ROOT_DIR } from "./whitelist-lib.mjs";

const args = process.argv.slice(2);
const PROBE = !args.includes("--no-probe");
const specs = args.filter((a) => !a.startsWith("--"));
if (!specs.length) {
  console.log("用法：node scripts/curate-shared-deps.mjs <pkg[@version]> [...] [--probe]");
  process.exit(2);
}

function cmpVersion(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return a.localeCompare(b);
}

async function meta(name, version) {
  const res = await fetch("https://registry.npmjs.org/" + encodeURIComponent(name), {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  const all = json.versions || {};
  let v = version || (json["dist-tags"] && json["dist-tags"].latest);
  // 支持只写主版本（uuid@14）：解析成该主版本下的最高版本，省得人去翻 registry。
  // 但绝不接受范围符号（^ ~ *），那和白名单「精确版本」的前提相冲。
  if (v && !all[v] && /^\d+$/.test(v)) {
    const majors = Object.keys(all).filter((x) => x.split(".")[0] === v);
    if (majors.length) v = majors.sort(cmpVersion)[majors.length - 1];
  }
  const pkg = all[v];
  if (!pkg) throw new Error("版本 " + v + " 不存在");
  return { version: v, pkg };
}

const rows = [];
for (const spec of specs) {
  const at = spec.lastIndexOf("@");
  const hasVersion = at > 0;
  const name = hasVersion ? spec.slice(0, at) : spec;
  const wantVersion = hasVersion ? spec.slice(at + 1) : null;
  const row = { name, version: wantVersion, reasons: [], verdict: "可加入" };
  try {
    const m = await meta(name, wantVersion);
    row.version = m.version;
    const p = m.pkg;
    const s = p.scripts || {};
    const post = ["install", "preinstall", "postinstall"].filter((k) => s[k]);
    if (post.length) {
      row.reasons.push("带安装脚本：" + post.join(", ") + "（会在安装期执行代码）");
      row.verdict = "拒绝";
    }
    if (p.deprecated) {
      row.reasons.push("已废弃：" + String(p.deprecated).slice(0, 70));
      row.verdict = "拒绝";
    }
    if (p.gypfile || p.binary || p.os || p.cpu) {
      row.reasons.push("疑似原生模块（gypfile/binary/os/cpu），进不了沙箱");
      row.verdict = "拒绝";
    }
    const deps = Object.keys(p.dependencies || {}).length;
    row.deps = deps;
    row.size = p.dist && p.dist.unpackedSize ? p.dist.unpackedSize : null;
    if (deps > 10) {
      row.reasons.push("直接依赖 " + deps + " 个，闭包要单独核");
      if (row.verdict === "可加入") row.verdict = "需人工判断";
    }
    if (p.type === "module") {
      row.reasons.push("ESM-only：打包态 Node 20.18 无法 require，必须实测");
      if (row.verdict === "可加入") row.verdict = "需人工判断";
    }
    if (row.size && row.size > 20 * 1024 * 1024) {
      row.reasons.push("单包 " + fmtMB(row.size) + "，超过工具依赖总量上限");
      row.verdict = "拒绝";
    }
  } catch (e) {
    row.reasons.push("取元数据失败：" + e.message);
    row.verdict = "拒绝";
  }
  rows.push(row);
}

// --probe：真装一次，双运行时 require
let probed = null;
if (!PROBE) {
  console.log("");
  console.log("  ! 已按 --no-probe 跳过 require 实测：ESM-only 这类问题查不出来，结论不足以直接采用");
}
if (PROBE) {
  const ok = rows.filter((r) => r.verdict !== "拒绝");
  if (ok.length) {
    const deps = {};
    for (const r of ok) deps[r.name] = r.version;
    console.log("探测安装：" + Object.keys(deps).length + " 个包…");
    const modules = ensureInstalled(deps);
    const stats = inspectTree(modules);
    const electron = findElectronExe();
    probed = { modules, stats, electron };
    for (const r of ok) {
      const sys = requireIn(process.execPath, r.name, modules, { electron: false });
      const ele = electron ? requireIn(electron, r.name, modules, { electron: true }) : { ok: false, detail: "没有 Electron 运行时" };
      r.sys = sys;
      r.ele = ele;
      if (!sys.ok) {
        r.reasons.push("系统 Node require 失败：" + sys.detail);
        r.verdict = "拒绝";
      } else if (!ele.ok) {
        r.reasons.push("Electron 内置 Node require 失败：" + ele.detail);
        r.verdict = "拒绝";
      }
      const pkg = readPackageJson(path.join(modules, r.name));
      r.realVersion = pkg && pkg.version;
    }
  }
}

console.log("");
for (const r of rows) {
  const size = r.size ? fmtMB(r.size) : "未知";
  console.log(r.verdict.padEnd(8) + r.name + "@" + r.version + "  依赖 " + (r.deps == null ? "?" : r.deps) + " 个 / 包体 " + size);
  for (const why of r.reasons) console.log("          - " + why);
  if (r.sys || r.ele) {
    console.log("          require：Node " + (r.sys && r.sys.ok ? "OK" : "FAIL") + " / Electron " + (r.ele && r.ele.ok ? "OK" : "FAIL"));
  }
}

if (probed) {
  console.log("");
  console.log("探测安装总计：" + probed.stats.packages + " 个包 / " + fmtMB(probed.stats.bytes) + (probed.electron ? "" : "（缺 Electron 运行时，打包态未验）"));
}

const pass = rows.filter((r) => r.verdict === "可加入");
// 白名单是共享一份总量预算的：单个包看着不大，加进去可能把别人挤出去
if (pass.length) {
  const vendorModules = path.join(VENDOR_DIR, "node_modules");
  if (fs.existsSync(vendorModules)) {
    const used = inspectTree(vendorModules).bytes;
    const add = pass.reduce((n, r) => n + (r.size || 0), 0);
    console.log("");
    console.log("总量预算：已用 " + fmtMB(used) + " / 上限 20.00MB，本次新增约 " + fmtMB(add));
    if (used + add > 20 * 1024 * 1024) console.log("  ! 会超上限：要么去掉一些包，要么先在 shared-deps.json 里腾位置");
  }
}
if (pass.length) {
  console.log("");
  console.log("可加入的（粘进 shared-deps.json 的 packages，然后跑 verify-whitelist 复核）：");
  for (const r of pass) console.log("    " + JSON.stringify(r.name) + ": " + JSON.stringify(r.version) + ",");
}

const manual = rows.filter((r) => r.verdict === "需人工判断");
if (manual.length) console.log("\n需人工判断 " + manual.length + " 个：上面列了原因，不接受就换成 CJS 版本的旧主版本再测。");
const rejected = rows.filter((r) => r.verdict === "拒绝");
if (rejected.length) console.log("\n拒绝 " + rejected.length + " 个：原因见上，不要放进白名单。");
