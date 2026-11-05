import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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
const { pathAllowed } = await import('../src/core/permissions.js');
const { readJsonFile, getWorkspace } = await import('../src/core/paths.js');
const { buildScriptArgs } = await import('../src/executors/script.js');
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

          // 最后一帧照真实服务商的样子：choices 为空，usage 挂在顶层。
          // msg.usage 可覆盖，用来验证命中率统计。
          chunks.push({
            choices: [],
            usage: msg?.usage ?? {
              prompt_tokens: 100,
              prompt_cache_hit_tokens: 80,
              prompt_cache_miss_tokens: 20,
              completion_tokens: 7,
            },
          });

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

test('召回结果按名字定序：lastRun 提权不能改动 tools 的序列化字节', () => {
  // 前缀缓存要求 tools 数组逐字节一致。评分里带 lastRun 提权（跑过一次就 +0.5），
  // 若照评分顺序输出，同一轮里工具一跑完，下一步的 tools 就换了顺序，整段前缀失效。
  const base = [
    { name: 'bbb_tool', description: 'b', meta: { tags: [] } },
    { name: 'aaa_tool', description: 'a', meta: { tags: [] } },
    { name: 'ccc_tool', description: 'c', meta: { tags: [] } },
  ] as any[];
  const cold = selectTools(base, 'x', { limit: 3 }).map((t) => t.name);
  const warm = selectTools(
    base.map((t) => ({ ...t, meta: { ...t.meta, lastRun: { ok: true, ms: 1, at: 'now' } } })),
    'x',
    { limit: 3 }
  ).map((t) => t.name);
  assert.deepEqual(cold, ['aaa_tool', 'bbb_tool', 'ccc_tool']);
  assert.deepEqual(warm, cold);
});

test('历史只在超预算时才裁，且从问答边界起算', async () => {
  const { trimHistory } = await import('../src/index.js');
  // 短历史一条都不许丢：窗口一滑动，前缀当场对不上，每轮全量重算
  const short = [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'b' },
    { role: 'user' as const, content: 'c' },
    { role: 'assistant' as const, content: 'd' },
  ];
  assert.equal(trimHistory(short).length, 4);

  // 超预算：裁掉最老的，但落点必须是 user——不能留下「只有答句」的半轮
  const big = 'x'.repeat(9000);
  const long = [
    { role: 'user' as const, content: big },
    { role: 'assistant' as const, content: big },
    { role: 'user' as const, content: big },
    { role: 'assistant' as const, content: big },
  ];
  const kept = trimHistory(long);
  assert.ok(kept.length < 4, '超预算应裁掉最老的一轮');
  assert.equal(kept[0].role, 'user');
  assert.equal(kept.at(-1)!.content, big);
});

test('流式：usage 里的命中数被读出来（DeepSeek 与 OpenAI 两种字段名）', async () => {
  const { runLoop } = await import('../src/agent/loop.js');
  const seen: Array<{ prompt: number; hit: number; miss: number }> = [];
  const mk = (usage: Record<string, unknown>) =>
    ({
      chat: {
        completions: {
          async create() {
            return (async function* () {
              yield { choices: [{ delta: { content: '好' } }] };
              yield { choices: [], usage };
            })();
          },
        },
      },
    }) as any;

  await runLoop({
    client: mk({ prompt_tokens: 100, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10, completion_tokens: 1 }),
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    toolProvider: () => [],
    runTool: async () => ({ ok: true, result: null, ms: 0 }),
    onUsage: (u) => seen.push(u),
  });
  // OpenAI 兼容网关只给 prompt_tokens_details.cached_tokens，也得认
  await runLoop({
    client: mk({ prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 1 }),
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    toolProvider: () => [],
    runTool: async () => ({ ok: true, result: null, ms: 0 }),
    onUsage: (u) => seen.push(u),
  });

  assert.deepEqual(seen, [
    { prompt: 100, hit: 90, miss: 10, completion: 1 },
    { prompt: 50, hit: 40, miss: 10, completion: 1 },
  ]);
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

test('设置文件带 BOM 也能读，且解析失败时不覆盖用户配置', () => {
  const home = path.join(tmp, 'bom-home');
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'settings.json');
  // Windows 记事本/PowerShell 存的 UTF-8 默认带 BOM，JSON.parse 见到就炸
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ model: 'keep-me', workspace: null }), 'utf8');
  assert.equal((readJsonFile(file) as { model: string }).model, 'keep-me');

  // 真损坏时：原文要留一份备份，不能被默默抹掉（否则一次 BOM 就吃掉全部 API Key）
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const probe = `
    process.env.TOOLFORGE_HOME = ${JSON.stringify(home)};
    const { ToolForge } = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
    const tf = new ToolForge();
    await tf.init({ connectMcp: false });
    console.log(JSON.stringify({ ws: tf.state().workspace }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).ws, null);
  const backups = fs.readdirSync(home).filter((f) => f.includes('settings.json.broken-'));
  assert.equal(backups.length, 1, '损坏的配置应先留备份再重建');
  assert.match(fs.readFileSync(path.join(home, backups[0]), 'utf8'), /this is not json/);
});

test('沙箱参数只给 @workspace 开额外白名单，别让旧规则把子进程搞崩', async () => {
  const list = buildScriptArgs('--permission', {
    id: 'probe_tool',
    name: 'probe_tool',
    kind: 'script',
    permissions: { net: [], fsRead: ['**', '@workspace'], fsWrite: [], exec: false, env: [] },
  } as never);
  const ws = getWorkspace();
  // 工具目录永远放行
  assert.ok(list.some((a) => a.startsWith('--allow-fs-read=') && a.includes('probe_tool')));
  // @workspace 解析成真实目录后放行
  if (ws) assert.ok(list.some((a) => a === `--allow-fs-read=${ws}`), '应放行工作目录');
  // 关键：不能把 "**" 当成真实路径塞进去，那会让 Node 起不来
  assert.ok(!list.some((a) => a.includes('**')), '通配规则不该进 OS 白名单');

  // 没有 @workspace 声明的工具，不该多出任何白名单项（runtime-child 与工具目录是固定项）
  const plain = buildScriptArgs('--permission', {
    id: 'plain_tool',
    name: 'plain_tool',
    kind: 'script',
    permissions: { net: [], fsRead: ['notes'], fsWrite: ['notes'], exec: false, env: [] },
  } as never);
  const extra = plain.filter(
    (a) => a.startsWith('--allow-fs-') && !a.includes('plain_tool') && !a.includes('runtime-child')
  );
  assert.equal(extra.length, 0, `非 @workspace 规则不该加白名单：${extra.join(' ')}`);
});

test('沙箱：同时声明 ** 与 @workspace 时，两边的相对路径都能解析', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });
  const proj = path.join(tmp, 'proj3');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'pkg.json'), '{"v":"1.0.0"}');
  tf.setWorkspace(proj);

  // 这条复刻线上真实崩过的组合：fsRead 同时含 "**" 和 "@workspace"
  const r = await tf.runTool('create_tool', {
    name: 'dual_root_read',
    description: '同时声明通配与工作目录，验证两种相对路径都解析得到。',
    kind: 'script',
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    code: `module.exports = async (i, ctx) => ({ text: ctx.fs.read(i.path) });`,
    permissions: { fsRead: ['**', '@workspace'] },
    examples: [{ name: '读项目文件', args: { path: 'pkg.json' }, expect: 'result.text.includes("1.0.0")' }],
  });
  const out = r.ok ? JSON.parse(String(r.result)) : {};
  assert.equal(out.ok, true, JSON.stringify(out.tests?.details?.[0]?.note || out));
  assert.equal(out.tool?.status, 'active');
});

test('chat 逐轮传 workspace：每次都能覆盖全局状态，不同任务互不串味', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });
  const a = path.join(tmp, 'ws_a');
  const b = path.join(tmp, 'ws_b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });

  // 不真的调模型：只验证 chat 开头的 workspace 落地逻辑，
  // 所以塞一个会立刻抛错的假客户端，抛错前 workspace 已经被设置。
  const probe = async (ws: string | null | undefined) => {
    try {
      await tf.chat({ input: 'x', workspace: ws, history: [] });
    } catch {
      /* 没配模型必然抛错，我们只关心 workspace 是否已生效 */
    }
    return getWorkspace();
  };

  // 具体目录 → 生效为绝对路径
  assert.equal(await probe(a), path.resolve(a));
  // 换一个目录 → 必须跟着换，不能留在上一次
  assert.equal(await probe(b), path.resolve(b));
  // 'general' 与 null 语义相同：不绑定目录
  assert.equal(await probe(null), null);
  assert.equal(await probe(a), path.resolve(a));
  // undefined 表示沿用当前设置，不该被清空
  assert.equal(await probe(undefined), path.resolve(a));
});

test('工作目录：只能存在真实目录，且 @workspace 权限只放行目录内的路径', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });
  // workspace 是模块级单例，上一条测试可能留下值；这里显式归零保证隔离
  tf.setWorkspace(null);

  // 没选目录时 state 报告 null，而不是空字符串之类的模糊值
  assert.equal(tf.state().workspace, null);

  // 选一个不存在的路径必须报错，不能存进去等工具跑到一半才崩
  assert.throws(() => tf.setWorkspace(path.join(tmp, 'no-such-dir')), /目录不存在/);
  // 指向文件也不行
  const aFile = path.join(tmp, 'a-file.txt');
  fs.writeFileSync(aFile, 'x');
  assert.throws(() => tf.setWorkspace(aFile), /不是目录/);

  // 正常选择后 state 能读到绝对路径
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  assert.equal(tf.setWorkspace(proj).workspace, path.resolve(proj));

  // 权限判定：@workspace 只覆盖目录内
  const inside = path.join(proj, 'src', 'a.ts');
  const outside = path.join(tmp, 'elsewhere.txt');
  assert.equal(pathAllowed(inside, ['@workspace'], 'any_tool'), true);
  assert.equal(pathAllowed(outside, ['@workspace'], 'any_tool'), false);
  // 没有声明就一律拒绝
  assert.equal(pathAllowed(inside, [], 'any_tool'), false);

  // 清除后立刻失效，不能留一个还认得的缓存
  tf.setWorkspace(null);
  assert.equal(tf.state().workspace, null);
  assert.equal(pathAllowed(inside, ['@workspace'], 'any_tool'), false);
});

test('工作目录：写 @workspace 判 L2 转人工，只读判 L1 自动放行', async () => {
  const tf = new ToolForge();
  await tf.init({ connectMcp: false });
  tf.setWorkspace(null);
  const proj = path.join(tmp, 'proj2');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'hello.txt'), 'hi');
  tf.setWorkspace(proj);

  const r = await tf.runTool('create_tool', {
    name: 'read_project_file',
    description: '读取工作目录里的一个文件，用于验证 @workspace 只读权限定级。',
    kind: 'script',
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    code: `module.exports = async (input, ctx) => {
  if (!ctx.workspace) throw new Error('no workspace');
  return { text: ctx.fs.read(input.path), ws: ctx.workspace };
};`,
    permissions: { fsRead: ['@workspace'] },
    examples: [{ name: '读自己的项目文件', args: { path: 'hello.txt' }, expect: 'typeof result.text === "string"' }],
  });
  const readOut = r.ok ? JSON.parse(String(r.result)) : {};
  // 只读工作目录属于 L1，自动放行；用例要能通过才算数
  assert.equal(readOut.tool?.trust, 'L1', JSON.stringify(readOut.review));
  assert.equal(readOut.tool?.status, 'active');

  const w = await tf.runTool('create_tool', {
    name: 'write_project_file',
    description: '往工作目录里写文件，用于验证 @workspace 写权限必须转人工。',
    kind: 'script',
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    code: `module.exports = async (input, ctx) => {
  ctx.fs.write(input.path, 'x');
  return { ok: true };
};`,
    permissions: { fsWrite: ['@workspace'] },
    examples: [{ name: '写一个文件', args: { path: 'out.txt' }, expect: 'result.ok === true' }],
  });
  const wOut = w.ok ? JSON.parse(String(w.result)) : {};
  assert.equal(wOut.tool?.trust, 'L2', JSON.stringify(wOut.review));
  assert.equal(wOut.tool?.status, 'pending');
  assert.ok(
    (wOut.review?.reasons || []).some((x: string) => x.includes('工作目录')),
    '定级理由要写明会改动用户项目'
  );
});
