/**
 * 渲染层回归探针：验证「AI 执行中切换任务再切回来」不会丢上下文、输入框可用。
 *
 * 用法（需要在 dist/ 已构建后）：
 *   node scripts/verify-switch.mjs
 *
 * 做法：起一个只收不回应的桩服务，让一轮对话长期处于「在飞」状态，
 * 然后在界面里发送 → 切走 → 切回，断言三件事都成立。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 18099;

const stub = http.createServer((req) => {
  req.on('data', () => {});
  // 不回任何内容：让请求一直挂着，制造「在飞」窗口
});
await new Promise((r) => stub.listen(PORT, '127.0.0.1', r));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verify-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ud-'));
fs.writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    providers: [{ id: 'stub', apiKey: 'k', model: 'm' }],
    activeProvider: 'stub',
    baseURL: `http://127.0.0.1:${PORT}/v1`,
    workspace: null,
  })
);

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.querySelector('#input');
  const sendBtn = document.querySelector('#sendBtn');
  input.value = 'MY IMPORTANT QUESTION';
  document.querySelector('#composer').requestSubmit();
  await sleep(500);
  const sentTurns = document.querySelectorAll('.turn').length;
  document.querySelector('#newTaskBtn').click();
  await sleep(300);
  const awayTurns = document.querySelectorAll('.turn').length;
  const first = document.querySelector('.task');
  if (first) first.click();
  await sleep(400);
  return JSON.stringify({
    sentTurns,
    awayTurns,
    backTurns: document.querySelectorAll('.turn').length,
    questionVisible: document.body.textContent.includes('MY IMPORTANT QUESTION'),
    liveRebuilt: !!document.querySelector('.live-turn'),
    inputDisabled: input.disabled,
    sendDisabled: sendBtn.disabled,
  });
})()`;

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'dist', 'bin', 'start.cjs'), `--user-data-dir=${userData}`],
  {
    cwd: ROOT,
    env: { ...process.env, TOOLFORGE_HOME: home, TF_SMOKE: '1', TF_SMOKE_JS: PROBE },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', () => {});

const code = await new Promise((r) => child.on('close', r));
stub.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });

const m = /\[smoke\] js=(.+)/.exec(out);
if (!m) {
  console.error('探针没有输出结果，原始输出：\n' + out);
  process.exit(1);
}
const r = JSON.parse(m[1].trim());

const checks = [
  ['发送后出现了对话气泡', r.sentTurns >= 2],
  ['切走后是新任务（空白）', r.awayTurns === 0],
  ['切回来上下文还在', r.backTurns >= 2 && r.questionVisible === true],
  ['正在执行的那一轮被重建', r.liveRebuilt === true],
  ['输入框可编辑（未被禁用）', r.inputDisabled === false],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) bad++;
}
// 还在跑的时候发送按钮应当是禁用的，这是有意行为，不算失败
console.log(`\n  结果：${checks.length - bad} 通过 / ${bad} 失败`);
process.exit(bad === 0 && code === 0 ? 0 : 1);
