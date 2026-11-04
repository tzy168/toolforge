// 白名单构建与校验共用的那点逻辑。
//
// 单独抽出来，是因为 build-shared-deps（构建）和 verify-whitelist（验收）必须用同一份装法：
// 两边各写一遍，迟早会出现「构建时装进去的」和「验收时检查的」不是同一棵树，
// 那种校验比没有校验更糟——它给出的是假的安全感。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
export const CACHE = path.join(ROOT, ".pack-cache");
export const WHITELIST_FILE = path.join(ROOT, "shared-deps.json");
export const VENDOR_DIR = path.join(ROOT, "vendor", "shared-deps");
export const ROOT_DIR = ROOT;

/** 白名单总量上限，与 core/deps.ts 的 MAX_TOTAL_BYTES 保持一致 */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 传递依赖包数上限，与 core/deps.ts 的 MAX_TRANSITIVE 保持一致 */
export const MAX_TRANSITIVE = 60;

export function readWhitelist() {
  const raw = fs.readFileSync(WHITELIST_FILE, "utf8").replace(/^\uFEFF/, "");
  const json = JSON.parse(raw);
  return { packages: json.packages || {}, comment: json.$comment || [] };
}

/** 包名 → 精确版本，不接受范围。白名单自己先得守住这条，否则「可复现」是空话 */
export function assertExactVersions(packages) {
  const bad = [];
  for (const [name, v] of Object.entries(packages)) {
    if (typeof v !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)) bad.push(name + "@" + String(v));
  }
  if (bad.length) throw new Error("白名单里有非精确版本：" + bad.join(", "));
}

export function findNpmCli() {
  const candidates = [
    process.env.npm_execpath && path.basename(process.env.npm_execpath) === "npm-cli.js" ? process.env.npm_execpath : null,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js") : null,
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("找不到 npm-cli.js：这一步需要完整安装的 Node（含 npm）");
}

/**
 * 把一批依赖装进缓存目录并返回 node_modules 路径。
 *
 * 缓存键只由「包名→版本」决定：改了声明就重装，没改就复用。这正是可复现性该有的样子——
 * 同样是这份声明，装出来的就该是同一棵树。
 */
export function ensureInstalled(packages) {
  assertExactVersions(packages);
  const key = crypto.createHash("sha1").update(JSON.stringify(packages)).digest("hex").slice(0, 12);
  const dir = path.join(CACHE, "shared-" + key);
  const modules = path.join(dir, "node_modules");
  if (fs.existsSync(modules)) return modules;

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "toolforge-shared-deps", version: "0.0.0", private: true, dependencies: packages }, null, 2),
    "utf8"
  );
  // ignore-scripts 是硬要求：这条链路上任何 postinstall 都是未经审核的代码执行
  fs.writeFileSync(
    path.join(dir, ".npmrc"),
    ["ignore-scripts=true", "audit=false", "fund=false", "save-exact=true", ""].join("\n"),
    "utf8"
  );

  const npmCli = findNpmCli();
  const res = spawnSync(
    process.execPath,
    [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--loglevel=error"],
    { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 300000 }
  );
  if (res.status !== 0) {
    throw new Error("npm install 失败（code=" + res.status + "）：" + String(res.stderr || res.stdout || "").slice(-600));
  }
  if (!fs.existsSync(modules)) throw new Error("npm 报告成功但没有 node_modules：" + dir);
  return modules;
}

export function dirSize(dir) {
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* 并发删除，忽略 */
        }
      }
    }
  };
  walk(dir);
  return bytes;
}

/** node_modules 下的一级包名，@scope 展开一层 */
export function topLevel(nodeModules) {
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === ".bin") continue;
    if (e.name.startsWith("@")) {
      try {
        for (const sub of fs.readdirSync(path.join(nodeModules, e.name), { withFileTypes: true })) {
          if (sub.isDirectory()) out.push(e.name + "/" + sub.name);
        }
      } catch {
        /* 忽略 */
      }
    } else {
      out.push(e.name);
    }
  }
  return out.sort();
}

/** 递归统计：总字节、包数、原生二进制清单、每个一级包的体积 */
export function inspectTree(root) {
  const stats = { bytes: 0, packages: 0, nativeFiles: [], perPackage: {} };
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(full, "package.json"))) stats.packages += 1;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* 忽略 */
        }
        stats.bytes += size;
        if (e.name.endsWith(".node")) stats.nativeFiles.push(full);
      }
    }
  };
  walk(root, 0);
  for (const name of topLevel(root)) stats.perPackage[name] = dirSize(path.join(root, name));
  return stats;
}

export function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * 在某个 node 运行时里 require 一个包，返回 {ok, detail}。
 *
 * runner 可能是系统 node，也可能是 Electron 的二进制（ELECTRON_RUN_AS_NODE=1）。
 * 后者是打包后的真实运行时，必须单独验：Node 22 支持 require() 加载 ESM，Node 20.18 不支持，
 * 同一条要求在两边可以给出相反结论。
 */
export function requireIn(runner, name, cwd, opts) {
  const electron = Boolean(opts && opts.electron);
  const script =
    "try{require(" + JSON.stringify(name) + ");process.stdout.write(\"OK\")}" +
    "catch(e){process.stdout.write(\"FAIL \" + (e.code || e.name || \"ERR\"))}";
  const env = { ...process.env };
  if (electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
    env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  }
  const res = spawnSync(runner, ["-e", script], { cwd, encoding: "utf8", windowsHide: true, timeout: 60000, env });
  const text = String(res.stdout || "").trim();
  if (text.startsWith("OK")) return { ok: true, detail: "OK" };
  return { ok: false, detail: (text || String(res.stderr || "").trim() || "status=" + res.status).slice(0, 120) };
}

export function findElectronExe() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  const p = path.join(ROOT, "node_modules", "electron", "dist", exe);
  return fs.existsSync(p) ? p : null;
}

export function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + "MB";
}
