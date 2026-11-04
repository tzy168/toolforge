import { store, isUsable } from '../core/store.js';
import { normalizeTool, describePermissions, type RawTool } from '../core/spec.js';
import { selectTools, indexOf } from '../core/retrieve.js';
import { staticScan, grade, runExamples } from '../core/review.js';
import { executeTool } from '../core/bus.js';
import * as audit from '../core/audit.js';
import fs from 'node:fs';
import path from 'node:path';
import { dirs, toolDir } from '../core/paths.js';
import { installToolDeps, planSharedDeps, readDepPolicy, toDepRecord, type DepInstallReport } from '../core/deps.js';
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
  /** 元工具默认 L0；有破坏性副作用（改仓库）的要显式拔高，别让模型误判风险 */
  trust?: Tool['trust'];
}

const createToolSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '工具名，小写字母开头，仅含小写字母/数字/下划线，如 fetch_weather' },
    description: { type: 'string', description: '一句话说清「做什么、返回什么」，模型靠它判断何时调用' },
    kind: { type: 'string', enum: ['http', 'transform', 'compose', 'script', 'shell'], description: '实现方式，声明式优先' },
    input: { type: 'object', description: '入参的 JSON Schema，通常 {type:"object",properties:{...},required:[...]}' },
    code: { type: 'string', description: 'kind=transform 或 script 时的实现代码' },
    deps: {
      type: 'object',
      description:
        'kind=script 专用：三方依赖，包名 → 精确版本，如 {"dayjs":"1.11.13"}。只收精确版本（不收 ^ ~ * latest / git: / file:）。不在本机离线白名单里的依赖装不上，会转人工。',
      additionalProperties: { type: 'string' },
    },
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
    description:
      '列出工具仓库里的全部工具，并标明哪些当前可用、哪些不可用（已停用/待审核/用例未过）。默认全量；只想看能调用的传 availableOnly=true。',
    input: {
      type: 'object',
      properties: {
        availableOnly: { type: 'boolean', description: '只列当前可调用（已放行或本会话可用）的工具，默认 false' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const availableOnly = args.availableOnly === true;
      // ctx.allTools() 只有「此刻能调用」的那批：元工具 + 已放行/本会话 + MCP。
      // 仓库里被停用、待审核、用例没过的它一概看不见——而「我那件工具怎么不见了」
      // 恰恰是查工具时最常问的问题。所以全量清单直接从 store 取，再逐件标上可否调用。
      const callable = ctx.allTools();
      const callableNames = new Set(callable.map((t) => t.name));
      const { tools: repo, broken } = store.list({ includeBroken: true });

      const row = (t: Tool, isCallable: boolean) => ({
        name: t.name,
        kind: t.kind,
        trust: t.trust,
        status: t.status,
        callable: isCallable,
        description: t.description.slice(0, 80),
      });

      // 元工具是内核动态注入的，不在仓库目录里，得单独补一份，
      // 否则这份「全部工具」清单会漏掉自省能力本身。
      const metas = callable.filter((t) => t.kind === 'meta').map((t) => row(t, true));
      const storeRows = repo.map((t) => row(t, callableNames.has(t.name)));
      const rows = availableOnly ? storeRows.filter((r) => r.callable) : [...metas, ...storeRows];

      const byStatus: Record<string, number> = {};
      for (const r of storeRows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

      return JSON.stringify({
        total: rows.length,
        callable: storeRows.filter((r) => r.callable).length + metas.length,
        repo: { total: storeRows.length, byStatus, broken: broken.map((b) => b.id) },
        tools: rows,
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
  {
    name: 'manage_tool',
    description:
      '管理工具仓库：查询某件工具的详情、打开/关闭（enable/disable）、删除（remove，删前自动备份到 staging/trash 可恢复）。内核元工具不允许开关或删除。',
    input: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'inspect', 'enable', 'disable', 'remove'],
          description: 'list=列全量概览；inspect=看详情；enable/disable=开关；remove=删除（需 confirm）',
        },
        tool: { type: 'string', description: '工具名或 id，action 不是 list 时必填' },
        confirm: { type: 'boolean', description: 'remove 必须显式传 true，防误删' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    trust: 'L2',
    async handler(args, ctx) {
      const action = String(args.action ?? '');
      const key = String(args.tool ?? '').trim();

      if (action === 'list') {
        const { tools: repo, broken } = store.list({ includeBroken: true });
        return JSON.stringify({
          total: repo.length,
          broken: broken.map((b) => b.id),
          tools: repo.map((t) => ({
            name: t.name,
            id: t.id,
            kind: t.kind,
            trust: t.trust,
            status: t.status,
            callable: isUsable(t, ctx.sessionId),
          })),
        });
      }

      if (!key) throw new Error(`action=${action} 需要 tool（工具名或 id）`);

      const target = store.findByCallName(key) || store.get(key);
      if (!target) throw new Error(`工具不存在：${key}。可先用 manage_tool action=list 看全量清单`);

      // 元工具不在仓库目录里、本来就改不到；这道闸同时防住「以后有人把元工具搬进仓库」，
      // 避免 manage_tool 把 list_tools 自己关掉、Agent 从此失去自省能力。
      if (target.kind === 'meta' || findMetaTool(target.name)) {
        throw new Error(`拒绝：${target.name} 是内核元工具，不支持开关或删除`);
      }

      if (action === 'inspect') {
        return JSON.stringify({
          name: target.name,
          id: target.id,
          kind: target.kind,
          version: target.version,
          trust: target.trust,
          status: target.status,
          callable: isUsable(target, ctx.sessionId),
          description: target.description,
          permissions: describePermissions(target.permissions),
          examples: (target.examples || []).length,
          lastRun: target.meta?.lastRun ?? null,
          review: target.meta?.review
            ? { level: target.meta.review.level, testsOk: (target.meta.review.tests || []).every((r) => r.ok) }
            : null,
        });
      }

      if (action === 'enable') {
        // 用例没过的不能靠开关绕审核直接启用——与 UI 的 setEnabled 同一条规则
        if (target.status === 'untested') {
          throw new Error('这件工具的自带用例还没通过，不能直接启用；让它重造一次，用例过了再开');
        }
        store.patch(target.id, { status: 'active', sessionId: null });
        audit.append({ type: 'meta_manage', action: 'enable', tool: target.name });
        return JSON.stringify({ ok: true, name: target.name, status: 'active', callable: true });
      }

      if (action === 'disable') {
        store.patch(target.id, { status: 'disabled', sessionId: null });
        audit.append({ type: 'meta_manage', action: 'disable', tool: target.name });
        return JSON.stringify({ ok: true, name: target.name, status: 'disabled', callable: false });
      }

      if (action === 'remove') {
        if (args.confirm !== true) {
          throw new Error('remove 是破坏性操作（会删掉工具目录），必须显式传 confirm: true');
        }
        const backup = backupToolDir(target.id);
        store.remove(target.id);
        audit.append({ type: 'meta_manage', action: 'remove', tool: target.name, backup });
        return JSON.stringify({
          ok: true,
          removed: target.name,
          backup,
          hint: '已备份到上述目录；要恢复就把该目录拷回工具仓库再重启。',
        });
      }

      throw new Error(`未知 action：${action}（可用 list / inspect / enable / disable / remove）`);
    },
  },
];

/**
 * 删工具前先把整个目录备一份到 staging/trash。
 * store.remove 是 rmSync 递归强删、不可撤销；留个备份才有「删错了」的退路。
 */
function backupToolDir(id: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dirs.staging, 'trash', `${id}-${stamp}`);
  const src = toolDir(id);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  return dest;
}

function buildImpl(args: Json): ToolImpl {
  const kind = String(args.kind ?? '');
  switch (kind) {
    case 'http':
      return { ...((args.http as ToolImpl) || {}) };
    case 'transform':
      return { code: String(args.code ?? '') };
    case 'script':
      // deps 只从 script 透传。其它 kind 声明依赖会被 normalizeTool 直接拒掉，
      // 这里提前带上只会把那个错误盖住，让人以为是别的地方出了问题。
      return { code: String(args.code ?? ''), ...(args.deps ? { deps: args.deps as ToolImpl['deps'] } : {}) };
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

  // 2) 依赖闸门。这里的顺序是整件事的关键：跑用例就是在执行代码，
  //    所以「先装依赖 → 再跑用例 → 最后请示」是错的，那等于让一份没过审的
  //    外部代码先在本机执行了一遍，然后再去问用户同不同意。
  //    白名单外的依赖一律不装、不跑，直接转人工。
  const depNames = Object.keys(tool.impl.deps ?? {});
  const depPlan = depNames.length ? planSharedDeps(tool) : null;
  const policy = readDepPolicy();
  const depOutOfWhitelist = depNames.length > 0 && (!depPlan || depPlan.missing.length > 0);
  // 白名单外 + 用户没开联网开关 = 不装、不跑用例、直接转人工。
  // 开了开关则继续往下走（安装 → 跑用例 → 定级仍是 L3），让用户在放行前能看到真实用例结果。
  const depsBlocked = depOutOfWhitelist && !policy.allowUnvettedDeps;
  if (depsBlocked) {
    const missing = depPlan ? depPlan.missing : depNames;
    const reasons = [`依赖 ${missing.length} 个白名单外的三方包（${missing.join(', ')}）：未安装、未跑用例，等人工决定`];
    if (!depPlan) reasons.push('本机没有离线白名单目录，离线安装这条路在当前形态下不可用');
    if (depNames.length) {
      reasons.push('联网安装开关未开启（settings.json 的 allowUnvettedDeps，或环境变量 TOOLFORGE_ALLOW_NET_DEPS=1）');
    }
    store.patch(tool.id, {
      status: 'pending',
      trust: 'L3',
      meta: { review: { at: new Date().toISOString(), level: 'L3', reasons, findings, tests: [] } },
    });
    audit.append({
      type: 'review',
      tool: tool.name,
      trust: 'L3',
      status: 'pending',
      testsOk: false,
      needsHuman: true,
      findings: findings.length,
    });
    // 依赖被拦下是独立事件，不是「审核」的子集：事后要能单独统计「多少次是因为依赖被挡」
    audit.append({
      type: 'deps_blocked',
      tool: tool.name,
      declared: tool.impl.deps,
      missing,
      whitelistRoot: policy.sharedDepsRoot,
    });
    return JSON.stringify({
      ok: false,
      stage: 'deps',
      tool: { id: tool.id, name: tool.name, kind: tool.kind, trust: 'L3', status: 'pending' },
      deps: { declared: tool.impl.deps, missing, sharedDepsRoot: policy.sharedDepsRoot, allowUnvettedDeps: policy.allowUnvettedDeps },
      review: { level: 'L3', needsHuman: true, reasons, findings },
      hint:
        '这些依赖不在本机离线白名单里，所以既没安装也没跑用例。可选：① 换成不依赖它们的实现；② 请用户在设置页开启「允许联网安装白名单外的依赖」，再重新调一次 create_tool（装完会跑用例，但级别仍是 L3，需人工放行）；③ 把包按白名单四条标准审过后加进 shared-deps.json 并重新构建。',
    });
  }

  // 3) 装依赖。白名单内是纯文件复制，不联网、不跑任何 install 脚本
  let depReport: DepInstallReport | null = null;
  if (depNames.length) {
    try {
      depReport = await installToolDeps(tool);
      store.patch(tool.id, { meta: { deps: toDepRecord(depReport) } });
      // 依赖事件独立落审计：白名单复制与联网安装在事后追责时是完全不同的两件事
      audit.append({
        type: 'deps_install',
        tool: tool.name,
        source: depReport.source,
        manager: depReport.manager,
        packages: depReport.installed.map((d) => d.name + '@' + d.version),
        totalBytes: depReport.totalBytes,
        transitiveCount: depReport.transitiveCount,
        ms: depReport.ms,
      });
    } catch (err) {
      const message = (err as Error).message;
      store.patch(tool.id, { status: 'pending' });
      audit.append({ type: 'create_tool', stage: 'deps', ok: false, error: message, tool: tool.name });
      return JSON.stringify({
        ok: false,
        stage: 'deps',
        error: message,
        hint: '依赖没装上，工具已落为 pending。把 deps 改成精确版本（如 "1.2.3"）后重新调 create_tool。',
      });
    }
  }

  // 4) 跑自带用例。必须在依赖就位之后——否则 require 一上来就失败，
  //    那种失败骗人，会让人以为代码写错了
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

  // 装了什么、多大、多少个传递依赖，一并回给模型：它下次要判断「这个库是不是太重了」
  // 时，只能靠这些数字，不能靠猜
  if (depReport) {
    payload.deps = {
      manager: depReport.manager,
      skipped: depReport.skipped,
      ms: depReport.ms,
      source: depReport.source,
      packages: depReport.installed,
      totalBytes: depReport.totalBytes,
      transitiveCount: depReport.transitiveCount,
    };
  }

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
