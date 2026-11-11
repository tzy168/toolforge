import { Ajv } from 'ajv';
import { store, isUsable } from './store.js';
import * as audit from './audit.js';
import { accessDenies, classifyCommand, commandSummary, effectivePermissions, getAccessLevel } from './policy.js';
import { requestApproval } from './approval.js';
import { runDeclarative } from '../executors/declarative.js';
import { runScript } from '../executors/script.js';
import { callMcpTool } from '../mcp/client.js';
import type { ExecuteOptions, Json, Tool, ToolResult } from '../types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

type Validator = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};
const validatorCache = new Map<string, Validator | { compileError: string }>();

function validatorFor(tool: Tool): Validator | { compileError: string } {
  // 键必须带上 schema 本身：同名工具被重建后 schema 会变，只按 name 缓存会把旧校验器套到新规格上
  // ponytail: 缓存不设上限，但键是 schema 内容，同一进程里 schema 种类有限
  const key = `${tool.name}\u0000${JSON.stringify(tool.input)}`;
  const cached = validatorCache.get(key);
  if (cached) return cached;
  let v: Validator | { compileError: string };
  try {
    v = ajv.compile(tool.input || { type: 'object' }) as unknown as Validator;
  } catch (err) {
    v = { compileError: (err as Error).message };
  }
  validatorCache.set(key, v);
  return v;
}

export function validateArgs(tool: Tool, args: unknown): true {
  const v = validatorFor(tool);
  if ('compileError' in v) throw new Error(`工具 schema 编译失败：${v.compileError}`);
  if (v(args) === false) {
    const detail = (v.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('；');
    throw new Error(`参数不合规：${detail}`);
  }
  return true;
}

const MAX_RESULT_CHARS = 12000;

/** 超大结果裁掉，免得一个工具把上下文撑爆 */
export function clampForModel(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = JSON.stringify({ error: '返回值无法序列化' });
  }
  if (typeof text !== 'string') text = 'null';
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) + `\n…（结果过长已截断，原文 ${text.length} 字）`;
}

/**
 * 唯一的执行入口：档位裁剪 → 命令分级 → 人工确认 → 参数校验 → 沙箱 → 审计。
 * 任何 tool 都走这里，没有旁门。被拒绝的原因会原样回到模型，所以写清楚下一步该怎么改。
 */
export async function executeTool(tool: Tool, args: Json = {}, opts: ExecuteOptions = {}): Promise<ToolResult> {
  const { sessionId = null, depth = 0, runner = null, allowUntested = false } = opts;
  const level = opts.access ?? getAccessLevel();
  const signal = opts.signal;
  const started = Date.now();
  let ok = false;
  let result: unknown;
  let error: string | undefined;

  try {
    if (depth > 5) throw new Error('工具组合层数过深（最多 5 层）');

    const denial = accessDenies(tool, level, args);
    if (denial) throw new Error(denial);

    // 命令分级与 human-in-loop 都收在闸门口：执行器只认 commandApproved 这个结果，
    // 不自己弹确认，也不接受「绕过闸门直接调 runDeclarative」的调用。
    let commandApproved = false;
    if (tool.kind === 'shell') {
      const cmdArgs = (tool.impl.args || []).map(String);
      const verdict = classifyCommand(tool.impl.command ?? '', cmdArgs, tool.impl.cwd ?? '', level);
      const summary = commandSummary(tool.impl.command ?? '', cmdArgs);
      audit.append({ type: 'command_classify', tool: tool.name, bin: verdict.bin, decision: verdict.decision, level });

      if (verdict.decision === 'deny') {
        throw new Error(
          `命令被禁止：${verdict.reason}。禁止清单不接受人工放行；请改用只读工具，或换一条在允许清单内的命令。`
        );
      }
      if (verdict.decision === 'confirm') {
        const answer = await requestApproval({
          tool: tool.name,
          action: summary,
          reason: verdict.reason,
          level,
          grantKey: `${tool.name}:${verdict.bin}:${cmdArgs.join(' ')}`,
          signal,
        });
        audit.append({
          type: 'approval_decision',
          tool: tool.name,
          decision: answer.decision,
          timedOut: answer.timedOut,
          action: audit.summarize(summary, 160),
        });
        if (answer.decision === 'deny') {
          throw new Error(
            answer.timedOut
              ? '等待人工确认超时，这条命令按拒绝处理，未执行。不要原样重试；请改用只读方式，或请用户重新发起并授权。'
              : `用户拒绝了这条命令（${summary}）。这是人的最终决定，不要换写法重试同一条命令；请改用只读方式完成任务，或向用户说明需要什么授权。`
          );
        }
        commandApproved = true;
      }
    }

    // 执行器只拿到收窄后的权限视图。落盘规格不变，下次换档位重新计算。
    const scoped: Tool = { ...tool, permissions: effectivePermissions(tool, level) };
    const usable = isUsable(scoped, sessionId, { allowUntested });
    if (!usable) {
      throw new Error(`工具 ${tool.name} 尚未放行（当前状态 ${tool.status}），只有创建它的那次会话能临时调用`);
    }

    validateArgs(scoped, args);

    if (tool.kind === 'mcp') {
      result = await callMcpTool(scoped, args);
    } else if (tool.kind === 'script') {
      result = await runScript(scoped, args);
    } else {
      result = await runDeclarative(scoped, args, {
        sessionId,
        access: level,
        commandApproved,
        run: async (name, a) => {
          if (!runner) throw new Error('组合工具缺少调度器');
          const out = await runner(name, a, depth + 1);
          if (out.ok === false) throw new Error(`子工具 ${name} 失败：${out.error}`);
          return out.result;
        },
      });
    }
    ok = true;
  } catch (err) {
    error = (err as Error).message ?? String(err);
  }

  const ms = Date.now() - started;
  if (tool.kind !== 'mcp') store.recordRun(tool.id, { ok, ms, error });

  audit.append({
    type: 'tool_call',
    tool: tool.name,
    kind: tool.kind,
    trust: tool.trust,
    sessionId,
    ok,
    ms,
    args: audit.summarize(args),
    error: error ? audit.summarize(error, 400) : null,
  });

  return { ok, result: ok ? result : undefined, error, ms };
}
