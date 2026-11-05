/**
 * 渲染层回归探针：验证设置页「工具仓库」的等级 tab 与名称搜索。
 *
 * 用法（需要在 dist/ 已构建后）：
 *   node scripts/verify-toolfilter.mjs
 *
 * 做法：起 Electron 打开设置页，在真实 DOM 上点 tab、敲搜索框，
 * 断言「按等级筛 / 按名称模糊搜 / 两者叠加 / 空状态 / 刷新后条件不丢」都成立；
 * 顺带验「外观」里的等待动画切换、等待态同步与偏好持久化。
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

  // ---- 顺带验「外观」：等待动画可切换、只同步等待态、不动预览 ----
  const apNav = q('.nav-item[data-pane="appearance"]');
  const apPane = q('.pane[data-pane="appearance"]');
  const apCards = () => [...document.querySelectorAll('#loaderOptions .loader-option')];
  const apChecked = () => {
    const a = apCards().find((b) => b.getAttribute('aria-checked') === 'true');
    return a ? a.dataset.kind : null;
  };
  if (apNav) apNav.click();
  await sleep(120);
  const apKinds = apCards().map((b) => b.dataset.kind);
  const apDefault = apChecked();
  const apPreviewBefore = apCards().map((b) => b.querySelector('.loader').dataset.kind);
  // 造一个等待态 loader，模拟流式中正在显示的那一个
  const apFake = document.createElement('div');
  apFake.className = 'thinking';
  const apLive = document.createElement('div');
  apLive.className = 'loader';
  apLive.dataset.kind = 'dots';
  apFake.appendChild(apLive);
  q('#viewSettings').appendChild(apFake);
  const apRing = apCards().find((b) => b.dataset.kind === 'ring');
  if (apRing) apRing.click();
  await sleep(80);
  const appearance = {
    hasNav: !!apNav,
    paneVisible: !!apPane && !apPane.hidden,
    kinds: apKinds,
    defaultKind: apDefault,
    checkedAfter: apChecked(),
    checkedCount: apCards().filter((b) => b.getAttribute('aria-checked') === 'true').length,
    stored: localStorage.getItem('toolforge.appearance'),
    // applyLoader 是整节点替换，别拿旧的 apLive 引用看结果
    liveKind: apFake.querySelector('.loader') ? apFake.querySelector('.loader').dataset.kind : null,
    liveReplaced: !apFake.contains(apLive),
    previewBefore: apPreviewBefore,
    previewAfter: apCards().map((b) => b.querySelector('.loader').dataset.kind),
    uvFetch: !!q('#uvFetch'),
    uvMoreHiddenBefore: q('#uvMore') ? q('#uvMore').hidden : false,
    uvListEmpty: q('#uvList') ? q('#uvList').children.length === 0 : false,
    uvPreviewHidden: q('#uvPreview') ? q('#uvPreview').hidden : false,
    truckSvg: !!(apCards().find((b) => b.dataset.kind === 'truck') || { querySelector: () => null }).querySelector('svg'),
  };

  // 真实走一遍在线 UI：点「获取」→ 点第一款 → 设为等待动画，验 Shadow DOM 隔离。
  // 离线时列表为空，相关断言跳过，不制造假红。
  q('#uvFetch').click();
  let uvItems = [];
  for (let i = 0; i < 40 && !uvItems.length; i++) {
    await sleep(200);
    uvItems = [...document.querySelectorAll('#uvList .uv-item')];
  }
  const uvStatusText = q('#uvStatus') ? q('#uvStatus').textContent : '';
  if (uvItems.length) {
    uvItems[0].click();
    for (let i = 0; i < 40 && !q('#uvPreview .uv-use'); i++) await sleep(200);
  }
  const uvUse = q('#uvPreview .uv-use');
  if (uvUse) uvUse.click();
  await sleep(120);
  // 真实点一次「加载下一页」，列表条目应累积变多
  const beforeMore = document.querySelectorAll('#uvList .uv-item').length;
  const moreBtn = q('#uvMore');
  if (moreBtn && !moreBtn.hidden) moreBtn.click();
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (document.querySelectorAll('#uvList .uv-item').length > beforeMore) break;
  }
  const moreAdded = document.querySelectorAll('#uvList .uv-item').length - beforeMore;
  // 等比缩放后内容必须完整落在预览盒里，且预览盒按 loader 自身比例（不撑固定信箱）
  const fitHost = document.querySelector('#uvPreview .uv-host');
  const fitBox = fitHost ? fitHost.closest('.loader') : null;
  const fitScale = fitHost ? Number((fitHost.style.transform.split('scale(')[1] || '').split(')')[0] || '0') : 0;
  const fitW = fitHost ? parseFloat(fitHost.style.width) : 0;
  const fitH = fitHost ? parseFloat(fitHost.style.height) : 0;
  const fitOk = !!(fitHost && fitBox && fitScale > 0
    && fitW * fitScale <= fitBox.clientWidth + 1
    && fitH * fitScale <= fitBox.clientHeight + 1
    // 盒子比例必须≈loader 原生比例：证明没被塞进固定 160×84 信箱
    && Math.abs((fitBox.clientWidth / fitBox.clientHeight) - (fitW / fitH)) < 0.05);
  const uvLive = apFake.querySelector('.loader');
  const uvHost = uvLive ? uvLive.querySelector('.uv-host') : null;
  const uvShadow = uvHost ? uvHost.shadowRoot : null;
  const uvCss = uvShadow && uvShadow.querySelector('style') ? uvShadow.querySelector('style').textContent : '';
  const uvBody = uvShadow ? uvShadow.querySelector('div') : null;
  const uvHtml = uvBody ? uvBody.innerHTML : '';
  // 组件页把属性写成 \&quot;xxx\&quot;，解码漏掉反斜杠会让类名匹配不上、预览全白。
  // 注意整段 PROBE 是模板字符串，检查式里别写反斜杠转义（会被模板层吃掉一层）。
  const uvClasses = [...new Set([...uvCss.matchAll(/[.]([A-Za-z][A-Za-z0-9_-]*)[ {,:]/g)].map((m) => m[1]))];
  appearance.uvOnline = {
    ok: uvItems.length > 0,
    count: uvItems.length,
    cssOk: !!q('#uvPreview .uv-card'),
    shadowOk: !!(uvShadow && uvShadow.querySelector('style')),
    hasAnim: /animation:|@keyframes/.test(uvCss),
    htmlClean: uvHtml.length > 10 && uvHtml.indexOf(String.fromCharCode(92)) < 0 && /class="[A-Za-z0-9_-]+"/.test(uvHtml),
    classMatch: uvClasses.some((c) => uvHtml.includes('class="' + c + '"')),
    htmlSample: uvHtml.slice(0, 240),
    cssSample: uvCss.slice(0, 200),
    liveKind: uvLive ? uvLive.dataset.kind : null,
    statusText: uvStatusText,
    storedKind: (() => { try { return JSON.parse(localStorage.getItem('toolforge.appearance')).loader; } catch { return null; } })(),
    moreAdded,
    fitOk,
    error: null,
  };

  return JSON.stringify({
    appearance,
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
  ['设置页有「外观」入口且能打开', r.appearance.hasNav === true && r.appearance.paneVisible === true],
  ['等待动画渲染出五款且默认墨点呼吸', r.appearance.kinds.join(',') === 'dots,ring,bars,orbit,truck' && r.appearance.defaultKind === 'dots'],
  ['切换后选中态唯一且落在细环', r.appearance.checkedAfter === 'ring' && r.appearance.checkedCount === 1],
  ['偏好写进 localStorage', (() => { try { return JSON.parse(r.appearance.stored).loader === 'ring'; } catch { return false; } })()],
  ['等待态换节点并同步新样式、预览卡片不变', r.appearance.liveKind === 'ring' && r.appearance.liveReplaced === true && r.appearance.previewAfter.join(',') === r.appearance.previewBefore.join(',')],
  ['卡车彩蛋款克隆出原始 SVG', r.appearance.truckSvg === true],
  ['在线目录入口就位且不预先联网', r.appearance.uvFetch === true && r.appearance.uvListEmpty === true && r.appearance.uvPreviewHidden === true],
  ['在线目录能取回列表并生成预览', !r.appearance.uvOnline.ok || (r.appearance.uvOnline.count > 0 && r.appearance.uvOnline.cssOk === true)],
  ['在线款设为等待动画后走 Shadow DOM 隔离', !r.appearance.uvOnline.ok || (r.appearance.uvOnline.shadowOk === true && r.appearance.uvOnline.liveKind === 'uv' && r.appearance.uvOnline.storedKind === 'uv')],
  ['在线样式解码干净且 CSS 类名能对上 HTML', !r.appearance.uvOnline.ok || (r.appearance.uvOnline.hasAnim === true && r.appearance.uvOnline.htmlClean === true && r.appearance.uvOnline.classMatch === true)],
  ['分页能加载下一页并累积条目', r.appearance.uvMoreHiddenBefore === true && (!r.appearance.uvOnline.ok || r.appearance.uvOnline.moreAdded > 0)],
  ['在线样式等比缩放完整不裁切', !r.appearance.uvOnline.ok || r.appearance.uvOnline.fitOk === true],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) bad++;
}
// 失败时把原始数据打出来，省得靠猜
if (bad) console.log('\n  探针数据：' + JSON.stringify(r, null, 2));
const uv = r.appearance.uvOnline;
console.log(
  `\n  在线目录实测：${uv.ok ? `列表 ${uv.count} 款，预览生成${uv.cssOk ? '成功' : '失败'}，Shadow 隔离${uv.shadowOk ? '成功' : '未验证'}` : `离线或不可用（${uv.statusText || uv.error || '未取回'}），已跳过`}`
);
console.log(`\n  结果：${checks.length - bad} 通过 / ${bad} 失败`);
process.exit(bad === 0 && code === 0 ? 0 : 1);
