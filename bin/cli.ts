#!/usr/bin/env node
import readline from 'node:readline';
import { ToolForge } from '../src/index.js';
import type { AgentEvent } from '../src/types.js';

const args = process.argv.slice(2);

function ok(name: string, cond: boolean, detail = ''): boolean {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  — ' + detail : ''}`);
  return cond;
}

// 元工具返回 JSON 字符串，声明式工具返回原生对象，两边都接住
function j(v: unknown): any {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function storeId(tf: ToolForge, name: string): string {
  const t = tf.state().tools.find((x) => x.name === name);
  if (!t) throw new Error(`找不到工具 ${name}`);
  return t.id;
}

async function selftest(): Promise<void> {
  console.log('\n ToolForge 自检 — 走一遍「造工具」的完整链路\n');
  // 自检没有界面可点，注入一个自动拒绝，免得万一碰到需确认的命令就干等超时
  const tf = new ToolForge({ approvalResponder: () => 'deny' });
  await tf.init({ connectMcp: false });
  let pass = 0;
  let fail = 0;
  const t = (name: string, cond: boolean, detail?: string): void => {
    if (ok(name, cond, detail)) pass++;
    else fail++;
  };

  // 1. 种子工具到位
  const names = tf.allTools().map((x) => x.name);
  t('种子工具已装入', names.includes('text_stats') && names.includes('github_repo_info'), names.join(', '));

  // 2. 声明式 transform 可执行
  const r1 = await tf.runTool('text_stats', { text: 'hello world' });
  const stats = r1.ok ? j(r1.result) : {};
  t('transform 工具执行正常', r1.ok && stats.words === 2 && stats.chars === 11, JSON.stringify(stats));

  // 3. 参数校验会拦住越界调用
  const r2 = await tf.runTool('text_stats', { wrong: 1 });
  t('参数校验生效', !r2.ok && /参数不合规/.test(r2.error || ''), r2.error);

  // 4. 造一个纯计算工具 → 应自动放行（L0）
  const r3 = await tf.runTool('create_tool', {
    name: 'count_upper',
    description: '统计字符串中大写字母的个数，纯本地计算。',
    kind: 'transform',
    input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    code: 'return (String(input.text).match(/[A-Z]/g) || []).length;',
    permissions: {},
    examples: [{ name: '基本用例', args: { text: 'aBcD' }, expect: 'result === 2' }],
  });
  const p3 = r3.ok ? j(r3.result) : {};
  t('造工具 + 用例通过 + 自动放行', p3.ok === true && p3.tool?.status === 'active' && p3.tool?.trust === 'L0', `${p3.tool?.trust} / ${p3.tool?.status}`);

  // 5. 新工具当场可用
  const r4 = await tf.runTool('count_upper', { text: 'ABCDx' });
  t('新造的工具可直接调用', r4.ok && r4.result === 4, String(r4.result));

  // 6. 用例不过 → 退回，不入库
  const r5 = await tf.runTool('create_tool', {
    name: 'broken_by_design',
    description: '故意写错断言的工具，验证测试门槛。',
    kind: 'transform',
    input: { type: 'object', properties: {} },
    code: 'return 1;',
    permissions: {},
    examples: [{ name: '必败用例', args: {}, expect: 'result === 99' }],
  });
  const p5 = r5.ok ? j(r5.result) : {};
  t('用例不过则不予放行', p5.ok === false && p5.stage === 'test' && p5.tool?.status === 'untested', p5.hint || p5.error);

  // 7. 高危代码 → L3，转人工
  const r6 = await tf.runTool('create_tool', {
    name: 'sneaky_probe',
    description: '静态扫描探针：代码里偷偷 require 子进程。',
    kind: 'script',
    input: { type: 'object', properties: {} },
    code: "const cp = require('child_process'); module.exports = async () => ({ ok: 1 });",
    permissions: {},
    examples: [{ name: '形状用例', args: {}, expect: 'result.ok === 1' }],
  });
  const p6 = r6.ok ? j(r6.result) : {};
  t('高危代码判为 L3 待人工', p6.tool?.trust === 'L3' && p6.review?.needsHuman === true, (p6.review?.reasons || []).join('；'));

  // 8. 脚本工具：子进程沙箱跑通
  const r7 = await tf.runTool('create_tool', {
    name: 'count_bytes',
    description: '计算字符串的 UTF-8 字节数，用于验证脚本在执行沙箱内可运行。',
    kind: 'script',
    input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    code: 'module.exports = async (input) => ({ bytes: Buffer.byteLength(String(input.text || ""), "utf8") });',
    permissions: {},
    examples: [{ name: '汉字三字节', args: { text: '汉字' }, expect: 'result.bytes === 6' }],
  });
  const p7 = r7.ok ? j(r7.result) : {};
  t(
    '脚本工具在子进程沙箱中运行',
    p7.ok === true && p7.tool?.trust === 'L1',
    `${p7.tool?.trust} / ${p7.tool?.status} ${p7.tests?.details?.[0]?.note || ''}`
  );

  // 9. 沙箱内网络白名单真的会拦
  const r8 = await tf.runTool('create_tool', {
    name: 'net_guard_probe',
    description: '探针：验证沙箱会拦截未声明的域名。',
    kind: 'script',
    input: { type: 'object', properties: {} },
    code: `module.exports = async (input, ctx) => {
  try { await ctx.net.get('https://evil.example.test/'); return { blocked: false }; }
  catch (e) { return { blocked: true, reason: e.message }; }
};`,
    permissions: { net: ['example.com'] },
    examples: [{ name: '越权应被拦', args: {}, expect: 'result.blocked === true' }],
  });
  const p8 = r8.ok ? j(r8.result) : {};
  t('未声明域名被拦截', p8.ok === true, p8.tests?.details?.[0]?.note || p8.error || 'ok');

  // 10. 需要写盘的工具 → L2 待人工
  const r9 = await tf.runTool('create_tool', {
    name: 'save_note',
    description: '把一段文本写进工具自己的数据目录，用于验证 L2 定级。',
    kind: 'script',
    input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    code: `module.exports = async (input, ctx) => {
  const p = ctx.fs.write('notes/last.txt', String(input.text));
  return { path: p, ok: true };
};`,
    permissions: { fsWrite: ['notes'] },
    examples: [{ name: '写一段', args: { text: 'hi' }, expect: 'result.ok === true' }],
  });
  const p9 = r9.ok ? j(r9.result) : {};
  t(
    '写盘类判为 L2 待人工',
    p9.tool?.trust === 'L2' && p9.tool?.status === 'pending' && p9.review?.needsHuman === true,
    `${p9.tool?.trust} / ${p9.tool?.status}`
  );

  // 11. 未放行的工具不允许跨会话调用
  const saved = tf.sessionId;
  tf.sessionId = 'other_session';
  const blocked = await tf.runTool('save_note', { text: 'x' });
  t('未放行工具不能跨会话使用', !blocked.ok && /尚未放行/.test(blocked.error || ''), blocked.error);
  tf.sessionId = saved;

  // 12. 人工放行后转为常驻
  const st = tf.approve(storeId(tf, 'save_note'));
  const approved = st.tools.find((x) => x.name === 'save_note');
  t('人工放行后进入常驻池', approved?.status === 'active', approved?.status);

  // 13. 审计日志有据可查
  const logs = tf.state().audit;
  t('审计日志已落盘', logs.length > 5 && logs.some((l) => l.type === 'tool_call'), `${logs.length} 条`);

  console.log(`\n 结果：${pass} 通过 / ${fail} 失败`);
  console.log(` 仓库：${tf.state().home}\n`);
  await tf.close();
  process.exit(fail === 0 ? 0 : 1);
}

async function repl(): Promise<void> {
  // 命令行没有可点的确认条：把请示打印出来并按拒绝处理，结果照样回灌模型。
  // 想真正人工放行请用桌面端（pnpm start）。
  const tf = new ToolForge({
    onEvent: renderEvent,
    approvalResponder: (req) => {
      console.log(`\n   ⚠ 需要人工授权：${req.action}`);
      console.log(`     理由：${req.reason}`);
      console.log('     命令行不弹确认，本次按拒绝处理；需要放行请用桌面端。\n');
      return 'deny';
    },
  });
  await tf.init();
  let phase: 'work' | 'create' = 'work';
  console.log('\n ToolForge —— 创建你自己的 Agent');
  console.log(` 仓库 ${tf.state().home}`);
  console.log(' /work 切换干活   /create 切换造工具   /tools 看仓库   /approve <id>');
  console.log(' /access <readonly|workspace|full> 切换权限档位   /exit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  const ask = (): void => {
    rl.question(` [${phase}] > `, async (line: string) => {
      const text = line.trim();
      if (!text) return ask();
      if (text === '/exit') return rl.close();
      if (text === '/work' || text === '/create') {
        phase = text.slice(1) as 'work' | 'create';
        return ask();
      }
      if (text === '/tools') {
        for (const t of tf.state().tools) {
          console.log(`   ${t.trust} ${t.status.padEnd(8)} ${t.name.padEnd(22)} ${t.permissions}`);
        }
        return ask();
      }
      if (text.startsWith('/approve ')) {
        tf.approve(text.slice(9).trim());
        console.log('   已放行');
        return ask();
      }
      if (text.startsWith('/access ')) {
        const st = tf.setAccessLevel(text.slice(8).trim() as never);
        console.log(`   权限档位：${st.access.level}`);
        return ask();
      }
      try {
        const res = await tf.chat({ input: text, phase, history });
        history.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply });
        // 别用固定窗口裁历史：历史整体前移一格，前缀缓存就整段失效。
        // 裁到 20000 字以内（后端也按这个量级算预算），能留就全留。
        while (history.length > 2 && JSON.stringify(history).length > 24000) history.splice(0, 2);
        console.log('\n' + res.reply + '\n');
        if (res.usage && res.usage.prompt) {
          const u = res.usage;
          const pct = Math.round((u.hit / u.prompt) * 100);
          console.log(`   缓存 ${pct}%  (命中 ${u.hit} / 输入 ${u.prompt} tokens，输出 ${u.completion})`);
        }
      } catch (err) {
        console.log('\n 出错：' + (err as Error).message + '\n');
      }
      ask();
    });
  };
  ask();
}

function renderEvent(e: AgentEvent): void {
  if (e.type === 'tool_call') {
    console.log(`   ⚙ ${e.name}(${JSON.stringify(e.args).slice(0, 120)})`);
  } else if (e.type === 'tool_result') {
    console.log(`   ${e.ok ? '✓' : '✗'} ${e.name}  ${e.ms || 0}ms  ${(e.preview || '').slice(0, 120)}`);
  }
}

if (args.includes('--selftest')) {
  selftest().catch((err: Error) => {
    console.error('\n 自检崩了：', err.message, '\n', err.stack);
    process.exit(1);
  });
} else {
  repl();
}
