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
import { permissionSupport } from './executors/script.js';
import { mcp } from './mcp/client.js';
import { exportPack, savePack, importPack, readPackFile, type Pack, type ImportResult } from './core/pack.js';
import { mergeProviders, pickActive, toView, fetchModelIds, type ModelProvider, type ProviderView } from './core/models.js';
import * as audit from './core/audit.js';
import type { AgentEvent, Json, Tool, ToolResult, ToolSummary } from './types.js';
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
}

export interface ForgeState {
  home: string;
  model: string;
  models: { list: ProviderView[]; active: string | null };
  /** 当前工作目录；null 表示还没选 */
  workspace: string | null;
  sessionId: string;
  tools: ToolSummary[];
  pending: ToolSummary[];
  broken: Array<{ id: string; error: string }>;
  mcp: { available: boolean; status: Record<string, string>; count: number };
  /** 脚本沙箱的 OS 级隔离是否真的能用。probed=false 表示还没跑过脚本工具，不能声称已启用 */
  sandbox: { probed: boolean; flag: string | null };
  audit: audit.AuditEvent[];
}

export interface ChatResult {
  reply: string;
  steps: number;
  ok: boolean;
  sessionId: string;
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

function metaAsTool(name: string, description: string, input: Record<string, unknown>): Tool {
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
    trust: 'L0',
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
  };
}

export class ToolForge {
  onEvent: (event: AgentEvent) => void;
  sessionId: string;
  settings: Settings;
  seeded: string[] = [];
  private _client: OpenAI | null = null;
  private _clientId: string | null = null;

  constructor({ onEvent }: { onEvent?: (event: AgentEvent) => void } = {}) {
    ensureDirs();
    this.onEvent = onEvent ?? (() => {});
    this.sessionId = `s_${Date.now().toString(36)}`;
    this.settings = loadSettings();
  }

  async init({ connectMcp = true }: { connectMcp?: boolean } = {}): Promise<this> {
    this.seeded = installSeeds();
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
    const metas = metaToolDefs.map((d) => metaAsTool(d.name, d.description, d.input));
    return [...metas, ...store.usable(this.sessionId), ...mcp.listTools()];
  }

  async runTool(name: string, args: Json = {}, depth = 0): Promise<ToolResult> {
    const meta = findMetaTool(name);
    if (meta) {
      const started = Date.now();
      try {
        const out = await meta.handler(args, {
          sessionId: this.sessionId,
          allTools: () => this.allTools(),
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
  }: {
    input: string;
    phase?: Phase;
    history?: ChatMessage[];
    workspace?: string | null;
  }): Promise<ChatResult> {
    if (workspace !== undefined) setWorkspaceDir(workspace);
    const messages: ChatMessage[] = [
      ...buildSystemMessages(phase, this.allTools(), getWorkspace()),
      ...history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-8),
      { role: 'user', content: input },
    ];

    const toolProvider = (msgs: ChatMessage[]): ToolBundle[] => {
      const query = msgs
        .filter((m) => m.role === 'user')
        .map((m) => String(m.content ?? ''))
        .join(' ');
      const picked = selectTools(this.allTools(), query, { limit: 14, always: META_TOOL_NAMES });
      return picked.map((t) => ({ openai: toOpenAITool(t) as ToolBundle['openai'], tool: t }));
    };

    const result = await runLoop({
      client: this.client,
      model: this.model,
      messages,
      toolProvider,
      runTool: (n, a) => this.runTool(n, a, 0),
      onEvent: this.onEvent,
      maxSteps: phase === 'create' ? 20 : 16,
    });

    return { reply: result.reply, steps: result.steps, ok: result.ok, sessionId: this.sessionId };
  }

  approve(id: string): ForgeState {
    store.patch(id, { status: 'active', sessionId: null });
    audit.append({ type: 'approve', tool: id, by: 'human' });
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
      tools: tools.map(summarize),
      pending: tools.filter((t) => t.status === 'pending').map(summarize),
      broken,
      mcp: { available: mcp.available, status: mcp.status, count: mcp.listTools().length },
      sandbox: permissionSupport(),
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

  importPack(pack: unknown, opts?: { approve?: boolean }): ImportResult[] {
    const results = importPack(pack, opts);
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
