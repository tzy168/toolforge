import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDirs, getWorkspace, readJsonFile, setWorkspaceDir } from './core/paths.js';
import { store } from './core/store.js';
import { executeTool } from './core/bus.js';
import { selectTools } from './core/retrieve.js';
import { toOpenAITool, describePermissions, KIND_LABEL, type RawTool } from './core/spec.js';
import { installSeeds } from './core/seed.js';
import { metaToolDefs, findMetaTool } from './agent/meta-tools.js';
import { buildSystemMessages, META_TOOL_NAMES, type Phase, type ChatMessage } from './agent/prompts.js';
import { runLoop, createClient, type ToolBundle } from './agent/loop.js';
import { planSharedDeps, readDepPolicy } from './core/deps.js';
import {
  filterTools, getAccessLevel, hiddenToolNames, metaDenied, normalizeAccess,
  setAccessLevel as setGlobalAccessLevel,
} from './core/policy.js';
import { cancelAll, pendingApprovals, resolveApproval, setApprovalEmitter, setApprovalResponder } from './core/approval.js';
import { permissionSupport } from './executors/script.js';
import { mcp } from './mcp/client.js';
import { exportPack, savePack, importPack, readPackFile, type Pack, type ImportResult } from './core/pack.js';
import { mergeProviders, pickActive, toView, fetchModelIds, type ModelProvider, type ProviderView } from './core/models.js';
import * as audit from './core/audit.js';
import type { AccessLevel, AgentEvent, ApprovalDecision, ApprovalRequest, Json, Tool, ToolResult, ToolSummary } from './types.js';
import type OpenAI from 'openai';

export interface Settings {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  /** 多模型配置：只存用户填过的字段，预设的定义在 core/models.ts */
  providers?: Array<Partial<ModelProvider>>;
  activeProvider?: string | null;
  /** Work 模式下选中的项目目录，重启后恢复 */
  workspace?: string | null;
  /** 单轮对话的步数上限；不填用 DEFAULT_MAX_STEPS，填了也会被 MAX_STEPS_CAP 封顶 */
  maxSteps?: number;
  /**
   * 是否允许联网安装白名单外的三方依赖。默认 false。
   *
   * 打开它意味着「registry 上的代码可以进到本机并被执行（跑用例）」，
   * 所以只能由用户在设置页显式点一次，绝不能由 agent 自己改。
   */
  allowUnvettedDeps?: boolean;
  /** 访问档位。老配置没这个字段时按 full 处理，见 core/policy.ts */
  access?: AccessLevel;
}

export interface ForgeState {
  home: string;
  model: string;
  models: { list: ProviderView[]; active: string | null };
  /** 当前工作目录；null 表示还没选 */
  workspace: string | null;
  sessionId: string;
  /** 此刻真正能用的工具数（元工具 + 已放行 + 本会话临时可用 + MCP），界面别自己数 */
  toolCount: number;
  tools: ToolSummary[];
  pending: ToolSummary[];
  broken: Array<{ id: string; error: string }>;
  mcp: { available: boolean; status: Record<string, string>; count: number };
  /** 脚本沙箱的 OS 级隔离是否真的能用。probed=false 表示还没跑过脚本工具，不能声称已启用 */
  sandbox: { probed: boolean; flag: string | null };
  /** 三方依赖策略：界面据此展示「能不能联网装」与白名单内容 */
  depPolicy: { allowUnvettedDeps: boolean; origin: string; sharedDepsRoot: string | null; whitelist: string[] };
  /** 当前访问档位与还挂着的人工确认请求 */
  access: { level: AccessLevel; pending: ApprovalRequest[] };
  audit: audit.AuditEvent[];
}

export interface ChatResult {
  reply: string;
  steps: number;
  ok: boolean;
  sessionId: string;
  /** true 表示用户主动暂停，不是出错 */
  aborted?: boolean;
  /** 本轮累计的 token 用量与缓存命中，CLI / 界面用它显示命中率 */
  usage?: { prompt: number; hit: number; miss: number; completion: number };
}

/**
 * 历史保留多少字符（一问一答合计）。
 *
 * 缓存是「从第 0 个 token 起逐字节相同」才算命中，所以历史只要还在预算内就整段留着——
 * 每轮追加一点点，前缀就一直是上一轮的延长线，历史部分全命中。
 * 原来固定 `slice(-8)`：从第 5 轮起窗口每轮整体前移一格，前缀当场对不上，
 * 8 条历史每轮重新 prefill 一遍。
 */
const HISTORY_CHAR_BUDGET = 20000;

/**
 * 空正文历史消息的占位。
 *
 * 模型被截断或只想了没说时，那一轮会以空正文落进 history。原样发回服务端，
 * 会直接 400：`role='assistant'` 的消息不允许为空。
 * 补一句占位而不是把它丢掉——丢掉会让两条 user 相邻，严格些的服务商同样不接受。
 */
const EMPTY_TURN_NOTE = '（这一轮模型没有返回正文）';

/**
 * 只裁「真放不下」的那部分。
 *
 * 从后往前累计，超出预算就停；落点再往前挪到最近的一条 user，
 * 别让模型看到「只有答句、没有问句」的半轮。
 *
 * 这里是「历史 → 请求」的唯一出口，所以「不能发空消息」也收在这里管。
 * 上层怎么存是它的事，发出去之前一定得是合法的。
 */
export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  const rows = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      return { ...m, content: text.trim() ? text : EMPTY_TURN_NOTE };
    });
  let used = 0;
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = String(rows[i].content).length;
    if (used + cost > HISTORY_CHAR_BUDGET) break;
    used += cost;
    start = i;
  }
  while (start < rows.length && rows[start].role !== 'user') start += 1;
  return rows.slice(start);
}

/**
 * 单轮对话的步数上限。
 *
 * 复杂任务常常要连着造好几件工具、再串起来跑，16 步很容易不够——用户看到的
 * 就是「任务还没收束」。30 步在干正经活（读几个文件 → 改一遍 → 跑起来验）时
 * 也还是会撞顶，60 步碰上跨十几个文件的重构同样偏紧；而撞顶就得让用户重来一遍，
 * 比多跑几步的代价大得多。
 *
 * 120 步是权衡：一轮里走完「摸清结构 → 改一串文件 → 跑测试 → 按报错再改几轮」
 * 都在预算内，真跑飞了还有暂停按钮兜底，而且每步都得模型自己决定要不要继续，
 * 不会闷头空转。
 *
 * 还嫌不够时不必改代码：settings.json 里加 `maxSteps`，或用环境变量
 * TOOLFORGE_MAX_STEPS 临时压过（环境变量优先）。无论怎么填都封顶在 MAX_STEPS_CAP，
 * 免得一个误配变成无限循环。
 */
const DEFAULT_MAX_STEPS = 120;
/** 硬上限：settings.json / 环境变量填得再大也不越过这个值 */
const MAX_STEPS_CAP = 500;

/**
 * 单轮真正生效的步数上限：环境变量 > settings.json > 默认值。
 * 填了非法值（负数、NaN、0）就当没填——不要因为一个笔误把任务卡死在第一步。
 */
function resolveMaxSteps(settings: Settings): number {
  const raw = process.env.TOOLFORGE_MAX_STEPS ?? settings.maxSteps;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_STEPS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_STEPS;
  return Math.min(n, MAX_STEPS_CAP);
}

function loadSettings(): Settings {
  try {
    return readJsonFile(dirs.settings) as Settings;
  } catch {
    ensureDirs();
    // 文件存在但解析不了，先把原文挪到旁边再重建。
    // 直接覆盖会把用户的 API Key 和模型配置一次性抹掉，而这个错误往往只是多了个 BOM。
    if (fs.existsSync(dirs.settings)) {
      try {
        fs.renameSync(dirs.settings, `${dirs.settings}.broken-${Date.now()}`);
      } catch {
        /* 备份失败也不能拦着开机 */
      }
    }
    fs.writeFileSync(
      dirs.settings,
      JSON.stringify(
        {
          providers: [],
          activeProvider: null,
          _说明: '在设置页填好 DeepSeek / Kimi 的 API Key 即可；自定义服务商需同时填 Base URL 与模型名',
        },
        null,
        2
      ),
      'utf8'
    );
    return {};
  }
}

function metaAsTool(
  name: string,
  description: string,
  input: Record<string, unknown>,
  trust: Tool['trust'] = 'L0'
): Tool {
  return {
    id: `meta:${name}`,
    name,
    version: '—',
    description,
    kind: 'meta',
    input,
    impl: {},
    permissions: { net: [], fsRead: [], fsWrite: [], exec: false, env: [] },
    examples: [{ args: {}, expect: null }],
    meta: {
      tags: ['meta'],
      author: 'core',
      source: 'core',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    status: 'active',
    trust,
    sessionId: null,
  };
}

function summarize(t: Tool): ToolSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    kind: t.kind,
    kindLabel: KIND_LABEL[t.kind] || t.kind,
    trust: t.trust,
    status: t.status,
    permissions: describePermissions(t.permissions),
    version: t.version,
    updatedAt: t.meta?.updatedAt ?? null,
    lastRun: t.meta?.lastRun ?? null,
    review: t.meta?.review
      ? {
          level: t.meta.review.level,
          reasons: t.meta.review.reasons,
          findings: t.meta.review.findings,
          tests: (t.meta.review.tests || []).map((r) => ({ name: r.name, ok: r.ok, note: r.note, ms: r.ms })),
          at: t.meta.review.at,
        }
      : null,
    source: t.meta?.source || 'unknown',
    deps: describeDeps(t),
  };
}

/**
 * 把一件工具的依赖状况整理成界面能直接用的形状。
 *
 * missing 的语义要小心区分：plan 为 null 表示「本机压根没有白名单目录」（开发态未构建），
 * 此时不能声称「这些包不在白名单里」——那会让人去改 shared-deps.json 白折腾。
 */
function describeDeps(t: Tool): ToolSummary['deps'] {
  const declared = t.impl?.deps ?? {};
  const names = Object.keys(declared);
  const pool = readDepPolicy();
  const plan = names.length ? planSharedDeps(t) : null;
  return {
    declared,
    installed: t.meta?.deps ?? null,
    missing: !names.length ? [] : plan ? plan.missing : names,
    whitelistRoot: pool.sharedDepsRoot,
  };
}

export class ToolForge {
  onEvent: (event: AgentEvent) => void;
  sessionId: string;
  settings: Settings;
  seeded: string[] = [];
  private _client: OpenAI | null = null;
  private _clientId: string | null = null;
  /** 当前这一轮的中止控制器。AbortSignal 用过就废，每轮 chat 开始都要新建一个 */
  private _abort = new AbortController();

  constructor({
    onEvent,
    approvalResponder,
  }: {
    onEvent?: (event: AgentEvent) => void;
    /** 非交互环境注入自动应答；桌面端不传，走界面弹确认 */
    approvalResponder?: (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
  } = {}) {
    ensureDirs();
    this.onEvent = onEvent ?? (() => {});
    this.sessionId = `s_${Date.now().toString(36)}`;
    this.settings = loadSettings();
    // 授权事件沿 AgentEvent 走 IPC 到界面；responder 只给 CLI 与测试用
    setApprovalEmitter((event) => this.onEvent(event));
    setApprovalResponder(approvalResponder ?? null);
  }

  async init({ connectMcp = true }: { connectMcp?: boolean } = {}): Promise<this> {
    this.seeded = installSeeds();
    setGlobalAccessLevel(this.settings.access);
    // 恢复上次选的工作目录。目录可能已被删掉或挪走，那就当没选，
    // 而不是留一个指向虚空的路径让工具跑到一半才崩。
    const saved = this.settings.workspace;
    if (saved) {
      try {
        if (fs.statSync(saved).isDirectory()) setWorkspaceDir(saved);
        else this.settings.workspace = null;
      } catch {
        this.settings.workspace = null;
      }
    }
    if (connectMcp) await mcp.init();
    return this;
  }

  /** 全部服务商（预设在前），API Key 只在主进程里，不出渲染层 */
  providers(): ModelProvider[] {
    return mergeProviders(this.settings.providers);
  }

  /** 当前生效的服务商；没配 Key 或没选模型都算未配置 */
  activeProvider(): ModelProvider | null {
    return pickActive(this.providers(), this.settings.activeProvider);
  }

  get model(): string {
    // 环境变量优先，便于 CI / 命令行临时指定；否则用选中服务商的模型名
    return process.env.OPENAI_MODEL || this.activeProvider()?.model || '未配置模型';
  }

  get client(): OpenAI {
    const provider = this.activeProvider();
    if (!provider) {
      // 没选服务商时仍允许纯环境变量跑起来，老用法不失效
      if (!process.env.OPENAI_API_KEY && !this.settings.apiKey) {
        throw new Error('还没有可用的模型，请在设置 → 模型里填好 API Key 并选定模型');
      }
      if (!this._client) this._client = createClient({ apiKey: this.settings.apiKey, baseURL: this.settings.baseURL });
      return this._client;
    }
    // 换服务商或换模型都要重建客户端，否则会拿着旧配置发请求
    const stamp = `${provider.id}:${provider.model}:${provider.baseURL}`;
    if (!this._client || this._clientId !== stamp) {
      this._client = createClient({ apiKey: provider.apiKey, baseURL: provider.baseURL });
      this._clientId = stamp;
    }
    return this._client;
  }

  /**
   * 保存一家服务商。预设只收 API Key 与模型名（Base URL 锁死），自定义才允许改全字段。
   * 传空 apiKey 等于清空，清空后这家就不可选。
   */
  saveProvider(input: Partial<ModelProvider> & { id?: string }): ForgeState {
    const id = String(input.id || '').trim();
    if (!/^[a-z][a-z0-9_-]{1,39}$/i.test(id)) throw new Error('服务商 id 不合规：字母开头，仅含字母、数字、下划线、短横线');
    const list = this.providers();
    const preset = list.find((p) => p.id === id && !p.custom);
    const saved = (this.settings.providers || []).filter((p) => p.id !== id);
    const model = String(input.model ?? '').trim();

    if (preset) {
      // 没给模型名就沿用手上已有的，允许只改 Key 不动模型
      saved.push({ id, apiKey: String(input.apiKey ?? preset.apiKey).trim(), model: model || preset.model });
    } else {
      const baseURL = String(input.baseURL ?? '').trim();
      if (!baseURL) throw new Error('自定义服务商必须填 Base URL');
      // 只接受 http(s)，避免把奇怪协议塞进 SDK
      if (!/^https?:\/\//i.test(baseURL)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
      saved.push({
        id,
        label: String(input.label || id).trim(),
        baseURL,
        model,
        apiKey: String(input.apiKey ?? '').trim(),
        custom: true,
      });
    }

    this.settings.providers = saved;
    // 当前选中的服务商缺 Key 或缺模型，就一并取消选中，免得带病运行
    const now = mergeProviders(saved).find((p) => p.id === this.settings.activeProvider);
    if (now && (!now.apiKey || !now.model)) this.settings.activeProvider = null;
    this.persist();
    audit.append({ type: 'provider_save', provider: id, hasKey: Boolean(input.apiKey), model });
    return this.state();
  }

  /** 拉取某家服务商当前可用的模型名。优先用页面上刚填的 Key/地址，未填则用已保存的 */
  async listProviderModels(input: { id: string; baseURL?: string; apiKey?: string }): Promise<string[]> {
    const known = this.providers().find((p) => p.id === input.id);
    const baseURL = String(input.baseURL || known?.baseURL || '').trim();
    const apiKey = String(input.apiKey || known?.apiKey || '').trim();
    if (!baseURL) throw new Error('缺少 Base URL');
    if (!apiKey) throw new Error('先填 API Key，才能拉模型列表');
    const ids = await fetchModelIds(baseURL, apiKey);
    audit.append({ type: 'provider_models', provider: input.id, count: ids.length });
    return ids;
  }

  /** 删除自定义服务商；预设删不掉，只能清 Key。删除当前选中的会退回未选择 */
  removeProvider(id: string): ForgeState {
    const target = this.providers().find((p) => p.id === id);
    if (!target) throw new Error(`没有这家服务商：${id}`);
    if (!target.custom) throw new Error('内置服务商不能删除，只能清空 API Key');
    this.settings.providers = (this.settings.providers || []).filter((p) => p.id !== id);
    if (this.settings.activeProvider === id) this.settings.activeProvider = null;
    this.persist();
    audit.append({ type: 'provider_remove', provider: id });
    return this.state();
  }

  /** 切换模型。没填 Key 的服务商不允许选中 */
  setActiveProvider(id: string | null): ForgeState {
    if (id === null || id === '') {
      this.settings.activeProvider = null;
      this.persist();
      return this.state();
    }
    const target = this.providers().find((p) => p.id === id);
    if (!target) throw new Error(`没有这家服务商：${id}`);
    if (!target.apiKey) throw new Error(`${target.label} 还没填 API Key，填好才能切换过去`);
    if (!target.model) throw new Error(`${target.label} 还没选模型，先选定模型再切换`);
    this.settings.activeProvider = id;
    this.persist();
    audit.append({ type: 'provider_select', provider: id });
    return this.state();
  }

  private persist(): void {
    try {
      ensureDirs();
      // 老版本的 model / apiKey / baseURL 字段原样保留：旧配置仍能当兜底用
      const { _说明, ...rest } = this.settings as Settings & { _说明?: string };
      const hint = '在设置页填好 DeepSeek / Kimi 的 API Key 即可；自定义服务商需同时填 Base URL 与模型名';
      fs.writeFileSync(dirs.settings, JSON.stringify({ ...rest, _说明: hint }, null, 2), 'utf8');
    } catch (err) {
      throw new Error(`保存模型配置失败：${(err as Error).message}`);
    }
  }

  /**
   * 选择工作目录（Work 模式的项目文件夹）。
   * 只认真实存在的目录：选错了要立刻报错，别等工具跑到一半才失败。
   */
  setWorkspace(dir: string | null): ForgeState {
    if (dir === null || dir === '') {
      setWorkspaceDir(null);
    } else {
      const abs = path.resolve(dir);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw new Error(`目录不存在：${abs}`);
      }
      if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`);
      setWorkspaceDir(abs);
    }
    this.settings.workspace = dir ? path.resolve(dir) : null;
    this.persist();
    audit.append({ type: 'workspace_select', workspace: dir ? path.resolve(dir) : null });
    return this.state();
  }

  /** 当前可注入的全量工具：元工具 + 已放行/本会话 + MCP */
  allTools(): Tool[] {
    const metas = metaToolDefs.map((d) => metaAsTool(d.name, d.description, d.input, d.trust));
    return [...metas, ...store.usable(this.sessionId), ...mcp.listTools()];
  }

  async runTool(name: string, args: Json = {}, depth = 0): Promise<ToolResult> {
    // 元工具不经 executeTool，档位这道闸得在门面层补上，否则「仅可查看」还能造工具、删工具
    const denied = metaDenied(name, args, getAccessLevel());
    if (denied) {
      audit.append({ type: 'meta_denied', tool: name, level: getAccessLevel() });
      return { ok: false, error: denied, ms: 0 };
    }
    const meta = findMetaTool(name);
    if (meta) {
      const started = Date.now();
      try {
        const out = await meta.handler(args, {
          sessionId: this.sessionId,
          access: getAccessLevel(),
          // 自省工具也只看得到当前档位允许的工具，否则列一眼全量仓库又会去试被拦的那些
          allTools: () => filterTools(this.allTools(), getAccessLevel()),
          hiddenTools: () => hiddenToolNames(this.allTools(), getAccessLevel()),
          runTool: (n, a, d) => this.runTool(n, a, d),
        });
        audit.append({ type: 'meta_call', tool: name, ok: true, ms: Date.now() - started });
        return { ok: true, result: out, ms: Date.now() - started };
      } catch (err) {
        audit.append({ type: 'meta_call', tool: name, ok: false, error: (err as Error).message });
        return { ok: false, error: (err as Error).message, ms: Date.now() - started };
      }
    }

    const tool = store.findByCallName(name) || mcp.listTools().find((t) => t.name === name);
    if (!tool) return { ok: false, error: `没有名为 ${name} 的工具，可调 list_tools 看看现有能力`, ms: 0 };

    return executeTool(tool, args, {
      sessionId: this.sessionId,
      depth,
      access: getAccessLevel(),
      signal: this._abort.signal,
      runner: (n, a, d) => this.runTool(n, a, d),
    });
  }

  /**
   * 跑一轮对话。
   *
   * `workspace` 由调用方逐轮传入，而不是只靠 setWorkspace 这个全局开关：
   * 每个任务有自己的工作区，用户切任务时只改渲染层状态，
   * 如果等 IPC 往返去同步，切太快就会拿错目录干活。传参是原子的。
   * 三种取值：字符串=具体目录；null=通用工作区；undefined=沿用当前设置。
   */
  async chat({
    input,
    phase = 'work',
    history = [],
    workspace,
    access,
  }: {
    input: string;
    phase?: Phase;
    history?: ChatMessage[];
    workspace?: string | null;
    access?: AccessLevel;
  }): Promise<ChatResult> {
    if (workspace !== undefined) setWorkspaceDir(workspace);
    // 档位与工作区一样按轮传入：每个任务存自己的档位，切任务太快也不会拿到上一个任务的
    if (access !== undefined) setGlobalAccessLevel(access);
    // 每轮换一个新的控制器：上一轮的 signal 已经 aborted，复用会导致一开跑就被中止
    this._abort = new AbortController();
    // 提示词里的工具清单也按档位裁剪：模型看到的名单与能调的 schema 必须一致，
    // 否则它照着 inventory 去调一件被闸门拦下的工具，又要白撞一次。
    const level = getAccessLevel();
    const repo = this.allTools();
    const visible = filterTools(repo, level);
    const messages: ChatMessage[] = [
      ...buildSystemMessages(phase, visible, getWorkspace(), level, hiddenToolNames(repo, level)),
      ...trimHistory(history),
      { role: 'user', content: input },
    ];

    // 本轮的工具集合一轮只算一次。
    //
    // DeepSeek 的缓存是「从第 0 个 token 起的逐字节前缀」，tools 数组也在前缀里。
    // 原来每步都重新 selectTools：一件工具跑完 store.recordRun 会写 lastRun，
    // 召回分里带着 lastRun 提权，于是下一步的工具集合/顺序就和上一步不一样——
    // 一步几十 token 全量 miss，整个上下文白 prefill。
    // 现在只在「工具清单真变了」（刚造了新工具/刚放行）时重算，造完照样当场能用。
    let frozen: { sig: string; bundles: ToolBundle[] } | null = null;
    const toolProvider = (): ToolBundle[] => {
      // 档位不允许的工具连 schema 都不注入：看不见就不会被调用，比执行时再拦早一步
      const levelNow = getAccessLevel();
      const all = filterTools(this.allTools(), levelNow);
      // 指纹带档位与版本：人中途切了档位、或同名工具被重建，都要重算注入集合
      const sig = `${levelNow}\n` + all
        .map((t) => `${t.name}@${t.version}`)
        .sort()
        .join('\n');
      if (frozen && frozen.sig === sig) return frozen.bundles;

      const query = messages
        .filter((m) => m.role === 'user')
        .map((m) => String(m.content ?? ''))
        .join(' ');
      // create_tool 在只读档下被隐藏，置顶名单也得跟着摘掉，否则又被强行塞回 schema
      const always = META_TOOL_NAMES.filter((name) => all.some((t) => t.name === name));
      const picked = selectTools(all, query, { limit: 14, always });
      frozen = { sig, bundles: picked.map((t) => ({ openai: toOpenAITool(t) as ToolBundle['openai'], tool: t })) };
      return frozen.bundles;
    };

    // 累计本轮的用量：界面据此显示缓存命中率，否则「命中低」只能靠感觉
    const usage = { prompt: 0, hit: 0, miss: 0, completion: 0 };
    const result = await runLoop({
      client: this.client,
      model: this.model,
      messages,
      toolProvider,
      runTool: (n, a) => this.runTool(n, a, 0),
      onEvent: this.onEvent,
      onUsage: (u) => {
        usage.prompt += u.prompt;
        usage.hit += u.hit;
        usage.miss += u.miss;
        usage.completion += u.completion;
      },
      maxSteps: resolveMaxSteps(this.settings),
      signal: this._abort.signal,
    });

    return {
      reply: result.reply,
      steps: result.steps,
      ok: result.ok,
      sessionId: this.sessionId,
      aborted: result.aborted,
      usage,
    };
  }

  /**
   * 显式开关「联网安装白名单外依赖」。
   *
   * 为什么必须是人点的：打开它之后，agent 造工具声明的依赖会立刻联网下载并执行。
   * 把它做成 settings 里一个由 UI 调用的独立方法，是为了让这次授权在审计里留下明确的一条，
   * 而不是混在「保存配置」里被顺手改掉。
   */
  setAllowUnvettedDeps(on: boolean): ForgeState {
    this.settings.allowUnvettedDeps = Boolean(on);
    this.persist();
    audit.append({ type: 'deps_policy', allowUnvettedDeps: Boolean(on), by: 'human' });
    return this.state();
  }

  /**
   * 切换访问档位。只能由人在界面上点，和「联网装依赖」一样是一次显式授权。
   * 落进 settings.json，下次启动沿用；审计里单独留一条，事后能查到是谁、什么时候放宽的。
   */
  setAccessLevel(level: AccessLevel): ForgeState {
    const next = normalizeAccess(level);
    setGlobalAccessLevel(next);
    this.settings.access = next;
    this.persist();
    audit.append({ type: 'access_level', level: next, by: 'human' });
    return this.state();
  }

  /**
   * 界面把人的选择送回来。这一步只 resolve 那个挂起的 Promise，
   * 真正的「回灌给模型」由 executeTool 返回的错误/结果经 loop.ts 完成。
   */
  decideApproval(id: string, decision: ApprovalDecision): { ok: boolean } {
    const ok = resolveApproval(id, decision);
    audit.append({ type: 'approval_human', id, decision, by: 'human', found: ok });
    return { ok };
  }

  /** 暂停当前这一轮。不抛错，aborting 后 chat() 会带着 aborted=true 正常返回 */
  stop(): void {
    this._abort.abort();
    // 还挂着的授权请求一并按拒绝收尾，别让一轮对话留个永不 resolve 的 Promise
    cancelAll();
    audit.append({ type: 'chat_stop', by: 'human' });
  }

  /**
   * 人工放行。这是「把一件只在本会话可用的工具变成常驻」的动作，得先确认它真的
   * 等在这里待人审、用例确实跑过、静态扫描没有高危命中，不能只凭一个 id 就改状态。
   *
   * 导入的工具包在导入时刻意不执行工具代码，因此没有本地用例记录；这类工具允许人工
   * 放行，但审计里标出 noTests，事后能分清「审过用例」与「人工担责」。
   */
  approve(id: string): ForgeState {
    const tool = store.get(id);
    if (!tool) throw new Error(`工具不存在：${id}`);
    if (tool.status !== 'pending') {
      throw new Error(`只能放行待审核的工具：${id} 当前状态为 ${tool.status}（用例未过请先重造并跑通用例）`);
    }
    const review = tool.meta?.review;
    if ((review?.findings || []).some((f) => f.level === 'high')) {
      throw new Error(`工具 ${id} 的静态扫描命中高危，不能放行`);
    }
    const tests = review?.tests || [];
    if (tests.length && !tests.every((t) => t.ok)) {
      throw new Error(`工具 ${id} 的自带用例未全部通过，不能放行`);
    }
    store.patch(id, { status: 'active', sessionId: null });
    audit.append({ type: 'approve', tool: id, by: 'human', noTests: tests.length === 0 });
    return this.state();
  }

  reject(id: string): ForgeState {
    store.patch(id, { status: 'rejected', sessionId: null });
    audit.append({ type: 'reject', tool: id, by: 'human' });
    return this.state();
  }

  removeTool(id: string): ForgeState {
    store.remove(id);
    audit.append({ type: 'remove', tool: id });
    return this.state();
  }

  /**
   * 开关一件工具。关掉等于 disabled：不再注入模型、也调不动，
   * 但规格还留在仓库里，随时可以再打开。
   */
  setEnabled(id: string, enabled: boolean): ForgeState {
    const tool = store.get(id);
    if (!tool) throw new Error(`工具不存在：${id}`);
    // 用例没过的工具不能靠开关绕审核直接启用，得先重造并跑通用例
    if (enabled && tool.status === 'untested') {
      throw new Error('这件工具的自带用例还没通过，不能直接启用；让它重造一次，用例过了再开');
    }
    store.patch(id, { status: enabled ? 'active' : 'disabled', sessionId: null });
    audit.append({ type: enabled ? 'enable' : 'disable', tool: id, by: 'human' });
    return this.state();
  }

  state(): ForgeState {
    const { tools, broken } = store.list({ includeBroken: true });
    const pool = readDepPolicy();
    return {
      home: dirs.home,
      model: this.model,
      models: {
        list: this.providers().map(toView),
        // 报告真正生效的服务商（缺 Key 或缺模型时算未选中），UI 的选中态以此为准
        active: this.activeProvider()?.id ?? null,
      },
      sessionId: this.sessionId,
      workspace: getWorkspace(),
      // 「可用工具数」只数用户视角的工具：仓库里已放行 / 本会话临时可用的 + MCP。
      // 内核元工具（list_tools / tool_search / create_tool）不给算——它们不是用户造的东西，
      // 算进来会让顶栏数字和设置页的「工具仓库 N」对不上，看起来像数错了。
      toolCount: store.usable(this.sessionId).length + mcp.listTools().length,
      tools: tools.map(summarize),
      pending: tools.filter((t) => t.status === 'pending').map(summarize),
      broken,
      mcp: { available: mcp.available, status: mcp.status, count: mcp.listTools().length },
      sandbox: permissionSupport(),
      depPolicy: {
        allowUnvettedDeps: pool.allowUnvettedDeps,
        origin: pool.origin,
        sharedDepsRoot: pool.sharedDepsRoot,
        whitelist: Object.keys(pool.whitelist).sort(),
      },
      access: { level: getAccessLevel(), pending: pendingApprovals() },
      audit: audit.tail(40),
    };
  }

  exportPack({ name, ids, description }: { name?: string; ids?: string[]; description?: string }): { file: string; pack: Pack } {
    const pack = exportPack({ name, ids, description });
    const file = savePack(pack);
    return { file, pack };
  }

  importPackFromFile(file: string): ImportResult[] {
    return this.importPack(readPackFile(file));
  }

  importPack(pack: unknown): ImportResult[] {
    const results = importPack(pack);
    audit.append({
      type: 'import_pack',
      name: (pack as Pack | null)?.name,
      count: results.length,
      ok: results.filter((r) => r.ok).length,
    });
    return results;
  }

  async close(): Promise<void> {
    await mcp.close();
  }
}

export { store, mcp, dirs };
export type { RawTool, Tool, ToolResult };
