// 工具规格：整个系统的地基。规格定歪了，后面全歪。
import type {
  JsonSchema,
  Permissions,
  Tool,
  ToolExample,
  ToolImpl,
  ToolKind,
  ToolMeta,
  ToolStatus,
  TrustLevel,
} from '../types.js';

export const KINDS: ToolKind[] = ['http', 'transform', 'shell', 'script', 'compose', 'mcp'];
export const STATUSES: ToolStatus[] = ['active', 'pending', 'untested', 'rejected', 'disabled'];
export const TRUST_LEVELS: TrustLevel[] = ['L0', 'L1', 'L2', 'L3'];

export const KIND_LABEL: Record<string, string> = {
  http: '声明式 · HTTP 取数',
  transform: '声明式 · 纯函数变换',
  shell: '声明式 · 命令模板',
  compose: '声明式 · 组合其他工具',
  script: '代码 · 沙箱子进程',
  mcp: '外部 · MCP 服务器',
  meta: '内核 · 元工具',
};

/** 外部传进来、还没校验的原始规格 */
export interface RawTool {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  kind?: string;
  input?: JsonSchema;
  impl?: ToolImpl;
  permissions?: Partial<Permissions>;
  examples?: Array<Partial<ToolExample>>;
  meta?: Partial<ToolMeta>;
  status?: string;
  trust?: string;
  sessionId?: string | null;
}

export function emptyPermissions(): Permissions {
  return { net: [], fsRead: [], fsWrite: [], exec: false, env: [] };
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  }
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function normalizePermissions(raw: Partial<Permissions> = {}): Permissions {
  const p = emptyPermissions();
  p.net = asArray(raw.net).map(
    (h) =>
      h
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0] ?? ''
  );
  p.fsRead = asArray(raw.fsRead);
  p.fsWrite = asArray(raw.fsWrite);
  p.env = asArray(raw.env);
  p.exec = raw.exec === true;
  return p;
}

function normalizeExamples(raw: unknown): ToolExample[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
    .map((e, i) => ({
      name: typeof e.name === 'string' ? e.name : `用例 ${i + 1}`,
      args: (e.args && typeof e.args === 'object' ? e.args : {}) as ToolExample['args'],
      expect: typeof e.expect === 'string' ? e.expect : null,
    }));
}

/**
 * 把任意输入捏成规范的工具对象。不改原对象，返回新对象。
 * 不合规时抛错，错误信息直接回灌给模型，便于它自己改。
 */
export function normalizeTool(raw: RawTool = {}): Tool {
  const name = String(raw.name || raw.id || '').trim();
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(name)) {
    throw new Error('name 不合规：须小写字母开头，仅含小写字母、数字、下划线，长度 2~50');
  }
  const description = String(raw.description || '').trim();
  if (description.length < 8) {
    throw new Error('description 太短：模型靠它判断何时该用此工具，至少写清「做什么、返回什么」');
  }
  const kind = String(raw.kind || '').trim();
  if (!KINDS.includes(kind as ToolKind)) {
    throw new Error(`kind 不合规：须为 ${KINDS.join(' / ')} 之一`);
  }

  const input: JsonSchema =
    raw.input && typeof raw.input === 'object'
      ? { type: 'object', properties: {}, additionalProperties: false, ...raw.input }
      : { type: 'object', properties: {}, additionalProperties: false };

  const impl = normalizeImpl(kind as ToolKind, raw.impl, name);
  const permissions = normalizePermissions(raw.permissions);
  const examples = normalizeExamples(raw.examples);

  if (examples.length === 0) {
    throw new Error('examples 不可为空：至少给一条 {args, expect}，无断言用例的工具不许入库');
  }

  const meta: ToolMeta = {
    tags: asArray(raw.meta?.tags),
    author: raw.meta?.author || 'agent',
    source: raw.meta?.source || 'user',
    createdAt: raw.meta?.createdAt || new Date().toISOString(),
    updatedAt: raw.meta?.updatedAt || new Date().toISOString(),
    lastRun: raw.meta?.lastRun ?? null,
  };
  if (raw.meta?.review) meta.review = raw.meta.review;

  return {
    id: raw.id || name,
    name,
    version: String(raw.version || '0.1.0'),
    description,
    kind: kind as ToolKind,
    input,
    impl,
    permissions,
    examples,
    meta,
    status: STATUSES.includes(raw.status as ToolStatus) ? (raw.status as ToolStatus) : 'untested',
    trust: TRUST_LEVELS.includes(raw.trust as TrustLevel) ? (raw.trust as TrustLevel) : 'L3',
    sessionId: raw.sessionId ?? null,
  };
}

function normalizeImpl(kind: ToolKind, impl: ToolImpl | undefined, name = ''): ToolImpl {
  const i: ToolImpl = impl && typeof impl === 'object' ? impl : {};
  switch (kind) {
    case 'http': {
      if (!i.url) throw new Error('http 工具缺少 impl.url');
      return {
        method: String(i.method || 'GET').toUpperCase(),
        url: String(i.url),
        headers: i.headers && typeof i.headers === 'object' ? i.headers : {},
        query: i.query && typeof i.query === 'object' ? i.query : {},
        body: i.body ?? null,
        extract: typeof i.extract === 'string' ? i.extract : '',
        timeoutMs: Number(i.timeoutMs) || 20000,
      };
    }
    case 'transform': {
      if (!i.code || typeof i.code !== 'string') {
        throw new Error('transform 工具缺少 impl.code（一段以 input 为入参、返回结果的 JS）');
      }
      return { code: i.code, timeoutMs: Number(i.timeoutMs) || 3000 };
    }
    case 'shell': {
      if (!i.command) throw new Error('shell 工具缺少 impl.command');
      return {
        command: String(i.command),
        args: Array.isArray(i.args) ? i.args.map(String) : [],
        cwd: typeof i.cwd === 'string' ? i.cwd : '',
        timeoutMs: Number(i.timeoutMs) || 30000,
      };
    }
    case 'script': {
      return {
        entry: `${name || 'tool'}.cjs`,
        code: typeof i.code === 'string' ? i.code : null,
        timeoutMs: Number(i.timeoutMs) || 30000,
      };
    }
    case 'compose': {
      const steps = Array.isArray(i.steps) ? i.steps : [];
      if (steps.length === 0) throw new Error('compose 工具至少要一步 steps');
      return {
        steps: steps.map((s) => ({
          tool: String(s.tool || ''),
          args: (s.args && typeof s.args === 'object' ? s.args : {}) as ToolExample['args'],
        })),
      };
    }
    case 'mcp': {
      if (!i.server) throw new Error('mcp 工具缺少 impl.server');
      return { server: String(i.server), remoteName: String(i.remoteName || name) };
    }
    default:
      return i;
  }
}

/** 转成 OpenAI function calling 的格式 */
export function toOpenAITool(tool: Tool): {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
} {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input,
    },
  };
}

/** 人类可读的权限摘要，UI 与审核界面都用它 */
export function describePermissions(p: Partial<Permissions> = {}): string {
  const parts: string[] = [];
  if (p.net?.length) parts.push(`网络 ${p.net.join(', ')}`);
  if (p.fsRead?.length) parts.push(`读 ${p.fsRead.join(', ')}`);
  if (p.fsWrite?.length) parts.push(`写 ${p.fsWrite.join(', ')}`);
  if (p.exec) parts.push('执行外部命令');
  if (p.env?.length) parts.push(`读环境变量 ${p.env.join(', ')}`);
  return parts.length ? parts.join('；') : '无任何权限';
}
