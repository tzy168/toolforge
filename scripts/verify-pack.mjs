// 验证「打包后双击图标启动」这条路上，三方依赖链路是否真的通。
//
// 它不只检查文件摆得对不对，而是真的把打包出来的 exe 拉起来跑一遍自检：
//   · 走白名单（version 与白名单一致）→ 必须 manager=shared，全程不联网
//   · 白名单未命中（换成白名单里没有的版本）→ 必须 manager=npm，用随包分发的 npm
// 两条路都验，才算回答了「点桌面图标启动能不能装依赖」。
//
// 跑法：node scripts/verify-pack.mjs [--reuse]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(ROOT, 'release', 'ToolForge-win32-x64');
const EXE = path.join(OUT, process.platform === 'win32' ? 'ToolForge.exe' : 'ToolForge');
const TMP_HOME = path.join(os.tmpdir(), `toolforge-packtest-${Date.now()}`);
const REUSE = process.argv.includes('--reuse');

const LOG = path.join(ROOT, '.verify-pack.log');
fs.writeFileSync(LOG, `# verify-pack ${new Date().toISOString()}\n`, 'utf8');
const logLine = (s) => fs.appendFileSync(LOG, s + '\n');
const consoleLog = console.log.bind(console);
const consoleErr = console.error.bind(console);
console.log = (...a) => {
  consoleLog(...a);
  logLine(a.map(String).join(' '));
};
console.error = (...a) => {
  consoleErr(...a);
  logLine('ERR ' + a.map(String).join(' '));
};

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail });
  if (!cond) console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
};

function runNode(args, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 拉起打包好的 exe 跑自检，返回它吐出的那份报告 */
function runSelftest(depVersion) {
  return new Promise((resolve) => {
    const env = { ...process.env, TOOLFORGE_HOME: TMP_HOME, TF_PACK_SELFTEST: '1', TF_SELFTEST_DEP: 'dayjs' };
    // 主进程必须是真 Electron：这个变量会把它降级成纯 Node，resourcesPath 就没了
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_ENABLE_LOGGING;
    if (depVersion) env.TF_SELFTEST_VERSION = depVersion;

    const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + e.message, report: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.includes('[pack-selftest]'));
      let report = null;
      if (line) {
        const payload = line.slice(line.indexOf('[pack-selftest]') + '[pack-selftest]'.length).trim();
        try {
          report = JSON.parse(payload);
        } catch {
          /* 留 null，由断言报错 */
        }
      }
      resolve({ code, out, err, report });
    });
  });
}

async function main() {
  console.log(`产物目录: ${OUT}`);
  console.log(`临时 HOME: ${TMP_HOME}`);

  // ---- 1) 构建 ----
  if (!REUSE) {
    console.log('tsc 构建…');
    const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}`);
    for (const proj of ['tsconfig.json', 'tsconfig.ui.json']) {
      const r = await runNode([tsc, '-p', proj]);
      if (r.code !== 0) throw new Error(`${proj} 构建失败：\n${r.out}\n${r.err}`);
    }

    console.log('组装桌面产物…');
    const r = await runNode([path.join(ROOT, 'scripts', 'build-desktop.mjs')]);
    if (r.code !== 0) throw new Error(`打包失败：\n${r.out}\n${r.err}`);
    r.out.split('\n').forEach((l) => l.trim() && console.log(l));
  } else {
    console.log('--reuse：跳过构建，直接用现有产物');
  }

  // ---- 2) 静态布局 ----
  ok('产物里有启动器', fs.existsSync(EXE), EXE);
  ok('应用入口在 resources/app 下', fs.existsSync(path.join(OUT, 'resources', 'app', 'dist', 'electron', 'main.cjs')));
  ok('界面文件随包分发', fs.existsSync(path.join(OUT, 'resources', 'app', 'src', 'ui', 'index.html')));
  ok('默认 electron.exe 已改名（否则双击会落到默认页）', !fs.existsSync(path.join(OUT, 'electron.exe')));
  ok('default_app.asar 已移除', !fs.existsSync(path.join(OUT, 'resources', 'default_app.asar')));
  const bundledNpm = path.join(OUT, 'resources', 'app', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  ok('npm 随包分发（目标机器没有 Node）', fs.existsSync(bundledNpm), bundledNpm);
  const sharedPkg = path.join(OUT, 'resources', 'shared-deps', 'node_modules', 'dayjs', 'package.json');
  ok('离线白名单已预装', fs.existsSync(sharedPkg), sharedPkg);
  if (fs.existsSync(sharedPkg)) {
    const v = JSON.parse(fs.readFileSync(sharedPkg, 'utf8')).version;
    ok('白名单版本与声明一致', v === '1.11.13', v);
  }

  // ---- 3) 真启动：白名单通道 ----
  console.log('\n[1/2] 拉起打包后的 exe：白名单通道');
  const hit = await runSelftest('1.11.13');
  logLine(`selftest#1 code=${hit.code} report=${JSON.stringify(hit.report)}`);
  if (!hit.report) console.error(`  stderr: ${hit.err.trim().split('\n').slice(-8).join('\n  ')}`);
  ok('自检拿到报告', Boolean(hit.report), `code=${hit.code}`);
  const r1 = hit.report || {};
  ok('跑在打包形态里（isPackaged）', r1.packaged === true, String(r1.packaged));
  ok('应用根指向 resources/app', String(r1.appRoot || '').toLowerCase() === path.join(OUT, 'resources', 'app').toLowerCase(), String(r1.appRoot));
  ok('resources 指向产物目录', String(r1.resources || '').toLowerCase() === path.join(OUT, 'resources').toLowerCase(), String(r1.resources));
  ok('找到随包 npm', String(r1.bundledNpmCli || '').startsWith(OUT), String(r1.bundledNpmCli));
  ok('找到离线白名单', String(r1.sharedDepsRoot || '').startsWith(OUT), String(r1.sharedDepsRoot));
  ok('白名单全部命中', Array.isArray(r1.sharedPlan?.missing) && r1.sharedPlan.missing.length === 0, JSON.stringify(r1.sharedPlan));
  ok('安装成功', r1.install?.ok === true, JSON.stringify(r1.install));
  ok('走的是离线通道（没联网）', r1.install?.manager === 'shared', String(r1.install?.manager));
  ok('沙箱里 require 到声明版本', r1.run?.version === '1.11.13', String(r1.run?.version));
  ok('ctx.net 仍在（沙箱没被依赖削弱）', r1.run?.sandboxNet === true);
  ok('Node 权限沙箱启用', r1.perm?.probed === true && r1.perm?.flag !== null, JSON.stringify(r1.perm));
  ok('自检无错误', !r1.error, String(r1.error));

  // ---- 4) 真启动：联网回落到随包 npm ----
  // 换成白名单里没有的版本，强制走联网安装——这条才验证随包 npm 在打包形态下真能用
  console.log('\n[2/2] 拉起打包后的 exe：白名单未命中 → 随包 npm 联网安装');
  const miss = await runSelftest('1.11.12');
  logLine(`selftest#2 code=${miss.code} report=${JSON.stringify(miss.report)}`);
  if (!miss.report) console.error(`  stderr: ${miss.err.trim().split('\n').slice(-8).join('\n  ')}`);
  ok('自检拿到报告（联网）', Boolean(miss.report), `code=${miss.code}`);
  const r2 = miss.report || {};
  ok('白名单未命中被识别', Array.isArray(r2.sharedPlan?.missing) && r2.sharedPlan.missing.includes('dayjs'), JSON.stringify(r2.sharedPlan));
  ok('回落到联网安装', r2.install?.manager === 'npm', String(r2.install?.manager));
  ok('联网装的是声明版本', r2.run?.version === '1.11.12', String(r2.run?.version));
  ok('联网安装后沙箱仍可用', r2.run?.sandboxNet === true, JSON.stringify(r2.run));

  // ---- 5) 收尾 ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.error(`失败 ${failed.length} 项：${failed.map((f) => f.name).join('、')}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
    console.log('临时 HOME 已清理（release/ 保留，供人工检查）');
  }
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : String(err)}`);
  logLine(`FATAL ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
