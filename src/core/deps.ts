// 三方依赖的安装器：宿主代装，工具只能「声明」，不能「决定装什么」。
//
// 为什么要有这一层，而不是让工具自己 npm install：
//   1) 工具的代码跑在 --permission 沙箱里，连 child_process 都 require 不到；
//   2) 安装本身是「执行任意代码」最方便的一扇门（postinstall 就是标准入口）；
//   3) 装进来的东西必须可复现、可审计——范围版本半年后装出来是另一份代码。
//
// 所以流程固定成：校验声明 → 在工具目录下暂存安装 → 实测校验 → 原子替换。
// 全程不跑 install script（--ignore-scripts），原生模块（.node）直接拒绝。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dirs, readJsonFile, toolDir } from './paths.js';
import { bundledNpmCli, sharedDepsRoot, whitelistFile } from './appPaths.js';
import type { DepRecord, DepSource, InstalledDep, Tool, ToolDeps } from '../types.js';

/**
 * 装进来的 node_modules 总大小上限。
 *
 * 原来定在 5MB，实际用起来才发现它卡的不是安全、是可用性：zod 4（5.9MB）、
 * date-fns（10.4MB）这类「零依赖、纯 JS、几千万人在用」的包全被挡在门外，
 * 而真正该拦的东西（一个包拖进两百个包）由包数上限管着。
 * 20MB 足够放下任何单文件库，又不至于让一件工具的依赖比应用本身还大。
 */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 传递依赖包数上限：一个包拖进两百个包的情况不该出现在工具沙箱里 */
export const MAX_TRANSITIVE = 60;
/** 单次安装超时 */
const INSTALL_TIMEOUT = 180000;

export interface DepInstallReport {
  ok: boolean;
  /** 一件无依赖的工具也会返回 ok，此时 skipped=true */
  skipped: boolean;
  manager: string;
  /** 这份依赖从哪来：白名单复制 或 联网安装 */
  source: DepSource;
  installed: InstalledDep[];
  totalBytes: number;
  transitiveCount: number;
  ms: number;
  error?: string;
}

export function depSpecifiers(deps: ToolDeps = {}): string[] {
  return Object.entries(deps).map(([name, version]) => `${name}@${version}`);
}

export function describeDeps(deps: ToolDeps = {}): string {
  const list = depSpecifiers(deps);
  return list.length ? `${list.length} 个三方依赖：${list.join(', ')}` : '无三方依赖';
}

/** 依赖声明是否已经按原样装好（版本对得上、目录还在） */
export function depsReady(tool: Tool): boolean {
  const deps = tool.impl.deps ?? {};
  const names = Object.keys(deps);
  if (names.length === 0) return true;
  const root = path.join(toolDir(tool.id), 'node_modules');
  if (!fs.existsSync(root)) return false;
  for (const name of names) {
    const pkgFile = path.join(root, name, 'package.json');
    if (!fs.existsSync(pkgFile)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, '')) as { version?: string };
      if (String(pkg.version ?? '') !== deps[name]) return false;
    } catch {
      return false;
    }
  }
  return true;
}

interface Discovered {
  /** 包管理器命令行：node <cli> ... 或 npm/pnpm 可执行文件 */
  cmd: string;
  baseArgs: string[];
  label: string;
  /** 需要追加的安装参数（hoisted / store 目录由调用处补齐） */
  extraArgs: string[];
}

/**
 * 找到能用的包管理器。
 *
 * 只用 npm 与 pnpm 两种，且必须能强制成 flat node_modules：
 *   - npm 默认就是扁平 hoist，实体文件全在工具目录内；
 *   - pnpm 默认把实体文件放全局 store、项目里只留符号链接，那会让沙箱
 *     `--allow-fs-read=<工具目录>` 直接读不到真身（ERR_ACCESS_DENIED），
 *     所以必须 node-linker=hoisted，并且把 store 也塞进暂存目录。
 *
 * 注意 npm_execpath 可能是 pnpm 的 cli.js（在当前是 pnpm 脚本时），
 * 所以只认文件名叫 npm-cli.js 的那条，别被环境变量带跑。
 */
function discoverManager(stageDir: string): Discovered | null {
  const node = process.execPath;
  const npmCandidates: string[] = [];
  if (process.env.npm_execpath && path.basename(process.env.npm_execpath) === 'npm-cli.js') {
    npmCandidates.push(process.env.npm_execpath);
  }
  // 打包后用户机器上没有 Node，npm 是随应用分发的。这条必须排在 exe 同级之前：
  // 找不到它就会一路退到「没有可用的包管理器」，联网安装直接报废。
  const bundled = bundledNpmCli();
  if (bundled) npmCandidates.push(bundled);
  npmCandidates.push(path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (process.env.APPDATA) {
    npmCandidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const cli of npmCandidates) {
    if (cli && fs.existsSync(cli)) {
      return { cmd: node, baseArgs: [cli], label: 'npm', extraArgs: [] };
    }
  }

  const pnpmCandidates: string[] = [];
  if (process.env.npm_execpath && path.basename(process.env.npm_execpath) === 'pnpm.cjs') {
    pnpmCandidates.push(process.env.npm_execpath);
  }
  const storeDir = path.join(stageDir, '.pnpm-store');
  for (const cli of pnpmCandidates) {
    if (fs.existsSync(cli)) {
      return {
        cmd: node,
        baseArgs: [cli],
        label: 'pnpm',
        extraArgs: ['--config.node-linker=hoisted', `--config.store-dir=${storeDir}`],
      };
    }
  }
  return null;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 宿主是 Electron 时，process.execPath 是 electron.exe，得让它按 Node 行事
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  // 装依赖不该受工具自己的权限声明影响，但 npm 的缓存/配置得能读到
  delete env.NODE_OPTIONS;
  return env;
}

function runInstall(manager: Discovered, args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(manager.cmd, [...manager.baseArgs, ...args], {
      cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ code: -1, out, err: err + `\n安装超时（${INSTALL_TIMEOUT}ms）` });
      }
    }, INSTALL_TIMEOUT);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 200_000) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 200_000) err += d.toString();
    });
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, out, err: `${err}\n${e.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

interface TreeStats {
  bytes: number;
  packages: number;
  nativeFiles: string[];
}

/** 数一数 node_modules 有多大、多少个包、有没有原生二进制 */
function inspectTree(root: string): TreeStats {
  const stats: TreeStats = { bytes: 0, packages: 0, nativeFiles: [] };
  // 嵌套 node_modules（版本冲突时才有）也要数进去，否则体积上限能被它绕开。
  // 深度兜到 8 层，纯粹防病态目录把自己绕死。
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(full, 'package.json'))) stats.packages += 1;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          stats.bytes += fs.statSync(full).size;
        } catch {
          /* 文件被并发删了，忽略 */
        }
        if (e.name.endsWith('.node')) stats.nativeFiles.push(full);
      }
    }
  };
  walk(root, 0);
  return stats;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从 lockfile 里取每个直接依赖的 SRI，用于复现校验 */
function readIntegrity(nodeModules: string, deps: ToolDeps): InstalledDep[] {
  const lock = readJson(path.join(path.dirname(nodeModules), 'package-lock.json'));
  const packages = (lock?.packages ?? null) as Record<string, { integrity?: string; version?: string }> | null;
  return Object.entries(deps).map(([name, wanted]) => {
    const pkg = readJson(path.join(nodeModules, name, 'package.json'));
    const entry = packages ? packages[`node_modules/${name}`] : undefined;
    return {
      name,
      version: String(pkg?.version ?? entry?.version ?? wanted),
      integrity: typeof entry?.integrity === 'string' ? entry.integrity : null,
    };
  });
}


/* ---------------- 依赖策略：谁能装、能不能联网 ---------------- */

export interface DepPolicy {
  /** 是否允许安装离线白名单之外的包（会联网）。默认 false */
  allowUnvettedDeps: boolean;
  /** 白名单目录（内含 node_modules）；null 表示当前形态下没有 */
  sharedDepsRoot: string | null;
  /** 白名单声明的包名 → 精确版本；读不到文件时为 {} */
  whitelist: ToolDeps;
  /** 这个开关是谁打开的：环境变量 / settings.json / 没开 */
  origin: 'env' | 'settings' | 'default';
}

/** 白名单清单文件里声明的包。界面要展示「白名单里有什么」，不该依赖 node_modules 是否已构建 */
export function whitelistVersions(): ToolDeps {
  const file = whitelistFile();
  if (!file) return {};
  try {
    const raw = readJsonFile(file) as { packages?: unknown };
    const pkgs = raw?.packages;
    if (!pkgs || typeof pkgs !== 'object') return {};
    const out: ToolDeps = {};
    for (const [k, v] of Object.entries(pkgs as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    // 清单坏了就当白名单是空的：宁可退化成「必须人工放行」，不可退化成「什么都能装」
    return {};
  }
}

/**
 * 联网装依赖的总开关。
 *
 * 默认关。开发机上没有随包白名单，关了就等于「agent 造不出带依赖的工具」，所以需要一条
 * 人工开的口子；但这条口子必须是一次显式动作，不能被某次调用顺手打开——
 * 它一旦打开，registry 上的代码就会进到本机并且被执行（跑用例）。
 *
 * 优先级：环境变量 > settings.json > 默认关。环境变量可以填 0 强行关掉，
 * 这样既能临时放行，也能在服务化部署里压过用户配置。
 */
export function readDepPolicy(): DepPolicy {
  const envRaw = (process.env.TOOLFORGE_ALLOW_NET_DEPS ?? '').trim().toLowerCase();
  let allow = false;
  let origin: DepPolicy['origin'] = 'default';
  if (envRaw === '1' || envRaw === 'true') {
    allow = true;
    origin = 'env';
  } else if (envRaw === '0' || envRaw === 'false') {
    allow = false;
    origin = 'env';
  } else {
    try {
      const s = readJsonFile(dirs.settings) as { allowUnvettedDeps?: unknown };
      if (s?.allowUnvettedDeps === true) {
        allow = true;
        origin = 'settings';
      }
    } catch {
      // settings.json 不存在或坏了：当没开。这里绝不能「读失败就放行」
    }
  }
  return { allowUnvettedDeps: allow, sharedDepsRoot: sharedDepsRoot(), whitelist: whitelistVersions(), origin };
}

export function networkDepsAllowed(): boolean {
  return readDepPolicy().allowUnvettedDeps;
}
/* ---------------- 随包分发的预装依赖：离线安装通道 ---------------- */

export interface SharedDepPlan {
  /** 白名单根目录（内含 node_modules） */
  root: string;
  /** 命中的直接依赖 */
  hits: InstalledDep[];
  /** 没命中或版本不符的包名。非空表示这条路走不通，得回落到联网安装 */
  missing: string[];
  /** 需要复制进工具目录的包名闭包（含传递依赖） */
  closure: string[];
}

function pkgVersion(dir: string): string | null {
  const pkg = readJson(path.join(dir, 'package.json'));
  const v = pkg?.version;
  return typeof v === 'string' ? v : null;
}

/**
 * 在扁平 node_modules 里按 dependencies 收集闭包。
 *
 * 只认 dependencies 与「确实存在的 optionalDependencies」。peerDependencies 不解析：
 * 在 hoisted 布局下它由白名单构建时保证，在这里猜边界只会猜错。漏装会以 require
 * 失败的形式暴露出来，那是个明确的错误，比静默复制一份残缺依赖好。
 */
function collectClosure(rootModules: string, names: string[]): { closure: string[]; missing: string[] } {
  const seen = new Set<string>();
  const missing: string[] = [];
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    const pkg = readJson(path.join(rootModules, name, 'package.json'));
    if (!pkg) {
      missing.push(name);
      continue;
    }
    seen.add(name);
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    for (const dep of Object.keys(deps)) if (!seen.has(dep)) queue.push(dep);
    const opt = (pkg.optionalDependencies ?? {}) as Record<string, string>;
    for (const dep of Object.keys(opt)) {
      if (seen.has(dep)) continue;
      // 可选依赖没随包分发是正常的；装了才需要一起搬，否则运行时会 require 到空
      if (fs.existsSync(path.join(rootModules, dep))) queue.push(dep);
    }
  }
  return { closure: [...seen].sort(), missing };
}

/** 判断这件工具的依赖能否全部由随包白名单满足。null 表示本机没有白名单目录 */
export function planSharedDeps(tool: Tool): SharedDepPlan | null {
  const deps = tool.impl.deps ?? {};
  const names = Object.keys(deps);
  if (names.length === 0) return null;
  const root = sharedDepsRoot();
  if (!root) return null;
  const modules = path.join(root, 'node_modules');

  const hits: InstalledDep[] = [];
  const missing: string[] = [];
  for (const [name, wanted] of Object.entries(deps)) {
    const got = pkgVersion(path.join(modules, name));
    if (got !== wanted) {
      missing.push(name);
      continue;
    }
    // 白名单里没有 lockfile 可查，integrity 只能是 null。这里的可信度由
    // 「进白名单时人工审过」承担，不由哈希承担——两者别混为一谈。
    hits.push({ name, version: got, integrity: null });
  }
  if (missing.length) return { root, hits, missing, closure: [] };

  const closure = collectClosure(modules, names);
  if (closure.missing.length) return { root, hits, missing: closure.missing, closure: [] };
  return { root, hits, missing: [], closure: closure.closure };
}

/**
 * 从随包白名单安装：纯文件复制，不联网、不跑任何脚本。
 *
 * 校验一条不少：版本、原生模块、体积、包数照样过一遍。「随包分发」只说明来源不同，
 * 不说明可信度不同——白名单本身要人工审，复制完还得确认磁盘上的东西没被换过。
 */
export function installSharedDeps(tool: Tool, plan: SharedDepPlan): DepInstallReport {
  const started = Date.now();
  const deps = tool.impl.deps ?? {};
  const dir = toolDir(tool.id);
  fs.mkdirSync(dir, { recursive: true });
  const stage = path.join(dir, '.deps-staging');
  fs.rmSync(stage, { recursive: true, force: true });
  const dest = path.join(stage, 'node_modules');
  fs.mkdirSync(dest, { recursive: true });
  const srcModules = path.join(plan.root, 'node_modules');

  try {
    for (const name of plan.closure) {
      const from = path.join(srcModules, name);
      const to = path.join(dest, name);
      // @scope/name 要先把 scope 目录建出来，cpSync 不管父级
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // dereference：白名单目录若是用 pnpm 装的，符号链接搬进沙箱会指向不存在的真身
      fs.cpSync(from, to, { recursive: true, dereference: true });
    }

    for (const [name, wanted] of Object.entries(deps)) {
      const got = pkgVersion(path.join(dest, name));
      if (got !== wanted) throw new Error(`随包依赖 ${name} 版本不符：声明 ${wanted}，实际 ${got ?? '缺失'}`);
    }

    const stats = inspectTree(dest);
    if (stats.nativeFiles.length) {
      throw new Error(
        `随包依赖里含原生二进制（${stats.nativeFiles.slice(0, 3).map((f) => path.basename(f)).join(', ')}），` +
          '不能进工具沙箱：请把它从白名单里拿掉'
      );
    }
    if (stats.packages > MAX_TRANSITIVE) {
      throw new Error(`随包依赖过多：${stats.packages} 个包（上限 ${MAX_TRANSITIVE}）`);
    }
    if (stats.bytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `随包依赖体积超限：${(stats.bytes / 1024 / 1024).toFixed(2)}MB（上限 ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(1)}MB）`
      );
    }

    const target = path.join(dir, 'node_modules');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(dest, target);

    // 记一份 package.json：让 node 的模块解析在工具目录有个明确边界
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `toolforge-tool-${tool.id}`, version: '0.0.0', private: true, dependencies: deps }, null, 2),
      'utf8'
    );

    fs.rmSync(stage, { recursive: true, force: true });
    return {
      ok: true,
      skipped: false,
      manager: 'shared',
      source: 'whitelist',
      installed: plan.hits,
      totalBytes: stats.bytes,
      transitiveCount: stats.packages,
      ms: Date.now() - started,
    };
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 装一件工具声明的依赖。已经装好且版本对得上时直接跳过。
 *
 * 失败一律抛错（调用方决定是降级成「待审」还是回灌给模型），
 * 但失败前会把暂存目录清干净，不留半成品。
 */
export async function installToolDeps(tool: Tool, opts: { force?: boolean } = {}): Promise<DepInstallReport> {
  const started = Date.now();
  const deps = tool.impl.deps ?? {};
  const names = Object.keys(deps);

  if (tool.kind !== 'script') {
    throw new Error(`只有 script 类工具需要装依赖，${tool.name} 是 ${tool.kind}`);
  }
  if (names.length === 0) {
    return { ok: true, skipped: true, manager: '-', source: 'whitelist', installed: [], totalBytes: 0, transitiveCount: 0, ms: 0 };
  }
  if (!opts.force && depsReady(tool)) {
    const rec = tool.meta?.deps;
    return {
      ok: true,
      skipped: true,
      manager: rec?.manager ?? 'cached',
      source: rec?.source ?? 'whitelist',
      installed: rec?.packages ?? [],
      totalBytes: rec?.totalBytes ?? 0,
      transitiveCount: rec?.transitiveCount ?? 0,
      ms: Date.now() - started,
    };
  }

  // 白名单命中就完全不碰网络。打包后用户机器上往往没有 Node 也没有 npm，
  // 「离线可用」是普通用户唯一稳定的那条路，所以它排在联网安装之前。
  const shared = planSharedDeps(tool);
  if (shared && shared.missing.length === 0) {
    return installSharedDeps(tool, shared);
  }

  const dir = toolDir(tool.id);
  fs.mkdirSync(dir, { recursive: true });
  const stage = path.join(dir, '.deps-staging');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const cleanup = (): void => fs.rmSync(stage, { recursive: true, force: true });

  try {
    const manager = discoverManager(stage);
    if (!manager) {
      throw new Error('找不到可用的包管理器：既没有 npm-cli.js，也没有 pnpm.cjs。请确认 Node 安装完整');
    }

    // 暂存目录里自己写 package.json：不读工具目录里任何既有文件，
    // 免得 tools 目录被塞进一个带 scripts 的 project 把 --ignore-scripts 变成唯一防线
    fs.writeFileSync(
      path.join(stage, 'package.json'),
      JSON.stringify(
        { name: `toolforge-tool-${tool.id}`, version: '0.0.0', private: true, dependencies: deps },
        null,
        2
      ),
      'utf8'
    );
    // 双保险：CLI 参数 + .npmrc，任何一处被忽略都还有另一处
    fs.writeFileSync(
      path.join(stage, '.npmrc'),
      ['ignore-scripts=true', 'audit=false', 'fund=false', 'save-exact=true', 'package-lock=true', ''].join('\n'),
      'utf8'
    );

    const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--loglevel=error', ...manager.extraArgs];
    const res = await runInstall(manager, args, stage);
    if (res.code !== 0) {
      const tail = (res.err || res.out).trim().split('\n').slice(-6).join(' ');
      throw new Error(`${manager.label} install 失败（code=${res.code}）：${tail.slice(0, 600)}`);
    }

    const nodeModules = path.join(stage, 'node_modules');
    if (!fs.existsSync(nodeModules)) throw new Error(`${manager.label} 报告成功但没生成 node_modules`);

    // 实测校验：版本必须与声明完全一致。包管理器有它自己的解析逻辑，
    // 别信它的「成功」，信磁盘上的 package.json。
    for (const [name, wanted] of Object.entries(deps)) {
      const pkg = readJson(path.join(nodeModules, name, 'package.json'));
      if (!pkg) throw new Error(`装完之后找不到 ${name}（可能被 registry 解析成了别的名字）`);
      if (String(pkg.version ?? '') !== wanted) {
        throw new Error(`${name} 版本不符：声明 ${wanted}，实装 ${String(pkg.version ?? '未知')}`);
      }
    }

    const stats = inspectTree(nodeModules);
    if (stats.nativeFiles.length) {
      throw new Error(
        `依赖里含原生二进制（${stats.nativeFiles.slice(0, 3).map((f) => path.basename(f)).join(', ')}），` +
          '工具沙箱不接受原生模块：它们在 --permission 下加载行为不可控，也无法审计。请换纯 JS 实现或改走 MCP'
      );
    }
    if (stats.packages > MAX_TRANSITIVE) {
      throw new Error(`传递依赖过多：${stats.packages} 个包（上限 ${MAX_TRANSITIVE}），请换更轻的库或改走 MCP`);
    }
    if (stats.bytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `依赖体积超限：${(stats.bytes / 1024 / 1024).toFixed(2)}MB（上限 ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(1)}MB）`
      );
    }

    const installed = readIntegrity(nodeModules, deps);

    // 原子替换：先挪旧目录，再换新的。中途失败也不会留下半个 node_modules 让 require 半死不活
    const dest = path.join(dir, 'node_modules');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(nodeModules, dest);

    // package.json / lockfile 一起搬进工具目录：前者让 node 的模块解析有个明确的根，
    // 后者是复现与审计的凭证
    fs.copyFileSync(path.join(stage, 'package.json'), path.join(dir, 'package.json'));
    const lockFile = path.join(stage, 'package-lock.json');
    if (fs.existsSync(lockFile)) {
      fs.copyFileSync(lockFile, path.join(dir, 'package-lock.json'));
    }

    cleanup();
    return {
      ok: true,
      skipped: false,
      manager: manager.label,
      source: 'network',
      installed,
      totalBytes: stats.bytes,
      transitiveCount: stats.packages,
      ms: Date.now() - started,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** 把安装结果整理成落盘记录 */
export function toDepRecord(report: DepInstallReport): DepRecord {
  return {
    at: new Date().toISOString(),
    manager: report.manager,
    source: report.source,
    packages: report.installed,
    totalBytes: report.totalBytes,
    transitiveCount: report.transitiveCount,
  };
}
