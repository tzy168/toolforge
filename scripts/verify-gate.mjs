// 验证依赖闸门：白名单内自动装、白名单外不装也不跑、pack 往返不丢依赖。
//
// 这里验的是「顺序」这个最容易写错、也最不容易被发现的东西：
// 白名单外的依赖必须做到「既没安装也没跑用例」，否则等于先让未审核的
// 外部代码在本机执行了一遍，再去请示用户。
//
// 跑法：node scripts/verify-gate.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TMP = path.join(os.tmpdir(), `toolforge-gatetest-${Date.now()}`);
const HOME = path.join(TMP, 'home');
const SHARED = path.join(TMP, 'shared-deps');
process.env.TOOLFORGE_HOME = HOME;
process.env.TOOLFORGE_SHARED_DEPS = SHARED;

const LOG = path.join(ROOT, '.verify-gate.log');
fs.writeFileSync(LOG, `# verify-gate ${new Date().toISOString()}\n`, 'utf8');
const logLine = (s) => fs.appendFileSync(LOG, s + '\n');
const cLog = console.log.bind(console);
const cErr = console.error.bind(console);
console.log = (...a) => {
  cLog(...a);
  logLine(a.map(String).join(' '));
};
console.error = (...a) => {
  cErr(...a);
  logLine('ERR ' + a.map(String).join(' '));
};

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail });
  if (!cond) console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
};

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}`);
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc 构建失败：\n${r.stdout}\n${r.stderr}`);
}

/** 造一份最小的离线白名单（只含 dayjs@1.11.13）。优先复用打包缓存，避免联网 */
function prepareShared() {
  const modules = path.join(SHARED, 'node_modules');
  fs.mkdirSync(SHARED, { recursive: true });
  const cacheRoot = path.join(ROOT, '.pack-cache');
  const cached = fs.existsSync(cacheRoot)
    ? fs.readdirSync(cacheRoot).find((d) => d.startsWith('shared-') && fs.existsSync(path.join(cacheRoot, d, 'node_modules', 'dayjs')))
    : null;
  if (cached) {
    fs.cpSync(path.join(cacheRoot, cached, 'node_modules'), modules, { recursive: true });
    return 'cache';
  }
  // 没缓存就现装（走 npm，只装 dayjs）
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('既没有打包缓存，也没有系统 npm，无法准备白名单');
  fs.writeFileSync(
    path.join(SHARED, 'package.json'),
    JSON.stringify({ name: 'shared-probe', version: '0.0.0', private: true, dependencies: { dayjs: '1.11.13' } }, null, 2)
  );
  fs.writeFileSync(path.join(SHARED, '.npmrc'), 'ignore-scripts=true\n');
  const r = spawnSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], {
    cwd: SHARED,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`白名单准备失败：${r.stderr || r.stdout}`);
  return 'npm';
}

const TOOL_CODE = [
  "const dayjs = require('dayjs');",
  'module.exports = async (input) => ({ out: dayjs(input.d).format("YYYY-MM-DD") });',
].join('\n');

async function main() {
  console.log(`临时目录: ${TMP}`);
  build();

  const { findMetaTool } = await import('../dist/src/agent/meta-tools.js');
  const { store } = await import('../dist/src/core/store.js');
  const { exportPack, importPack } = await import('../dist/src/core/pack.js');
  const { grade } = await import('../dist/src/core/review.js');
  const { toolDir } = await import('../dist/src/core/paths.js');
  const { sharedDepsRoot } = await import('../dist/src/core/appPaths.js');

  const create = findMetaTool('create_tool');
  if (!create) throw new Error('找不到 create_tool');
  const ctx = {
    sessionId: 'verify-gate',
    allTools: () => [],
    runTool: async () => {
      throw new Error('verify-gate 不需要嵌套调用');
    },
  };

  const src = prepareShared();
  console.log(`白名单准备方式: ${src}`);
  ok('白名单目录被识别', sharedDepsRoot() === SHARED, String(sharedDepsRoot()));

  // ---- 用例 A：白名单内 ----
  console.log('\n[A] 白名单内依赖');
  const aArgs = {
    name: 'gate_dep_ok',
    description: '用 dayjs 把日期格式化成 YYYY-MM-DD',
    kind: 'script',
    input: { type: 'object', properties: { d: { type: 'string' } }, required: ['d'] },
    code: TOOL_CODE,
    deps: { dayjs: '1.11.13' },
    permissions: {},
    examples: [{ args: { d: '2024-03-05T10:00:00Z' }, expect: "result.out === '2024-03-05'" }],
  };
  const a = JSON.parse(await create.handler(aArgs, ctx));
  logLine(`A=${JSON.stringify(a)}`);
  ok('A 安装成功', a.ok === true, JSON.stringify(a.review));
  ok('A 走离线复制', a.deps?.manager === 'shared', String(a.deps?.manager));
  ok('A 用例通过', a.tests?.passed === true, JSON.stringify(a.tests?.details));
  ok('A 已装到工具目录', fs.existsSync(path.join(toolDir(a.tool.id), 'node_modules', 'dayjs', 'package.json')));
  ok('A 自动放行（白名单内不额外抬级）', a.tool.status === 'active' && a.tool.trust === 'L1', `${a.tool.status}/${a.tool.trust}`);
  const savedA = store.get(a.tool.id);
  ok('A 依赖记录落盘', savedA?.meta?.deps?.packages?.[0]?.name === 'dayjs', JSON.stringify(savedA?.meta?.deps));

  // ---- 用例 B：白名单外 ----
  console.log('\n[B] 白名单外依赖（应不装、不跑用例）');
  const b = JSON.parse(await create.handler({ ...aArgs, name: 'gate_dep_blocked', deps: { dayjs: '1.11.12' } }, ctx));
  logLine(`B=${JSON.stringify(b)}`);
  ok('B 被拦下', b.ok === false && b.stage === 'deps', JSON.stringify({ ok: b.ok, stage: b.stage }));
  ok('B 定级 L3', b.tool?.trust === 'L3', String(b.tool?.trust));
  ok('B 落为 pending', b.tool?.status === 'pending', String(b.tool?.status));
  ok('B 未跑用例', Array.isArray(b.review?.findings) && b.review?.reasons?.[0]?.includes('未跑用例'), JSON.stringify(b.review?.reasons));
  const dirB = toolDir(b.tool.id);
  ok('B 没有安装 node_modules', !fs.existsSync(path.join(dirB, 'node_modules')), dirB);
  const savedB = store.get(b.tool.id);
  ok('B 评审记录里用例为空', (savedB?.meta?.review?.tests ?? []).length === 0, JSON.stringify(savedB?.meta?.review?.tests));

  // ---- 用例 C：grade 独立口径 ----
  console.log('\n[C] grade 对依赖的判定');
  const mkTool = (deps) => ({ ...savedA, impl: { ...savedA.impl, deps } });
  ok('C 白名单内不改级别', grade(mkTool({ dayjs: '1.11.13' })).level === 'L1');
  const gBlocked = grade(mkTool({ dayjs: '1.11.12' }));
  ok('C 白名单外直接 L3', gBlocked.level === 'L3' && gBlocked.needsHuman === true, JSON.stringify(gBlocked));
  ok('C 理由里写明缺哪些包', gBlocked.reasons.some((r) => r.includes('dayjs')), JSON.stringify(gBlocked.reasons));

  // ---- 用例 D：pack 往返 ----
  console.log('\n[D] pack 往返');
  const pack = exportPack({ name: 'gate-pack', ids: [a.tool.id] });
  ok('D 导出带上依赖声明', pack.tools[0]?.impl?.deps?.dayjs === '1.11.13', JSON.stringify(pack.tools[0]?.impl?.deps));
  pack.tools[0].name = 'gate_dep_imported';
  const imported = importPack(pack);
  logLine(`D=${JSON.stringify(imported)}`);
  ok('D 导入成功', imported[0]?.ok === true, JSON.stringify(imported[0]));
  const importedTool = store.list({ includeBroken: true }).tools.find((t) => t.name === 'gate_dep_imported');
  ok('D 依赖声明保留', importedTool?.impl?.deps?.dayjs === '1.11.13', JSON.stringify(importedTool?.impl?.deps));
  ok('D 导入落为 pending（导入不等于放行）', importedTool?.status === 'pending', String(importedTool?.status));
  ok(
    'D 导入不触发安装',
    importedTool ? !fs.existsSync(path.join(toolDir(importedTool.id), 'node_modules')) : false,
    importedTool ? toolDir(importedTool.id) : 'missing'
  );

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.error(`失败 ${failed.length} 项：${failed.map((f) => f.name).join('、')}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('临时目录已清理');
  }
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : String(err)}`);
  logLine(`FATAL ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
