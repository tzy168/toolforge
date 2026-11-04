// 工具规格：整个系统的地基。规格定歪了，后面全歪。
import type {
  DepRecord,
  JsonSchema,
  Permissions,
  Tool,
  ToolDeps,
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
 * 校准依赖安装记录。它是「机器实测」的产物而不是用户声明，缺字段就当没记过，
 * 不要因为一份旧记录格式对不上就把整件工具判成损坏。
 */
function normalizeDepRecord(raw: unknown): DepRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DepRecord>;
  if (typeof r.at !== 'string' || !Array.isArray(r.packages)) return null;
  return {
    at: r.at,
    manager: typeof r.manager === 'string' ? r.manager : 'unknown',
    packages: r.packages
      .filter((p): p is DepRecord['packages'][number] => Boolean(p) && typeof p === 'object' && typeof p.name === 'string')
      .map((p) => ({
        name: p.name,
        version: String(p.version ?? ''),
        integrity: typeof p.integrity === 'string' ? p.integrity : null,
      })),
    totalBytes: Number(r.totalBytes) || 0,
    transitiveCount: Number(r.transitiveCount) || 0,
  };
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
  const depRecord = normalizeDepRecord(raw.meta?.deps);
  if (depRecord) meta.deps = depRecord;

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

/** 直接依赖数量上限。超过这个量级说明该换 MCP 了，沙箱装不下也不该装 */
export const MAX_DEPS = 20;

// npm 包名：允许 @scope/name，全小写，不允许路径符号
const DEP_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// 精确版本：1.2.3，可带预发布/构建后缀。不含任何范围符号
const DEP_EXACT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 校验依赖声明。这里挡掉的每一类都是「装的时候看着没事、两年后害人」的东西：
 * 范围版本（不可复现）、git/file 协议（可指向任意代码）、超大依赖集（供应链面爆炸）。
 */
export function normalizeDeps(raw: unknown): ToolDeps {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('deps 不合规：须为 {包名: "精确版本"} 对象，如 {"dayjs": "1.11.13"}');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DEPS) {
    throw new Error(
      `deps 过多：最多 ${MAX_DEPS} 个直接依赖（现声明 ${entries.length}）。更重的依赖请改走 MCP 服务器，别塞进沙箱`
    );
  }
  const out: ToolDeps = {};
  for (const [name, ver] of entries) {
    const n = String(name).trim();
    if (!DEP_NAME_RE.test(n)) {
      throw new Error(`deps 包名不合规：${name}（须为合法 npm 包名，允许 @scope/name；不允许路径或 git 地址）`);
    }
    const v = String(ver ?? '').trim();
    if (!DEP_EXACT_RE.test(v)) {
      throw new Error(
        `deps 版本必须精确：${n} 声明的是 "${v}"。只接受 1.2.3 这种确切版本，` +
          '不接受 ^ / ~ / * / latest / git: / file: / http:——否则同一件工具以后装出来是另一份代码，审计结论失效'
      );
    }
    out[n] = v;
  }
  return out;
}

function normalizeImpl(kind: ToolKind, impl: ToolImpl | undefined, name = ''): ToolImpl {
  const i: ToolImpl = impl && typeof impl === 'object' ? impl : {};
  // 依赖只在沙箱子进程里能被 require 到；别的 kind 声明它只会让人误以为装得上
  if (kind !== 'script' && i.deps && Object.keys(i.deps).length > 0) {
    throw new Error(
      `kind=${kind} 不支持 impl.deps：只有 script 类工具能声明三方依赖（http/transform/shell/compose 由宿主直接执行，没有 node_modules 可 require）`
    );
  }
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
        // 依赖声明落在 impl 里，会随 tool.json 一起持久化，导出 pack 时也要带上
        deps: normalizeDeps(i.deps),
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
