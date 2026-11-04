import OpenAI from 'openai';
import { clampForModel } from '../core/bus.js';
import * as audit from '../core/audit.js';
import { META_TOOL_NAMES } from './prompts.js';
import type { AgentEvent, Json, ToolResult } from '../types.js';
// 核心循环。整段不认任何框架，只认 OpenAI 的 chat.completions。
// 「自我扩展」不在这里实现——因为 create_tool 本身就是一件 Tool。

export interface LlmSettings {
  apiKey?: string;
  baseURL?: string;
}

export function createClient(cfg: LlmSettings): OpenAI {
  // 显式传入的配置优先，环境变量只作兜底——否则设置页里选的服务商会被 OPENAI_API_KEY 顶掉
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 API Key。请在设置 → 模型里填入 DeepSeek 或 Kimi 的 API Key，或设置环境变量 OPENAI_API_KEY。');
  }
  const baseURL = cfg.baseURL || process.env.OPENAI_BASE_URL || undefined;
  return new OpenAI({ apiKey, baseURL });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ChatMessage = any;

export interface ToolBundle {
  openai: { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } };
  tool: { name: string };
}

export interface LoopOptions {
  client: OpenAI;
  model: string;
  messages: ChatMessage[];
  toolProvider: (messages: ChatMessage[]) => Promise<ToolBundle[]> | ToolBundle[];
  runTool: (name: string, args: Json) => Promise<ToolResult>;
  onEvent?: (event: AgentEvent) => void;
  maxSteps?: number;
  /** 中止信号。abort 后当前请求立即断掉，循环在下一步前收尾 */
  signal?: AbortSignal;
}

export interface LoopResult {
  ok: boolean;
  reply: string;
  steps: number;
  messages: ChatMessage[];
  /** true 表示用户主动中止，不是失败 */
  aborted?: boolean;
}

/**
 * 流式拉一次 completion，把增量文本实时抛给调用方，同时把碎片拼回完整的 assistant 消息。
 * 拼回来的形状和非流式一致，后面处理 tool_calls 的代码不用区分。
 */
async function streamOnce({
  client,
  model,
  messages,
  tools,
  onDelta,
  onReasoning,
  signal,
}: {
  client: OpenAI;
  model: string;
  messages: ChatMessage[];
  tools: never[];
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<ChatMessage> {
  const stream = await client.chat.completions.create(
    {
      model,
      messages: messages as never,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? ('auto' as never) : undefined,
      stream: true,
      // 不传 temperature：推理类模型（如 Kimi k3.1-pro）只接受 1，传 0.2 会被 400 拒绝；
      // 不传则各服务商用自家默认值，兼容性最好。
    },
    { signal }
  );

  let content = '';
  // index → 累积的工具调用碎片，流结束后按 index 顺序还原
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta as
      | {
          content?: string | null;
          // 推理模型的思考链。DeepSeek 系走 reasoning_content，
          // 各家字段名略有出入，这里两个都认，别把思考内容丢了。
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        }
      | undefined;
    if (!delta) continue;

    const think = delta.reasoning_content ?? delta.reasoning;
    if (typeof think === 'string' && think) onReasoning?.(think);

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }

    for (const part of delta.tool_calls || []) {
      const idx = part.index ?? 0;
      const acc = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (part.id) acc.id = part.id;
      if (part.function?.name) acc.name += part.function.name;
      if (part.function?.arguments) acc.args += part.function.arguments;
      calls.set(idx, acc);
    }
  }

  const tool_calls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name)
    .map(([idx, c], i) => ({
      id: c.id || `call_${idx}_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args || '{}' },
    }));

  return {
    role: 'assistant',
    content: content || null,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

export async function runLoop({
  client,
  model,
  messages,
  toolProvider,
  runTool,
  onEvent = () => {},
  maxSteps = 16,
  signal,
}: LoopOptions): Promise<LoopResult> {
  for (let step = 0; step < maxSteps; step++) {
    // 用户按了暂停：直接收尾，把已经产出的内容当结果返回，别当成错误
    if (signal?.aborted) {
      return { ok: false, reply: '', steps: step, messages, aborted: true };
    }
    const available = await toolProvider(messages);
    const openaiTools = available.map((t) => t.openai);
    // toolCount 只报用户视角的工具数：召回集合里含内核元工具，
    // 把它们算进去会和顶栏、设置页的数字对不上，看着像数错了。
    const userTools = available.filter((t) => !META_TOOL_NAMES.includes(t.tool.name)).length;
    onEvent({ type: 'step', step: step + 1, toolCount: userTools });

    let msg: ChatMessage;
    try {
      msg = await streamOnce({
        client,
        model,
        messages,
        tools: openaiTools as never[],
        onDelta: (text) => onEvent({ type: 'delta', delta: text }),
        onReasoning: (text) => onEvent({ type: 'reasoning', reasoning: text }),
        signal,
      });
    } catch (err) {
      // 中止会让 fetch 抛 AbortError，这不是故障，按「用户主动停」处理
      if (signal?.aborted) {
        audit.append({ type: 'llm_abort', step: step + 1 });
        return { ok: false, reply: '', steps: step + 1, messages, aborted: true };
      }
      audit.append({ type: 'llm_error', error: (err as Error).message });
      throw new Error(`模型调用失败：${(err as Error).message}`);
    }

    if (!msg) throw new Error('模型返回空消息');
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (msg.content) onEvent({ type: 'assistant', content: msg.content });
      return { ok: true, reply: msg.content || '', steps: step + 1, messages };
    }

    if (msg.content) onEvent({ type: 'assistant', content: msg.content });

    for (const call of msg.tool_calls) {
      // 工具跑到一半按了暂停：剩下的调用不再执行，但已完成的要回灌给模型，
      // 否则下一轮 history 里的 assistant 消息会缺 tool 应答，接口会直接报错。
      if (signal?.aborted) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function?.name || '',
          content: '（用户中止了这一轮，该工具未执行）',
        });
        continue;
      }
      const name = call.function?.name || '';
      let args: Json = {};
      let parseError: string | null = null;
      try {
        args = JSON.parse(call.function?.arguments || '{}') as Json;
      } catch (err) {
        parseError = (err as Error).message;
      }

      onEvent({ type: 'tool_call', name, args });
      let out: ToolResult;
      if (parseError) {
        out = { ok: false, error: `参数不是合法 JSON：${parseError}`, ms: 0 };
      } else if (!available.some((t) => t.tool.name === name)) {
        out = { ok: false, error: `没有名为 ${name} 的工具。可调 list_tools 看看有哪些。`, ms: 0 };
      } else {
        out = await runTool(name, args);
      }

      onEvent({
        type: 'tool_result',
        name,
        ok: out.ok,
        ms: out.ms,
        preview: audit.summarize(out.ok ? out.result : out.error, 200),
        payload: out.ok ? out.result : null,
      });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: clampForModel(out.ok ? out.result : { error: out.error }),
      });
    }

    // 这一轮的工具都跑完了，若此时已中止（或刚在循环里被置位），直接收尾
    if (signal?.aborted) {
      return { ok: false, reply: '', steps: step + 1, messages, aborted: true };
    }
  }

  return {
    ok: false,
    reply: `步数已达上限（${maxSteps} 步），任务尚未收束。可以把任务拆小一点，或告诉我卡在哪一步。`,
    steps: maxSteps,
    messages,
  };
}
