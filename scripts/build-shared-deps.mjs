// 把 shared-deps.json 落成 vendor/shared-deps/node_modules。
//
// 为什么要落一份到仓库外的 vendor：开发态（pnpm start / node dist/bin/cli.js）也需要白名单。
// 没有它，agent 在开发机上造带依赖的工具一律被判 L3 并落 pending，
// 于是「白名单这条路走得通」这件事在开发期根本验证不了——那正是上一轮的处境。
//
// 产物同时也是 build-desktop.mjs 的输入：打包时直接复制，不再重复装一遍（省时间，也保证一致）。
//
// 跑法：node scripts/build-shared-deps.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import {
  VENDOR_DIR,
  ensureInstalled,
  inspectTree,
  fmtMB,
  readWhitelist,
  MAX_TOTAL_BYTES,
  MAX_TRANSITIVE,
} from "./whitelist-lib.mjs";

const CHECK_ONLY = process.argv.includes("--check");

const { packages } = readWhitelist();
const names = Object.keys(packages);
if (!names.length) {
  console.error("shared-deps.json 里没有任何包");
  process.exit(1);
}

console.log("准备离线白名单：" + names.length + " 个包");
const modules = ensureInstalled(packages);
const stats = inspectTree(modules);

const rows = Object.entries(packages)
  .map(([name, version]) => ({ name, version, bytes: stats.perPackage[name] || 0 }))
  .sort((a, b) => b.bytes - a.bytes);

for (const r of rows) console.log("  " + r.name.padEnd(28) + r.version.padEnd(10) + fmtMB(r.bytes));
console.log("  合计 " + fmtMB(stats.bytes) + " / " + stats.packages + " 个包（含传递依赖）");

const problems = [];
if (stats.nativeFiles.length) problems.push("含原生二进制：" + stats.nativeFiles.slice(0, 3).join(", "));
if (stats.packages > MAX_TRANSITIVE) problems.push("包数 " + stats.packages + " 超过上限 " + MAX_TRANSITIVE);
if (stats.bytes > MAX_TOTAL_BYTES) problems.push("体积 " + fmtMB(stats.bytes) + " 超过上限 " + fmtMB(MAX_TOTAL_BYTES));
if (problems.length) {
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log("\n--check：未写入 vendor/");
  process.exit(0);
}

// 先写暂存再整体换入：中途失败不会留下半棵 node_modules 让 require 半死不活
const stage = VENDOR_DIR + ".staging";
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
// dereference：缓存目录若是 pnpm 装的，符号链接搬出去会指向一个不存在的 store
fs.cpSync(modules, path.join(stage, "node_modules"), { recursive: true, dereference: true });
fs.copyFileSync("shared-deps.json", path.join(stage, "shared-deps.json"));
fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
fs.renameSync(stage, VENDOR_DIR);

console.log("\n完成：" + VENDOR_DIR);
console.log("  开发态启动后 appPaths.sharedDepsRoot() 会命中这里，白名单通道立刻可用");
