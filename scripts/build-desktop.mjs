// 把项目组装成一个可以双击启动的桌面应用目录。
//
// 为什么不用 electron-builder：它在 Windows 上出安装包要从 github.com 下载
// nsis / winCodeSign 附属包（本机 GitHub 不通，见 net_probe）。而它最终产出的
// win-unpacked 本来就是「Electron runtime + resources/app」这一套，手工组装的结果
// 与之同构，还能完全离线、产物可读可 diff。将来要出 installer，在同样的目录上
// 套一层 NSIS 即可，布局不用变。
//
// 产物形状：
//   <out>/ToolForge.exe                        Electron runtime（含 dll / pak / locales）
//   <out>/resources/app/package.json           应用的 package.json（main 指向 dist/electron/main.cjs）
//   <out>/resources/app/dist/                  tsc 产物
//   <out>/resources/app/src/ui/                界面（纯 HTML/CSS/JS，不进编译流程）
//   <out>/resources/app/node_modules/          运行时依赖 + 随包分发的 npm
//   <out>/resources/shared-deps/node_modules/  离线依赖白名单
//
// 跑法：node scripts/build-desktop.mjs [--out=release/ToolForge-win32-x64] [--skip-install]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const APP_NAME = process.platform === 'win32' ? 'ToolForge.exe' : 'ToolForge';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const OUT = path.resolve(ROOT, arg('out', 'release/ToolForge-win32-x64'));
const SKIP_INSTALL = process.argv.includes('--skip-install');
const CACHE = path.join(ROOT, '.pack-cache');

const log = (s) => console.log(`  · ${s}`);

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}\n${(err || out).slice(-1200)}`))));
  });
}

/** 找能用的 npm-cli.js。构建机上有 Node，所以这里只认系统 npm，不涉及随包那份 */
function findNpmCli() {
  const candidates = [
    process.env.npm_execpath && path.basename(process.env.npm_execpath) === 'npm-cli.js' ? process.env.npm_execpath : null,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : null,
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 npm-cli.js：构建机需要完整安装 Node（含 npm）');
}

/** 在指定目录里按精确版本装一批包，返回 node_modules 路径。带缓存，改依赖才重装 */
async function installInto(dependencies, tag) {
  const key = crypto.createHash('sha1').update(JSON.stringify(dependencies)).digest('hex').slice(0, 12);
  const cacheDir = path.join(CACHE, `${tag}-${key}`);
  const cached = path.join(cacheDir, 'node_modules');
  if (fs.existsSync(cached)) {
    log(`复用缓存 ${path.relative(ROOT, cacheDir)}`);
    return cached;
  }
  if (SKIP_INSTALL) throw new Error(`--skip-install 且没有缓存：${tag}`);

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'package.json'),
    JSON.stringify({ name: `toolforge-${tag}`, version: '0.0.0', private: true, dependencies }, null, 2),
    'utf8'
  );
  // ignore-scripts 是硬要求：这条链路上任何 postinstall 都是未经审核的代码执行
  fs.writeFileSync(path.join(cacheDir, '.npmrc'), ['ignore-scripts=true', 'audit=false', 'fund=false', 'save-exact=true', ''].join('\n'), 'utf8');

  const npmCli = findNpmCli();
  await run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--loglevel=error'], cacheDir);
  if (!fs.existsSync(cached)) throw new Error(`${tag} 安装完成但没有 node_modules`);
  return cached;
}

/** vendor 里的实际版本是否与清单逐一对得上 */
function vendorMatches(vendorModules, pkgs) {
  for (const [name, version] of Object.entries(pkgs)) {
    const file = path.join(vendorModules, name, 'package.json');
    if (!fs.existsSync(file)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (String(pkg.version) !== version) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function countTree(dir) {
  let bytes = 0;
  let files = 0;
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
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* 并发删除，忽略 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function copyDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // dereference：pnpm 的 node_modules 是符号链接结构，打包必须落成实体文件，
  // 否则目标机器上会出现指向一个根本不存在的 store 的链接
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

async function main() {
  console.log(`产物目录: ${OUT}`);

  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(distDir, 'electron', 'main.cjs'))) {
    throw new Error('dist/electron/main.cjs 不存在：先跑 pnpm build');
  }
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(electronDist, 'electron.exe')) && process.platform === 'win32') {
    throw new Error(`找不到 Electron runtime：${electronDist}（先 pnpm install）`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // ---- 1) 清空产物目录 ----
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ---- 2) Electron runtime ----
  log('复制 Electron runtime');
  copyDir(electronDist, OUT);
  const exe = path.join(OUT, 'electron.exe');
  if (fs.existsSync(exe)) fs.renameSync(exe, path.join(OUT, APP_NAME));
  // 留着它只会在 app 目录出问题时静默启动默认页，把人误导向「界面坏了」
  fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

  // ---- 3) 应用本体 ----
  const appDir = path.join(OUT, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  log('复制 dist 与 src/ui');
  copyDir(distDir, path.join(appDir, 'dist'));
  copyDir(path.join(ROOT, 'src', 'ui'), path.join(appDir, 'src', 'ui'));

  // package.json 只留运行时需要的字段：devDependencies / scripts 带进安装包
  // 除了让人误以为能在目标机器上跑，没有任何好处
  const appPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: pkg.type,
    description: pkg.description,
    repository: pkg.repository,
    homepage: pkg.homepage,
    main: pkg.main,
    dependencies: pkg.dependencies || {},
    optionalDependencies: pkg.optionalDependencies || {},
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8');

  // ---- 4) 运行时依赖 ----
  const runtimeDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  log(`安装运行时依赖（${Object.keys(runtimeDeps).length} 个）`);
  const prodModules = await installInto(runtimeDeps, 'prod');
  copyDir(prodModules, path.join(appDir, 'node_modules'));

  // ---- 5) 随包分发的 npm ----
  // 目标机器上没有 Node，联网安装全靠这一份。npm 要求真实磁盘路径（缓存、临时目录、
  // 子进程），塞进 asar 会在启动阶段就失败，所以它必须是普通目录。
  // findNpmCli 给的是 <...>/node_modules/npm/bin/npm-cli.js，往上两级才是包目录本身。
  // 往上三级会拿到整个 node_modules——那样 npm 会被复制成 npm/npm，bundledNpmCli 直接落空。
  const npmSrc = path.dirname(path.dirname(findNpmCli()));
  log(`随包分发 npm（${Math.round(countTree(npmSrc).bytes / 1024 / 1024)}MB）`);
  copyDir(npmSrc, path.join(appDir, 'node_modules', 'npm'));

  // ---- 6) 离线依赖白名单 ----
  const whitelistFile = path.join(ROOT, 'shared-deps.json');
  if (fs.existsSync(whitelistFile)) {
    const wl = JSON.parse(fs.readFileSync(whitelistFile, 'utf8').replace(/^\uFEFF/, ''));
    const pkgs = wl.packages || {};
    const names = Object.keys(pkgs);
    if (names.length) {
      log(`准备离线白名单（${names.length} 个：${names.join(', ')}）`);
      // 优先复用 vendor/shared-deps：那份由 build-shared-deps.mjs 产出，并且已经过
      // verify-whitelist 的双运行时 require 验收。打包时现场再装一遍，等于换一棵树，
      // 验收结论就不成立了。清单对不上才回落到现场安装。
      const vendorModules = path.join(ROOT, 'vendor', 'shared-deps', 'node_modules');
      let sharedModules;
      if (fs.existsSync(vendorModules) && vendorMatches(vendorModules, pkgs)) {
        log('复用 vendor/shared-deps（已验收）');
        sharedModules = vendorModules;
      } else {
        log('vendor/shared-deps 缺失或与清单不一致，现场安装');
        sharedModules = await installInto(pkgs, 'shared');
      }
      copyDir(sharedModules, path.join(OUT, 'resources', 'shared-deps', 'node_modules'));
      fs.writeFileSync(path.join(OUT, 'resources', 'shared-deps', 'shared-deps.json'), JSON.stringify(wl, null, 2), 'utf8');
    }
  } else {
    log('没有 shared-deps.json：跳过离线白名单，打包后只能联网装依赖');
  }

  // ---- 7) 汇总 ----
  const total = countTree(OUT);
  console.log(`\n完成：${OUT}`);
  console.log(`  ${(total.bytes / 1024 / 1024).toFixed(1)}MB，${total.files} 个文件`);
  console.log(`  启动器：${path.join(OUT, APP_NAME)}`);
  console.log(`  自检：${path.join(OUT, APP_NAME)} + TF_PACK_SELFTEST=1`);
}

main().catch((err) => {
  console.error(`\n打包失败：${err.message}`);
  process.exitCode = 1;
});
