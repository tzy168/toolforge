/**
 * 渲染层回归探针：验证设置页「工具仓库」的等级 tab 与名称搜索。
 *
 * 用法（需要在 dist/ 已构建后）：
 *   node scripts/verify-toolfilter.mjs
 *
 * 做法：起 Electron 打开设置页，在真实 DOM 上点 tab、敲搜索框，
 * 断言「按等级筛 / 按名称模糊搜 / 两者叠加 / 空状态 / 刷新后条件不丢」都成立。
 * 和 verify-switch.mjs 一样走 TF_SMOKE 通道，不需要额外的测试框架。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const tabs = () => [...document.querySelectorAll('#toolTabs .tool-tab')];
  const tabKey = (b) => b.querySelector('span').textContent;
  const tabCount = (b) => Number(b.querySelector('.tool-tab-count').textContent);
  const rows = () => [...document.querySelectorAll('#toolList .tool')].map((r) => ({
    name: r.querySelector('.tool-name').textContent,
    trust: r.querySelector('.chip').textContent,
  }));
  const activeKey = () => {
    const a = tabs().find((b) => b.classList.contains('active'));
    return a ? tabKey(a) : null;
  };
  const search = q('#toolSearch');
  const type = async (v) => {
    search.value = v;
    search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(80);
  };

  q('#settingsBtn').click();
  await sleep(900);

  const keys = tabs().map(tabKey);
  const counts = tabs().map(tabCount);
  const total = rows().length;
  const all = rows();

  // 逐个等级 tab：点开后列表只能剩这个等级，且条数对得上 tab 上的计数
  const perTab = [];
  for (const b of tabs()) {
    const key = tabKey(b);
    const n = tabCount(b);
    b.click();
    await sleep(80);
    const list = rows();
    perTab.push({
      key,
      count: n,
      shown: list.length,
      trusts: [...new Set(list.map((r) => r.trust))],
      active: activeKey(),
    });
  }

  tabs()[0].click();
  await sleep(80);
  const backToAll = rows().length;

  // 名称模糊搜索：取第一件工具名中间一段，大小写都要命中
  const sample = all.length ? all[0].name.slice(1, 5) : 'zzz';
  await type(sample);
  const hit = rows();
  await type(sample.toUpperCase());
  const hitUpper = rows().length;

  // tab 与搜索叠加：不能冒出别的等级
  const levelTab = keys.find((k) => k !== '全部') || null;
  let combo = null;
  await type('');
  if (levelTab) {
    tabs().find((b) => tabKey(b) === levelTab).click();
    await sleep(80);
    await type(sample.slice(0, 2));
    const list = rows();
    combo = { tab: levelTab, count: list.length, trusts: [...new Set(list.map((r) => r.trust))] };
  }

  await type('zzz-not-exist-zzz');
  const noneCount = rows().length;
  const emptyShown = !q('#toolEmpty').hidden;
  const emptyText = q('#toolEmpty').textContent;

  // 刷新（开关一次工具会触发 refresh）后，选中的等级与搜索词不能自己弹回去
  await type('');
  let keptAfterRefresh = null;
  if (levelTab) {
    tabs().find((b) => tabKey(b) === levelTab).click();
    await sleep(80);
    await type(sample.slice(0, 2));
    const sw = q('#toolList .tool .switch input');
    const beforeActive = activeKey();
    const beforeQuery = search.value;
    if (sw) {
      sw.checked = !sw.checked;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(700);
    }
    const list = rows();
    keptAfterRefresh = {
      clicked: !!sw,
      beforeActive,
      afterActive: activeKey(),
      queryKept: search.value === beforeQuery,
      trusts: [...new Set(list.map((r) => r.trust))],
    };
  }

  await type('');
  tabs()[0].click();
  await sleep(80);
  const restored = rows().length;
  const emptyHiddenAfter = q('#toolEmpty').hidden;

  return JSON.stringify({
    keys,
    counts,
    total,
    levels: [...new Set(all.map((r) => r.trust))],
    perTab,
    backToAll,
    sample,
    hitNames: hit.map((r) => r.name),
    hitAllMatch: hit.every((r) => r.name.toLowerCase().includes(sample.toLowerCase())),
    hitUpper,
    combo,
    noneCount,
    emptyShown,
    emptyText,
    keptAfterRefresh,
    restored,
    emptyHiddenAfter,
  });
})()`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-probe-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ud-'));

const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'bin', 'start.cjs'), `--user-data-dir=${userData}`], {
  cwd: ROOT,
  // TOOLFORGE_HOME 指到临时目录：别往真实的 ~/.toolforge 里塞种子工具
  env: { ...process.env, TOOLFORGE_HOME: home, TF_SMOKE: '1', TF_SMOKE_JS: PROBE },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));

const code = await new Promise((r) => child.on('close', r));
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });

const m = /\[smoke\] js=(.+)/.exec(out);
if (!m) {
  console.error('探针没有输出结果，原始输出：\n' + out.slice(-2000));
  process.exit(1);
}
const r = JSON.parse(m[1].trim());

const levelTabs = r.perTab.filter((t) => t.key !== '全部');
const sumLevels = levelTabs.reduce((a, t) => a + t.count, 0);
const checks = [
  ['仓库里有工具可供筛选', r.total > 0],
  ['tab 顺序：全部在最前', r.keys[0] === '全部'],
  ['tab 数量与实际相符（等级求和 = 全部）', sumLevels === r.total && r.counts[0] === r.total],
  ['每个等级 tab 只显示该等级、条数对得上', levelTabs.every((t) => t.shown === t.count && t.trusts.length === 1)],
  ['点 tab 后该 tab 高亮', r.perTab.every((t) => t.active === t.key)],
  ['回到「全部」能看到全部工具', r.backToAll === r.total],
  ['模糊搜索能命中（按名字子串）', r.hitNames.length > 0 && r.hitAllMatch === true],
  ['搜索忽略大小写', r.hitUpper === r.hitNames.length],
  ['等级 tab 与搜索能叠加', r.combo ? r.combo.trusts.every((x) => x === r.combo.tab) : true],
  ['搜不到时列表为空并给出说明', r.noneCount === 0 && r.emptyShown === true && r.emptyText.includes('zzz-not-exist-zzz')],
  ['清空搜索后恢复全部并收起空提示', r.restored === r.total && r.emptyHiddenAfter === true],
  ['刷新后等级与搜索条件不丢', r.keptAfterRefresh ? r.keptAfterRefresh.afterActive === r.keptAfterRefresh.beforeActive && r.keptAfterRefresh.queryKept === true && r.keptAfterRefresh.trusts.every((x) => x === r.keptAfterRefresh.beforeActive) : false],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) bad++;
}
// 失败时把原始数据打出来，省得靠猜
if (bad) console.log('\n  探针数据：' + JSON.stringify(r, null, 2));
console.log(`\n  结果：${checks.length - bad} 通过 / ${bad} 失败`);
process.exit(bad === 0 && code === 0 ? 0 : 1);
