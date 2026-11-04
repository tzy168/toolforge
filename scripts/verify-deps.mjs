// 端到端验证「三方依赖」这条路真的通了：
//   声明 → 宿主代装 → 沙箱里 require 得到 → 版本/体积/审计记录对得上
//
// 用临时 TOOLFORGE_HOME，绝不碰用户真实的 ~/.toolforge。
// 跑法：node scripts/verify-deps.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TMP_HOME = path.join(os.tmpdir(), `toolforge-depstest-${Date.now()}`);
process.env.TOOLFORGE_HOME = TMP_HOME;

// 同时把全过程写进日志文件：有些执行通道只回最后一行错误，看不到中间输出
const LOG = path.join(ROOT, '.verify-deps.log');
fs.writeFileSync(LOG, `# verify-deps ${new Date().toISOString()}\n`, 'utf8');
const logLine = (s) => fs.appendFileSync(LOG, s + '\n');
const stdout0 = console.log.bind(console);
const stderr0 = console.error.bind(console);
console.log = (...a) => {
  stdout0(...a);
  logLine(a.map(String).join(' '));
};
console.error = (...a) => {
  stderr0(...a);
  logLine('ERR ' + a.map(String).join(' '));
};

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail });
  if (!cond) console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
};

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}（先在项目里 pnpm install）`);
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc 构建失败：\n${r.stdout}\n${r.stderr}`);
}

async function main() {
  console.log(`临时 HOME: ${TMP_HOME}`);
  console.log(`Node ${process.version}`);
  build();

  // tsconfig 的 rootDir 是 "."，所以产物在 dist/src/ 下
  const { normalizeTool, normalizeDeps } = await import('../dist/src/core/spec.js');
  const { store } = await import('../dist/src/core/store.js');
  const { installToolDeps, depsReady, toDepRecord, describeDeps } = await import('../dist/src/core/deps.js');
  const { runScript, permissionSupport } = await import('../dist/src/executors/script.js');

  // ---- 1) 规格校验：该拒的必须拒 ----
  const rejects = [
    ['范围版本', { dayjs: '^1.11.13' }],
    ['latest', { dayjs: 'latest' }],
    ['git 地址', { dayjs: 'git+https://example.com/x.git' }],
    ['file 协议', { dayjs: 'file:../x' }],
    ['非法包名', { '../evil': '1.0.0' }],
  ];
  for (const [label, deps] of rejects) {
    let rejected = false;
    try {
      normalizeDeps(deps);
    } catch {
      rejected = true;
    }
    ok(`拒绝${label}`, rejected, JSON.stringify(deps));
  }
  ok('接受精确版本', Object.keys(normalizeDeps({ dayjs: '1.11.13' })).length === 1);

  let httpWithDeps = false;
  try {
    normalizeTool({
      name: 'bad_http',
      description: '一个不该允许声明依赖的 http 工具',
      kind: 'http',
      impl: { url: 'https://example.com', deps: { dayjs: '1.11.13' } },
      examples: [{ args: {}, expect: 'true' }],
    });
  } catch {
    httpWithDeps = true;
  }
  ok('非 script 类工具拒绝 deps', httpWithDeps);

  // ---- 2) 造一件真用三方库的工具 ----
  const tool = normalizeTool({
    name: 'depstest_format',
    description: '用 dayjs 解析并格式化日期，用于验证三方依赖链路是否打通',
    kind: 'script',
    input: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
    impl: {
      deps: { dayjs: '1.11.13' },
      code: [
        "const dayjs = require('dayjs');",
        "const utc = require('dayjs/plugin/utc');",
        'dayjs.extend(utc);',
        'module.exports = async (input, ctx) => ({',
        "  formatted: dayjs(input.date).utc().format('YYYY-MM-DD HH:mm'),",
        "  version: require('dayjs/package.json').version,",
        "  sandbox: typeof ctx.net?.get === 'function',",
        '});',
      ].join('\n'),
    },
    permissions: {},
    examples: [{ args: { date: '2024-03-05T10:00:00Z' }, expect: "result.formatted === '2024-03-05 10:00'" }],
    status: 'untested',
    sessionId: 'verify-session',
  });
  store.save(tool);
  ok('依赖声明随 tool.json 落盘', store.get(tool.id)?.impl.deps?.dayjs === '1.11.13', JSON.stringify(store.get(tool.id)?.impl.deps));
  ok('未装前 depsReady=false', depsReady(store.get(tool.id)) === false);
  console.log(`  · ${describeDeps(tool.impl.deps)}`);

  // ---- 3) 宿主代装 ----
  const report = await installToolDeps(store.get(tool.id));
  console.log(`  · 安装耗时 ${report.ms}ms，${report.transitiveCount} 个包，${(report.totalBytes / 1024).toFixed(1)}KB`);
  ok('安装成功', report.ok && !report.skipped, report.error || '');
  ok('用 npm 装的', report.manager === 'npm', report.manager);
  const dayjsDep = (report.installed || []).find((d) => d.name === 'dayjs');
  ok('实装版本等于声明版本', dayjsDep?.version === '1.11.13', JSON.stringify(dayjsDep));
  ok('拿到 integrity', typeof dayjsDep?.integrity === 'string' && dayjsDep.integrity.startsWith('sha'), String(dayjsDep?.integrity).slice(0, 24));

  const dir = path.join(TMP_HOME, 'tools', tool.id);
  ok('node_modules 落在工具目录内', fs.existsSync(path.join(dir, 'node_modules', 'dayjs', 'package.json')));
  ok('lockfile 已留档', fs.existsSync(path.join(dir, 'package-lock.json')));
  ok('暂存目录已清理', !fs.existsSync(path.join(dir, '.deps-staging')));

  // 记账
  store.patch(tool.id, { meta: { ...store.get(tool.id).meta, deps: toDepRecord(report) } });
  ok('依赖记录写入 meta', store.get(tool.id)?.meta.deps?.packages?.[0]?.name === 'dayjs');

  // 幂等：再装一次应当跳过
  const again = await installToolDeps(store.get(tool.id));
  ok('已装则跳过', again.skipped === true);

  // ---- 4) 沙箱里 require 得到吗 ----
  const out = await runScript(store.get(tool.id), { date: '2024-03-05T10:00:00Z' });
  ok('沙箱 require 三方库并出结果', out?.formatted === '2024-03-05 10:00', JSON.stringify(out));
  ok('拿到的 dayjs 版本正确', out?.version === '1.11.13', String(out?.version));
  ok('ctx.net 仍在（沙箱没被依赖削弱）', out?.sandbox === true);
  const perm = permissionSupport();
  ok('Node 权限沙箱确实启用', perm.probed === true && perm.flag !== null, JSON.stringify(perm));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.error(`失败 ${failed.length} 项：${failed.map((f) => f.name).join('、')}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
    console.log('临时目录已清理');
  }
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : String(err)}`);
  logLine(`FATAL ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
