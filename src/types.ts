// 全局类型。这个文件是整个系统的契约，改它之前先想清楚。

export type ToolKind = 'http' | 'transform' | 'shell' | 'script' | 'compose' | 'mcp' | 'meta';
export type ToolStatus = 'active' | 'pending' | 'untested' | 'rejected' | 'disabled';
export type TrustLevel = 'L0' | 'L1' | 'L2' | 'L3';

export type JsonSchema = Record<string, unknown>;
export type Json = Record<string, unknown>;

/** 能力声明。默认全空，宁可少给，不可多给。 */
export interface Permissions {
  net: string[];
  fsRead: string[];
  fsWrite: string[];
  exec: boolean;
  env: string[];
}

export interface ToolExample {
  name?: string;
  args: Json;
  expect?: string | null;
}

/**
 * 三方依赖声明：包名 → 精确版本号。
 *
 * 必须精确（1.2.3），不接受 ^ / ~ / * / latest / git: / file:。
 * 理由：同一件工具半年后重装，装出来的必须是同一份代码。范围版本会让
 * 「当时审过的实现」和「现在跑的实现」悄悄变成两个东西，审计结论随之失效。
 */
export type ToolDeps = Record<string, string>;

/** 实际装进来的一个包 */
export interface InstalledDep {
  name: string;
  version: string;
  /** 来自 lockfile 的 SRI，用于复现校验；取不到时为 null */
  integrity: string | null;
}

/** 落盘的依赖安装记录，写进 ToolMeta.deps，供审核面板与审计使用 */
export interface DepRecord {
  at: string;
  /** 用的哪个包管理器装的，如 npm@10.8.2 */
  manager: string;
  /** 声明的直接依赖（含解析后的确切版本） */
  packages: InstalledDep[];
  /** node_modules 总字节数 */
  totalBytes: number;
  /** 传递依赖包数，用来兜住「一个包拖进两百个包」的情况 */
  transitiveCount: number;
}

/** 各 kind 的实现字段都塞这里，字段按 kind 取用 */
export interface ToolImpl {
  // http
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  extract?: string;
  // transform / script
  code?: string | null;
  entry?: string;
  // shell
  command?: string;
  args?: string[];
  cwd?: string;
  // compose
  steps?: Array<{ tool: string; args: Json }>;
  // mcp
  server?: string;
  remoteName?: string;
  // script 专用：三方依赖声明，包名 → 精确版本。其它 kind 声明了会被 reject
  deps?: ToolDeps;
  // 公用
  timeoutMs?: number;
}

export interface TestResult {
  name: string;
  ok: boolean;
  ms: number;
  note: string;
  sample: string | null;
}

export interface Finding {
  id: string;
  level: 'high' | 'medium' | 'low';
  msg: string;
  line: number;
}

export interface LastRun {
  ok: boolean;
  ms: number;
  error: string | null;
  at: string;
}

export interface ReviewRecord {
  at: string;
  level: TrustLevel;
  reasons: string[];
  findings: Finding[];
  tests: TestResult[];
}

export interface ToolMeta {
  tags: string[];
  author: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: LastRun | null;
  review?: ReviewRecord;
  /** 依赖安装记录。只有真的装过才有；声明了依赖但没装（待审）时为空 */
  deps?: DepRecord;
}

export interface Tool {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: ToolKind;
  input: JsonSchema;
  impl: ToolImpl;
  permissions: Permissions;
  examples: ToolExample[];
  meta: ToolMeta;
  status: ToolStatus;
  trust: TrustLevel;
  sessionId: string | null;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  ms: number;
}

export interface Grade {
  level: TrustLevel;
  needsHuman: boolean;
  approved: boolean;
  reasons: string[];
}

/** 声明式工具运行时拿到的那点东西 */
export interface DeclarativeContext {
  sessionId: string | null;
  run: (name: string, args: Json) => Promise<unknown>;
}

/** 跑工具的调度上下文 */
export interface ExecuteOptions {
  sessionId?: string | null;
  depth?: number;
  runner?: ((name: string, args: Json, depth?: number) => Promise<ToolResult>) | null;
}

export interface AgentEvent {
  type: 'step' | 'assistant' | 'tool_call' | 'tool_result' | 'delta' | 'reasoning';
  step?: number;
  toolCount?: number;
  content?: string;
  name?: string;
  args?: Json;
  ok?: boolean;
  ms?: number;
  preview?: string | null;
  payload?: unknown;
  /** 流式增量：type=delta 时是本片文本，前端追加 */
  delta?: string;
  /** 推理增量：type=reasoning 时是本片思考内容，前端追加到可折叠的思考块里 */
  reasoning?: string;
}

/** 给 UI 的瘦身版 */
export interface ToolSummary {
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  kindLabel: string;
  trust: TrustLevel;
  status: ToolStatus;
  permissions: string;
  version: string;
  updatedAt: string | null;
  lastRun: LastRun | null;
  review: {
    level: TrustLevel;
    reasons: string[];
    findings: Finding[];
    tests: Array<{ name: string; ok: boolean; note: string; ms: number }>;
    at: string;
  } | null;
  source: string;
}
