// 应用自身的位置：开发态与打包态的统一入口。
//
// 两种形态的目录形状不一样：
//   开发（pnpm start）: <repo>/dist/src/core          + <repo>/vendor/shared-deps
//   打包（双击 exe）  : <install>/resources/app/dist/src/core
//                       <install>/resources/shared-deps
//
// 但两者有一个共同点：从 dist/src/core 往上三级都在「应用根」（含 package.json 的那层）。
// 所以 appRootDir 一个公式通吃，差别只在于随包资源要多试几个候选路径。
//
// 为什么不塞进 paths.ts：那边管的是用户数据（~/.toolforge），这里管的是程序自身。
// 混在一起最容易产生的误解是「安装包能覆盖用户数据」——它们必须彻底分开。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface ElectronProc {
  resourcesPath?: string;
  defaultApp?: boolean;
}

function proc(): NodeJS.Process & ElectronProc {
  return process as NodeJS.Process & ElectronProc;
}

/**
 * 是否运行在已打包的应用里（双击 exe 启动）。
 *
 * 不能只看 resourcesPath：`electron .` 从源码目录启动时它也有值。
 * defaultApp 为 true 才是「开发态」的可靠标志——这个判错会让程序去翻不存在的
 * 随包资源，然后静默退化成「找不到包管理器」。
 */
export function isPackaged(): boolean {
  const p = proc();
  return Boolean(p.resourcesPath) && p.defaultApp !== true;
}

/** 应用根：含 package.json 的那层。开发态是仓库根，打包态是 resources/app */
export function appRootDir(): string {
  return path.resolve(HERE, '..', '..', '..');
}

/**
 * Electron 的 resources 目录。
 *
 * GUI 主进程里 process.resourcesPath 一定有值；但在 ELECTRON_RUN_AS_NODE 探针
 * 这类场景下它可能不存在，所以再从 exe 位置推一次（打包后 exe 与 resources 同级）。
 */
export function resourcesDir(): string | null {
  const p = proc();
  if (p.resourcesPath && fs.existsSync(p.resourcesPath)) return p.resourcesPath;
  const guess = path.join(path.dirname(process.execPath), 'resources');
  return fs.existsSync(guess) ? guess : null;
}

/**
 * 随包分发的预装依赖根目录（内含 node_modules），没有则返回 null。
 *
 * 这是打包形态下的离线兜底：用户机器上既没有 Node 也没有 npm，
 * 「联网现装」这条路对普通用户基本不可用，所以白名单是必需项而不是优化项。
 */
export function sharedDepsRoot(): string | null {
  const candidates: string[] = [];
  // 显式指定优先：自建部署、离线环境、自动化测试都需要一个不依赖
  // 「仓库或安装包长什么样」的覆盖口
  if (process.env.TOOLFORGE_SHARED_DEPS) candidates.push(process.env.TOOLFORGE_SHARED_DEPS);
  const res = resourcesDir();
  if (res) candidates.push(path.join(res, 'shared-deps'));
  candidates.push(path.join(appRootDir(), 'shared-deps'));
  candidates.push(path.join(appRootDir(), 'vendor', 'shared-deps'));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node_modules'))) return dir;
  }
  return null;
}

/**
 * 白名单清单文件（包名 → 精确版本）。
 *
 * 和 sharedDepsRoot 分开查：清单可以跟着本机仓库走（开发态改 shared-deps.json 立刻生效），
 * 而 node_modules 只有构建过才存在。界面要展示「白名单里有什么」时不该被后者挡住。
 */
export function whitelistFile(): string | null {
  const candidates: string[] = [];
  const res = resourcesDir();
  if (res) candidates.push(path.join(res, 'shared-deps', 'shared-deps.json'));
  candidates.push(path.join(appRootDir(), 'shared-deps.json'));
  candidates.push(path.join(appRootDir(), 'vendor', 'shared-deps', 'shared-deps.json'));
  for (const f of candidates) if (fs.existsSync(f)) return f;
  return null;
}

/**
 * 随应用分发的 npm 入口。
 *
 * 打包后 process.execPath 是 ToolForge.exe，它同级只有 Electron 自己的运行时，
 * 没有 npm 可用；而 Node 的权限沙箱、npm 的缓存写盘都要求真实磁盘路径，
 * 把 npm 塞进 asar 会在启动阶段就失败。所以它必须是一个普通的目录。
 */
export function bundledNpmCli(): string | null {
  const candidates: string[] = [
    // 首选：跟着应用包走，随 resources/app 一起分发
    path.join(appRootDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // 次选：exe 同级（electron-builder 的 extraFiles 落点就是这里）
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const res = resourcesDir();
  if (res) candidates.push(path.join(res, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const cli of candidates) {
    if (fs.existsSync(cli)) return cli;
  }
  return null;
}
