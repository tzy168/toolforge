import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 测试要落在临时仓库，别碰真实的 ~/.toolforge
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolforge-test-'));
process.env.TOOLFORGE_HOME = tmp;

const { ToolForge } = await import('../src/index.js');
const { runLoop } = await import('../src/agent/loop.js');
const { grade, staticScan } = await import('../src/core/review.js');
const { selectTools } = await import('../src/core/retrieve.js');
const { normalizeTool } = await import('../src/core/spec.js');
const { store } = await import('../src/core/store.js');
const { validateArgs } = await import('../src/core/bus.js');
type ToolForgeType = InstanceType<typeof ToolForge>;

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 假客户端。runLoop 现在走 stream:true，所以这里要把「一条完整消息」
 * 拆成若干 chunk 吐回去，模拟真实的流式形状。
 */
function mockClient(script: any[]): any {
  let turn = 0;
  return {
    chat: {
      completions: {
        async create() {
          const msg = script[turn];
          turn += 1;
          const chunks: any[] = [];

          // 文本按两段切，验证增量拼接
          const content = String(msg?.content ?? '');
          for (let i = 0; i < content.length; i += 2) {
            chunks.push({ choices: [{ delta: { content: content.slice(i, i + 2) } }] });
          }

          for (const [index, call] of (msg?.tool_calls || []).entries()) {
            chunks.push({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index, id: call.id, function: { name: call.function?.name, arguments: call.function?.arguments } }],
                  },
                },
              ],
            });
          }

          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
}

function provider(tf: ToolForgeType): () => any[] {
  return () => tf.allTools().map((t) => ({ openai: { type: 'function', function: { name: t.name } }, tool: t }));
}

test('循环能走通一次工具调用并收束', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });

  const client = mockClient([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'text_stats', arguments: '{"text":"hi there"}' } }],
    },
    { role: 'assistant', content: '两个词。' },
  ]);

  const messages: any[] = [{ role: 'user', content: '数一下 hi there 有几个词' }];
  const result = await runLoop({
    client,
    model: 'mock',
    messages,
    toolProvider: provider(tf),
    runTool: (n, a) => tf.runTool(n, a, 0),
  });

  assert.equal(result.reply, '两个词。');
  assert.equal(result.steps, 2);
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '应当把工具结果回灌给模型');
  assert.match(String(toolMsg.content), /"words":2/);
});

test('模型调用不存在的工具时，错误会回灌而不是崩溃', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });

  const client = mockClient([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }],
    },
    { role: 'assistant', content: '换个法子。' },
  ]);

  const messages: any[] = [{ role: 'user', content: '随便干点什么' }];
  const result = await runLoop({
    client,
    model: 'mock',
    messages,
    toolProvider: () => [],
    runTool: (n, a) => tf.runTool(n, a, 0),
  });

  assert.equal(result.reply, '换个法子。');
  assert.match(String(messages.find((m) => m.role === 'tool').content), /没有名为 no_such_tool/);
});

test('定级按能力走：无权限 L0，只读网络 L1，写盘 L2，高危 L3', () => {
  const base = {
    name: 'probe',
    description: '一个用来测试定级的工具呀',
    impl: { code: 'return 1;' },
    examples: [{ args: {} }],
    kind: 'transform',
  };
  const mk = (permissions: Record<string, unknown>, findings: any[] = []) =>
    grade(
      normalizeTool({
        ...base,
        permissions: { net: [], fsRead: [], fsWrite: [], exec: false, env: [], ...permissions } as any,
      }),
      findings as any
    );

  assert.equal(mk({}).level, 'L0');
  assert.equal(mk({ net: ['api.github.com'] }).level, 'L1');
  assert.equal(mk({ fsWrite: ['out'] }).level, 'L2');
  assert.equal(mk({ env: ['OPENAI_API_KEY'] }).level, 'L2');
  assert.equal(mk({ exec: true }).level, 'L3');
  assert.equal(mk({}, [{ level: 'high', msg: '用了 eval', id: 'eval', line: 1 }]).level, 'L3');
});

test('静态扫描抓得住常见的偷偷摸摸', () => {
  const hits = staticScan("const cp = require('child_process');\nconst x = eval('1+1');\n");
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('child-process'));
  assert.ok(ids.includes('eval'));
});

test('两级召回：任务词能钓出对的工具', () => {
  const tools = [
    { name: 'text_stats', description: '统计文本字数词数', meta: { tags: ['text'] } },
    { name: 'github_repo_info', description: '查询 GitHub 仓库信息', meta: { tags: ['github'] } },
    { name: 'save_note', description: '把文本写进文件保存', meta: { tags: [] } },
  ] as any[];
  const picked = selectTools(tools, '帮我查一下 github 上这个仓库的星数', { limit: 1, always: [] });
  assert.equal(picked[0]?.name, 'github_repo_info');
});

const { mergeProviders, pickActive } = await import('../src/core/models.js');

test('多模型：预设不给默认模型，没 Key 或没模型都不可选', () => {
  const list = mergeProviders([]);
  assert.deepEqual(list.map((p) => p.id), ['deepseek', 'kimi']);
  // 预设不带默认模型名，避免猜错模型导致 404
  assert.ok(list.every((p) => p.model === ''));
  assert.equal(pickActive(list, 'deepseek'), null);

  // 预设的 Base URL 不被外部覆盖，但模型名允许存
  const withKey = mergeProviders([{ id: 'deepseek', apiKey: 'sk-1', baseURL: 'http://evil.test', model: 'deepseek-reasoner' }]);
  const ds = withKey.find((p) => p.id === 'deepseek')!;
  assert.equal(ds.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(ds.model, 'deepseek-reasoner');
  assert.equal(pickActive(withKey, 'deepseek')?.model, 'deepseek-reasoner');

  // 只填 Key 不选模型，仍然不可选
  assert.equal(pickActive(mergeProviders([{ id: 'kimi', apiKey: 'k' }]), 'kimi'), null);

  const custom = mergeProviders([{ id: 'mine', label: '自建', baseURL: 'https://a.b/v1', model: 'm', apiKey: 'k', custom: true }]);
  assert.equal(custom.at(-1)?.custom, true);
});

test('多模型：切换与删除的边界', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });

  // 没模型名不许切过去（哪怕 Key 已经填了）
  assert.throws(() => tf.setActiveProvider('deepseek'), /API Key/);
  tf.saveProvider({ id: 'deepseek', apiKey: 'sk-test' });
  assert.throws(() => tf.setActiveProvider('deepseek'), /模型/);

  // 填了模型才能选，切换后 model 跟着变
  tf.saveProvider({ id: 'deepseek', model: 'deepseek-chat' });
  assert.equal(tf.setActiveProvider('deepseek').models.active, 'deepseek');
  assert.equal(tf.state().model, 'deepseek-chat');
  // apiKey 绝不出现在给渲染层的状态里
  assert.ok(!JSON.stringify(tf.state().models).includes('sk-test'));

  // 清空 Key 会连带取消选中，避免带病运行
  const after = tf.saveProvider({ id: 'deepseek', apiKey: '' });
  assert.equal(after.models.active, null);

  // 内置服务商不能删
  assert.throws(() => tf.removeProvider('deepseek'), /内置/);

  tf.saveProvider({ id: 'mine', label: '自建', baseURL: 'https://a.b/v1', model: 'm', apiKey: 'k', custom: true });
  assert.equal(tf.removeProvider('mine').models.list.some((p) => p.id === 'mine'), false);
});

test('流式：增量按顺序拼成完整消息，工具调用也能流式还原', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });

  const client = mockClient([
    {
      role: 'assistant',
      content: '先查一下',
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'text_stats', arguments: '{"text":"abc def"}' } }],
    },
    { role: 'assistant', content: '三个词。' },
  ]);

  const deltas: string[] = [];
  const messages: any[] = [{ role: 'user', content: '数一下' }];
  const result = await runLoop({
    client,
    model: 'mock',
    messages,
    toolProvider: provider(tf),
    runTool: (n, a) => tf.runTool(n, a, 0),
    onEvent: (e) => {
      if (e.type === 'delta' && e.delta) deltas.push(e.delta);
    },
  });

  // 两轮的文本都应逐片吐出，拼起来等于原文
  assert.equal(deltas.join(''), '先查一下三个词。');
  assert.equal(result.reply, '三个词。');
  // 流式还原的 tool_calls 要能被正常消费
  assert.equal(result.steps, 2);
  assert.match(String(messages.find((m) => m.role === 'tool').content), /"words":2/);
});

test('开关能停用与恢复工具，但不能绕过用例门槛', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });
  const id = tf.state().tools.find((t) => t.name === 'text_stats')!.id;

  tf.setEnabled(id, false);
  assert.equal(tf.state().tools.find((t) => t.name === 'text_stats')?.status, 'disabled');
  // 停用后必须既不注入模型、也调不动
  assert.ok(!tf.allTools().some((t) => t.name === 'text_stats'));
  assert.equal((await tf.runTool('text_stats', { text: 'hi' })).ok, false);

  tf.setEnabled(id, true);
  assert.equal(tf.state().tools.find((t) => t.name === 'text_stats')?.status, 'active');
  assert.ok(tf.allTools().some((t) => t.name === 'text_stats'));

  // 用例未通过的工具不能被开关直接启用
  const r = await tf.runTool('create_tool', {
    name: 'never_ready',
    description: '故意让用例失败，验证开关不能绕过审核。',
    kind: 'transform',
    code: 'return 1;',
    permissions: {},
    examples: [{ args: {}, expect: 'result === 2' }],
  });
  const badId = (r.ok ? JSON.parse(String(r.result)) : {}).tool?.id;
  assert.throws(() => tf.setEnabled(badId, true), /用例/);
});

test('规格不合规时给出可读的错', () => {
  assert.throws(
    () => normalizeTool({ name: 'Bad Name', description: 'x'.repeat(20), kind: 'transform', impl: { code: '1' }, examples: [{ args: {} }] }),
    /name 不合规/
  );
  assert.throws(
    () => normalizeTool({ name: 'ok_name', description: '这是一段够长的描述文本', kind: 'transform', impl: { code: '1' }, examples: [] }),
    /examples 不可为空/
  );
});

test('同名重建会升版本并留快照，校验器跟着新 schema 走', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });
  const spec = (code: string, extra: Record<string, unknown> = {}) => ({
    name: 'version_probe',
    description: '验证同名重建升版本，以及改 schema 后校验器必须换新。',
    kind: 'transform',
    input: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
    impl: { code },
    permissions: {},
    examples: [{ args: { a: 'x' }, expect: 'result === 1' }],
    ...extra,
  });

  const first = store.save(spec('return 1;'));
  assert.equal(first.version, '0.1.0');
  // 同版本再存一次必须升到 0.1.1，否则覆盖后没有快照可回滚
  const second = store.save(spec('return 1;'));
  assert.equal(second.version, '0.1.1');
  const histDir = path.join(tmp, 'tools', 'version_probe', '.history');
  assert.equal(fs.readdirSync(histDir).length, 1, '旧版本应留一份快照');

  // 状态切换不算版本更迭，不该把版本号推上去
  const patched = store.patch('version_probe', { status: 'active' });
  assert.equal(patched.version, '0.1.1');

  // 改 schema 后，旧校验器不能继续拦新参数：换成只收 b 的 schema 就得拒收 a
  store.save({
    ...spec('return 1;'),
    input: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false },
    examples: [{ args: { b: 'x' }, expect: 'result === 1' }],
  });
  const tool = store.get('version_probe')!;
  assert.throws(() => validateArgs(tool, { a: 'x' }), /参数不合规/);
  assert.equal(validateArgs(tool, { b: 'x' }), true);
});
