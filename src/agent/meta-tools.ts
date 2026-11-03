import { store } from '../core/store.js';
import { normalizeTool, describePermissions, type RawTool } from '../core/spec.js';
import { selectTools, indexOf } from '../core/retrieve.js';
import { staticScan, grade, runExamples } from '../core/review.js';
import { executeTool } from '../core/bus.js';
import * as audit from '../core/audit.js';
import type { Json, JsonSchema, Tool, ToolImpl, ToolResult, Permissions } from '../types.js';

// 元工具：Agent 用来「看仓库、找工具、造工具」的那几件。
// 它们本身就是 Tool —— 所以核心循环永远不必为「自我扩展」改动。

export interface MetaContext {
  sessionId: string | null;
  allTools: () => Tool[];
  runTool: (name: string, args: Json, depth?: number) => Promise<ToolResult>;
}

export interface MetaDef {
  name: string;
  description: string;
  input: JsonSchema;
  handler: (args: Json, ctx: MetaContext) => Promise<string>;
}

const createToolSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '工具名，小写字母开头，仅含小写字母/数字/下划线，如 fetch_weather' },
    description: { type: 'string', description: '一句话说清「做什么、返回什么」，模型靠它判断何时调用' },
    kind: { type: 'string', enum: ['http', 'transform', 'compose', 'script', 'shell'], description: '实现方式，声明式优先' },
    input: { type: 'object', description: '入参的 JSON Schema，通常 {type:"object",properties:{...},required:[...]}' },
    code: { type: 'string', description: 'kind=transform 或 script 时的实现代码' },
    http: {
      type: 'object',
      description: 'kind=http 时的配置',
      properties: {
        method: { type: 'string' },
        url: { type: 'string', description: '可用 {{input.xxx}} 占位' },
        headers: { type: 'object' },
        query: { type: 'object' },
        body: { type: 'object' },
        extract: { type: 'string', description: '从响应取值的路径，如 data.items[0]' },
      },
    },
    shell: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
    },
    steps: {
      type: 'array',
      description: 'kind=compose 时的步骤，形如 [{tool:"other_tool", args:{...}}]',
      items: { type: 'object' },
    },
    permissions: {
      type: 'object',
      description: '能力声明，默认全空。宁可少给，不可多给。',
      properties: {
        net: { type: 'array', items: { type: 'string' }, description: '允许访问的域名，如 ["api.github.com"]' },
        fsRead: { type: 'array', items: { type: 'string' }, description: '允许读的路径（相对工具目录）' },
        fsWrite: { type: 'array', items: { type: 'string' } },
        env: { type: 'array', items: { type: 'string' }, description: '允许读的环境变量名' },
        exec: { type: 'boolean' },
      },
    },
    examples: {
      type: 'array',
      description: '至少一条。expect 是布尔表达式，可用变量 result',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'object' },
          expect: { type: 'string' },
        },
        required: ['args'],
      },
    },
  },
  required: ['name', 'description', 'kind', 'examples'],
};

export const metaToolDefs: MetaDef[] = [
  {
    name: 'list_tools',
    description: '列出当前可用的全部工具（名称、类型、信任等级、状态、一句话说明）。不确定有什么能力时先调它。',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const all = ctx.allTools();
      return JSON.stringify({
        total: all.length,
        tools: all.map((t) => ({
          name: t.name,
          kind: t.kind,
          trust: t.trust,
          status: t.status,
          description: t.description.slice(0, 80),
        })),
      });
    },
  },
  {
    name: 'tool_search',
    description: '按任务描述语义检索工具。仓库里工具很多时用它，比 list_tools 省 token。',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '任务描述或关键词' },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const all = ctx.allTools();
      const picked = selectTools(all, String(args.query ?? ''), { limit: Math.min(Number(args.limit) || 8, 20) });
      return JSON.stringify({ total: all.length, matched: indexOf(picked) });
    },
  },
  {
    name: 'create_tool',
    description:
      '造一件新工具。工具会立刻入库并跑自带用例：用例不过则退回让你修；过了按权限定级，低危自动放行、高危转人工审核。未放行前只有本次会话能用。',
    input: createToolSchema,
    async handler(args, ctx) {
      return createTool(args, ctx);
    },
  },
];

function buildImpl(args: Json): ToolImpl {
  const kind = String(args.kind ?? '');
  switch (kind) {
    case 'http':
      return { ...((args.http as ToolImpl) || {}) };
    case 'transform':
      return { code: String(args.code ?? '') };
    case 'script':
      return { code: String(args.code ?? '') };
    case 'compose':
      return { steps: (args.steps as ToolImpl['steps']) || [] };
    case 'shell':
      return { ...((args.shell as ToolImpl) || {}) };
    default:
      return {};
  }
}

async function createTool(args: Json, ctx: MetaContext): Promise<string> {
  let tool: Tool;
  try {
    tool = normalizeTool({
      name: args.name as string,
      description: args.description as string,
      kind: args.kind as string,
      input: args.input as JsonSchema | undefined,
      impl: buildImpl(args),
      permissions: args.permissions as Partial<Permissions> | undefined,
      examples: args.examples as RawTool['examples'],
      status: 'untested',
      sessionId: ctx.sessionId,
      meta: { author: 'agent', source: 'agent', tags: [] },
    });
  } catch (err) {
    audit.append({ type: 'create_tool', stage: 'spec', ok: false, error: (err as Error).message, tool: String(args.name) });
    return JSON.stringify({ ok: false, stage: 'spec', error: (err as Error).message, hint: '按提示改规格，再调一次 create_tool' });
  }

  store.save(tool);
  audit.append({ type: 'create_tool', stage: 'saved', ok: true, tool: tool.name, kind: tool.kind });

  // 1) 静态扫描（只扫代码类）
  const code = tool.impl.code ?? '';
  const findings = code ? staticScan(code) : [];

  // 2) 跑自带用例
  const runner = async (t: Tool, a: Json): Promise<unknown> => {
    const r = await executeTool(t, a, { sessionId: ctx.sessionId, runner: ctx.runTool });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  const tests = await runExamples(tool, runner);

  // 3) 定级 + 定状态
  const g = grade(tool, findings);
  const status = !tests.ok ? 'untested' : g.approved ? 'active' : 'pending';
  store.patch(tool.id, {
    status,
    trust: g.level,
    meta: {
      review: {
        at: new Date().toISOString(),
        level: g.level,
        reasons: g.reasons,
        findings,
        tests: tests.results,
      },
    },
  });

  audit.append({
    type: 'review',
    tool: tool.name,
    trust: g.level,
    status,
    testsOk: tests.ok,
    needsHuman: g.needsHuman,
    findings: findings.length,
  });

  const payload: Record<string, unknown> = {
    ok: tests.ok,
    tool: { id: tool.id, name: tool.name, kind: tool.kind, trust: g.level, status },
    permissions: describePermissions(tool.permissions),
    tests: { passed: tests.ok, details: tests.results },
    review: { level: g.level, needsHuman: g.needsHuman, reasons: g.reasons, findings },
  };

  if (!tests.ok) {
    payload.stage = 'test';
    payload.hint = '用例没过。读 details 里的 note，改 code 或改 examples 后重新调 create_tool（同名会覆盖并升版本）。';
  } else if (g.needsHuman) {
    payload.hint = '需人工放行。在放行前，本次会话内仍可正常调用它。';
  } else {
    payload.hint = '已自动放行，可直接调用，也已进入常驻工具池。';
  }
  return JSON.stringify(payload);
}

export function findMetaTool(name: string): MetaDef | null {
  return metaToolDefs.find((t) => t.name === name) ?? null;
}
