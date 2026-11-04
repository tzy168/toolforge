// 白名单验收：把「能不能进 shared-deps.json」拆成五条可执行断言。
//
// 这个脚本存在的理由：白名单不是「挑几个常用的库」那么简单，它决定了一件工具在用户机器上
// 到底能不能跑起来。上一轮实测就踩到过——uuid@14 / marked@18 / nanoid@6 / he@2 在开发机
// （Node 22）上 require 正常，在打包态（Electron 内置 Node 20.18.3）上全是 ERR_REQUIRE_ESM。
// 只按元数据审，这种错会一路带到用户手里。
//
// 五条标准：
//   1) 精确版本（可复现）
//   2) registry 上没有 install / preinstall / postinstall（不执行安装期代码）
//   3) 不是废弃包、不含原生二进制（gypfile / binary / os / cpu）
//   4) 落盘后：无 .node、闭包包数 ≤ 60、总量 ≤ 20MB
//   5) require 在系统 Node 与 Electron 内置 Node 下都成功
//
// 跑法：node scripts/verify-whitelist.mjs [--no-registry]
import fs from "node:fs";
import path from "node:path";
import {
  VENDOR_DIR,
  ensureInstalled,
  inspectTree,
  fmtMB,
  readWhitelist,
  readPackageJson,
  requireIn,
  findElectronExe,
  assertExactVersions,
  MAX_TOTAL_BYTES,
  MAX_TRANSITIVE,
} from "./whitelist-lib.mjs";

const OFFLINE = process.argv.includes("--no-registry");
const failures = [];
const warnings = [];

function fail(msg) {
  failures.push(msg);
  console.log("  ✗ " + msg);
}

const { packages } = readWhitelist();
const names = Object.keys(packages).sort();
console.log("白名单：" + names.length + " 个包");

// ---- 1) 结构：精确版本 ----
console.log("\n[1/5] 精确版本");
try {
  assertExactVersions(packages);
  console.log("  ✓ 全部为精确版本");
} catch (e) {
  fail(e.message);
}

// ---- 2) + 3) registry 元数据 ----
console.log("\n[2/5] registry 元数据：无安装脚本 / 未废弃 / 非原生");
if (OFFLINE) {
  warnings.push("跳过了 registry 检查（--no-registry）：安装脚本与废弃状态未验证");
  console.log("  ! 已按参数跳过");
} else {
  for (const name of names) {
    const version = packages[name];
    try {
      const res = await fetch("https://registry.npmjs.org/" + encodeURIComponent(name), {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        fail(name + " 取元数据失败：HTTP " + res.status);
        continue;
      }
      const meta = await res.json();
      const pkg = meta.versions && meta.versions[version];
      if (!pkg) {
        fail(name + "@" + version + " 在 registry 上不存在（版本写错，或已被撤包）");
        continue;
      }
      const s = pkg.scripts || {};
      const post = ["install", "preinstall", "postinstall"].filter((k) => s[k]);
      if (post.length) fail(name + "@" + version + " 带了安装脚本：" + post.join(", "));
      if (pkg.deprecated) fail(name + "@" + version + " 已被标记废弃：" + String(pkg.deprecated).slice(0, 80));
      if (pkg.gypfile || pkg.binary || pkg.os || pkg.cpu) fail(name + "@" + version + " 疑似原生模块（gypfile/binary/os/cpu）");
      if (pkg.type === "module") warnings.push(name + "@" + version + " 是 ESM-only：能否 require 取决于第 5 条实测结果");
    } catch (e) {
      fail(name + " 取元数据异常：" + e.message);
    }
  }
  if (!failures.length) console.log("  ✓ " + names.length + " 个包全部通过元数据检查");
}

// ---- 4) 落盘检查 ----
console.log("\n[4/5] 落盘检查：无原生二进制 / 包数 / 体积");
const modules = ensureInstalled(packages);
const stats = inspectTree(modules);
if (stats.nativeFiles.length) fail("含原生二进制：" + stats.nativeFiles.slice(0, 3).map((f) => path.basename(f)).join(", "));
if (stats.packages > MAX_TRANSITIVE) fail("包数 " + stats.packages + " 超过上限 " + MAX_TRANSITIVE);
if (stats.bytes > MAX_TOTAL_BYTES) fail("体积 " + fmtMB(stats.bytes) + " 超过上限 " + fmtMB(MAX_TOTAL_BYTES));
for (const name of names) {
  const p = readPackageJson(path.join(modules, name));
  if (!p) fail(name + " 装完之后磁盘上找不到");
  else if (String(p.version) !== packages[name]) fail(name + " 版本不符：声明 " + packages[name] + "，实装 " + p.version);
}
console.log("  ✓ 落盘统计：" + stats.packages + " 个包 / " + fmtMB(stats.bytes));

// ---- 5) 双运行时 require ----
console.log("\n[5/5] require 实测：系统 Node " + process.versions.node + " + Electron 内置 Node");
const electron = findElectronExe();
if (!electron) {
  warnings.push("没找到 Electron 运行时（node_modules/electron/dist），打包态那条没验");
  console.log("  ! 没找到 Electron 运行时，只验系统 Node");
}
const rows = [];
for (const name of names) {
  const sys = requireIn(process.execPath, name, modules, { electron: false });
  const ele = electron ? requireIn(electron, name, modules, { electron: true }) : { ok: false, detail: "未测试" };
  rows.push({ name, version: packages[name], sys, ele });
  if (!sys.ok) fail(name + " 在系统 Node 下 require 失败：" + sys.detail);
  if (electron && !ele.ok) fail(name + " 在 Electron 内置 Node 下 require 失败：" + ele.detail);
}
console.log("  " + "包".padEnd(28) + "版本".padEnd(10) + "Node" + "  Electron");
for (const r of rows) {
  const mark = (x) => (x.ok ? "OK" : "FAIL");
  console.log("  " + r.name.padEnd(28) + r.version.padEnd(10) + mark(r.sys).padEnd(6) + mark(r.ele));
}

// ---- vendor 一致性 ----
console.log("\n[附加] vendor/shared-deps 一致性");
const vendorModules = path.join(VENDOR_DIR, "node_modules");
if (!fs.existsSync(vendorModules)) {
  warnings.push("vendor/shared-deps 还没构建：开发态不会有白名单，跑 node scripts/build-shared-deps.mjs");
  console.log("  ! " + VENDOR_DIR + " 不存在");
} else {
  const missing = names.filter((n) => !fs.existsSync(path.join(vendorModules, n, "package.json")));
  if (missing.length) fail("vendor 里缺包：" + missing.join(", ") + "（重跑 build-shared-deps）");
  else console.log("  ✓ vendor 与清单一致（" + names.length + " 个直接依赖）");
}

// ---- 汇总 ----
console.log("");
for (const w of warnings) console.log("  ! " + w);
if (failures.length) {
  console.log("\n失败 " + failures.length + " 项：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("\n全部通过。" + warnings.length + " 条提醒。");
