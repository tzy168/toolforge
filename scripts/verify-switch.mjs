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

/**
 * 桩服务：默认只收不回应（制造在飞窗口）；
 * 一旦收到的消息里出现 CONTINUE 字样，就转为正常流式回复。
 *
 * 不用外部 HTTP 通知切换模式——渲染层有 CSP（default-src 'self'），fetch 不到本地端口。
 */
// 一轮要两个来回：第一步「想 → 调工具」，第二步「再想 → 给答案」。
// 只有这样才验得出来思考是画在各自那一步的位置上，而不是全堆在轮次开头。
let contSeen = 0;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (!body.includes('CONTINUE')) return; // 不回：连接一直挂着

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        })}\n\n`
      );
    contSeen++;
    chunk({ role: 'assistant', content: '' });
    if (contSeen % 2 === 1) {
      // 第一步：先想一下，再调一件工具（list_tools 是内核元工具，一定在场）
      chunk({ reasoning_content: 'THINK-STEP1' });
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_tools', arguments: '{}' } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ reasoning_content: 'REASONING-TEXT' });
      chunk({ content: 'STUB-REPLY-OK' });
      chunk({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => stub.listen(PORT, '127.0.0.1', r));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verify-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ud-'));
fs.writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    // custom: true 是必须的：mergeProviders 只按预设 id 匹配，
    // 缺这个标记自定义服务商会被忽略，activeProvider 也就选不中，界面会一直「思考中」等着。
    providers: [{ id: 'stub', label: 'Stub', baseURL: `http://127.0.0.1:${PORT}/v1`, model: 'm', apiKey: 'k', custom: true }],
    activeProvider: 'stub',
    workspace: null,
  })
);

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 另挂一个监听，把桥送上来的事件按序记下来，失败时能看出是哪一段丢了
  const evLog = [];
  if (window.tf) window.tf.onEvent((e) => evLog.push(e.type + '|' + String(e.reasoning || e.delta || e.name || '').slice(0, 12)));
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
  const backInfo = {
    sentTurns,
    awayTurns,
    backTurns: document.querySelectorAll('.turn').length,
    questionVisible: document.body.textContent.includes('MY IMPORTANT QUESTION'),
    liveRebuilt: !!document.querySelector('.live-turn'),
    inputDisabled: input.disabled,
    inputTypeable: (() => {
      // 真的往里打字，别只看 disabled 属性
      input.focus();
      input.value = 'typed-ok';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return input.value === 'typed-ok' && document.activeElement === input;
    })(),
    stopVisible: !document.querySelector('#stopBtn').hidden,
    toolCountText: document.querySelector('#headTools').textContent,
    toolCountNumeric: parseInt(document.querySelector('#headTools').textContent, 10),
  };

  // 暂停：点一下，应当尽快解锁输入并结束这一轮
  document.querySelector('#stopBtn').click();
  await sleep(1500);
  const afterStop = {
    stopHidden: document.querySelector('#stopBtn').hidden,
    sendEnabled: !sendBtn.disabled,
    historySaved: JSON.parse(localStorage.getItem('toolforge.tasks') || '{}').tasks?.[0]?.history?.length || 0,
  };

  // ---- 第二阶段：在历史任务里继续对话 ----
  // 桩收到含 CONTINUE 的请求才会回复，所以这条消息本身就是开关
  const histRow = document.querySelector('.task');
  if (histRow) histRow.click();
  await sleep(400);
  const before = document.querySelectorAll('.turn').length;
  input.value = 'CONTINUE IN HISTORY';
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  document.querySelector('#composer').requestSubmit();
  await sleep(3200);

  const bubbles = [...document.querySelectorAll('.msg-bot')];
  const last = bubbles[bubbles.length - 1];
  const saved2 = JSON.parse(localStorage.getItem('toolforge.tasks') || '{}');
  const continueInfo = {
    before,
    after: document.querySelectorAll('.turn').length,
    gotReply: (last?.textContent || '').includes('STUB-REPLY-OK'),
    reasoningVisible: document.body.textContent.includes('REASONING-TEXT'),
    sendUnlocked: !sendBtn.disabled,
    savedHist: saved2.tasks?.[0]?.history?.length || 0,
  };

  // ---- 收尾态检查：过程收进「任务过程」块，思考按原位排，总结留在块外 ----
  const proc = [...document.querySelectorAll('.process')].pop();
  const procBody = proc ? proc.querySelector('.process-body') : null;
  const kinds = procBody
    ? [...procBody.children].map((k) =>
        k.classList.contains('call-chip') ? 'tool' : k.classList.contains('reasoning') ? 'reasoning' : 'text'
      )
    : [];
  const finalBubble = [...document.querySelectorAll('.msg-bot')].pop();
  const processInfo = {
    processExists: !!proc,
    processCollapsed: proc ? proc.open === false : false,
    kinds: kinds.join(','),
    // 思考出现在工具之后，说明它按原位画，而不是全堆在开头
    toolBetweenThoughts: kinds.indexOf('tool') > kinds.indexOf('reasoning') && kinds.lastIndexOf('reasoning') > kinds.indexOf('tool'),
    finalOutsideProcess: !!finalBubble && !finalBubble.closest('.process') && (finalBubble.textContent || '').includes('STUB-REPLY-OK'),
    summaryText: proc && proc.querySelector('summary') ? proc.querySelector('summary').textContent : '',
    // 失败时要能看出过程里到底存了什么
    procText: procBody ? procBody.textContent.replace(/\\s+/g, ' ').slice(0, 160) : '',
    // 事件按序留一份：断言红的时候能看出是哪一段没落到数据里
    evLog: evLog.slice(-12).join(' ; '),
    segKinds: JSON.stringify(
      (JSON.parse(localStorage.getItem('toolforge.tasks') || '{}').tasks?.[0]?.process || []).map((s) => s.kind)
    ),
    expanded: (() => {
      if (!proc) return false;
      proc.querySelector('summary').click();
      return proc.open === true;
    })(),
  };

  // ---- 第三阶段：发一条永远不会回应的消息，验证兜底超时能把界面解锁 ----
  // 桩只对含 CONTINUE 的请求回复，所以这条必然挂住
  document.querySelector('#newTaskBtn').click();
  await sleep(250);
  input.value = 'HANG FOREVER';
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  document.querySelector('#composer').requestSubmit();
  await sleep(400);
  const lockedWhileRunning = !document.querySelector('#stopBtn').hidden;

  // 探针启动时用的是 ?turnTimeout=2000，这里多等一会儿让它自己收尾
  await sleep(3500);
  const timeoutInfo = {
    lockedWhileRunning,
    unlockedByTimeout: !sendBtn.disabled,
    stopGone: document.querySelector('#stopBtn').hidden,
    noteShown: (document.body.textContent || '').includes('已自动停止'),
  };

  return JSON.stringify({ ...backInfo, ...afterStop, ...continueInfo, ...processInfo, ...timeoutInfo });
})()`;

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'dist', 'bin', 'start.cjs'), `--user-data-dir=${userData}`],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      TOOLFORGE_HOME: home,
      TF_SMOKE: '1',
      TF_SMOKE_JS: PROBE,
      // 把兜底超时压到 2 秒，好在一次探针里验证「卡住能自动解锁」
      TF_TURN_TIMEOUT: '2000',
    },
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
  ['输入框可编辑且能真的打字', r.inputDisabled === false && r.inputTypeable === true],
  ['执行中露出暂停按钮', r.stopVisible === true],
  ['工具数只数用户工具，不含元工具', r.toolCountNumeric > 0 && r.toolCountNumeric <= 4],
  ['暂停后这一轮收尾、发送解锁', r.stopHidden === true && r.sendEnabled === true],
  ['暂停后问答仍留在历史里', r.historySaved >= 2],
  ['历史任务里能继续对话并拿到回复', r.gotReply === true && r.after > r.before],
  ['续聊完成后发送解锁（没卡死）', r.sendUnlocked === true],
  ['续聊后问答写进历史', r.savedHist >= 4],
  ['思考过程能被渲染出来', r.reasoningVisible === true],
  ['一轮结束后过程收进「任务过程」块', r.processExists === true],
  ['过程块默认收起', r.processCollapsed === true],
  ['过程块点得开', r.expanded === true],
  ['思考按原位渲染（没有全堆在开头）', r.toolBetweenThoughts === true && r.kinds.split(',').filter((k) => k === 'reasoning').length >= 2],
  ['最终总结留在过程块外面', r.finalOutsideProcess === true],
  ['过程摘要带件数与耗时', /件工具/.test(r.summaryText || '')],
  ['请求挂住时确实处于锁定态', r.lockedWhileRunning === true],
  ['兜底超时后自动解锁', r.unlockedByTimeout === true && r.stopGone === true],
  ['超时会给出说明而不是静默', r.noteShown === true],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) bad++;
}
// 失败时把原始数据打出来，省得靠猜
if (bad) console.log('\n  探针数据：' + JSON.stringify(r, null, 2));
// 还在跑的时候发送按钮应当是禁用的，这是有意行为，不算失败
console.log(`\n  结果：${checks.length - bad} 通过 / ${bad} 失败`);
process.exit(bad === 0 && code === 0 ? 0 : 1);
