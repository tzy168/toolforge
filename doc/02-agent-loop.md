# 02 · Agent 循环与流式协议

上一篇：[01 整体架构](./01-architecture.md) · 下一篇：[03 工具契约](./03-tool-contract.md)

## 本篇目标

核心文件是 [`src/agent/loop.ts`](../src/agent/loop.ts)。读完你应该能手写一个最小工具循环，并解释流式增量、完整消息、工具结果和中止信号之间的关系。

## 1. 最小 Agent 循环

先忘掉流式输出，Agent 的本质只有这几步：

```ts
// 教学伪代码，不对应可直接运行的完整实现
while (steps < maxSteps) {
  const tools = toolProvider(messages);
  const message = await llm.chat({ messages, tools });
  messages.push(message);

  if (!message.tool_calls?.length) {
    return message.content;
  }

  for (const call of message.tool_calls) {
    const result = await runTool(call.name, parse(call.arguments));
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: serialize(result),
    });
  }
}
```

关键不是 `while`，而是两个反馈闭环：

- **行动反馈**：模型决策 → 工具执行 → 结果回灌 → 模型再决策；
- **纠错反馈**：规格、JSON 参数、执行器报错 → 结构化错误回灌 → 模型修正。

因此工具失败通常不应直接让整个循环崩溃。只有模型请求失败、空消息等无法继续的问题才向上抛出；普通工具失败会作为 `role=tool` 内容返回给模型。

## 2. `runLoop()` 的输入与输出

`LoopOptions` 将模型循环与具体系统解耦：

| 参数 | 作用 |
| --- | --- |
| `client` / `model` | OpenAI SDK 客户端和模型名 |
| `messages` | 可变的完整对话数组，包含系统、历史与工具消息 |
| `toolProvider()` | 每一步提供允许模型使用的工具 schema |
| `runTool()` | 真正执行工具，由 `ToolForge` 注入 |
| `onEvent()` | 向 CLI 或桌面端报告增量和调用轨迹 |
| `onUsage()` | 汇报 token 与缓存命中 |
| `maxSteps` | 防止无限决策循环 |
| `signal` | 用户暂停时中止请求和后续工具 |

`LoopResult` 除最终回答外还返回 `steps`、`messages` 和可选 `aborted`。这让上层能区分“任务失败”和“人主动停止”。

## 3. 为什么 `streamOnce()` 仍然返回完整消息

流式协议适合 UI，但不适合直接驱动工具执行。一次工具调用可能被拆成许多片段：

```text
chunk 1: tool_calls[0].id = "call_..."
chunk 2: tool_calls[0].function.name = "github_"
chunk 3: tool_calls[0].function.name = "repo_info"
chunk 4: arguments = "{\"repo\":"
chunk 5: arguments = "\"nodejs/node\"}"
```

如果第 3 片到达就调用工具，名字不完整；第 4 片到达就 `JSON.parse`，参数也不完整。`streamOnce()` 做两件事：

1. 立即把 `content` 和 `reasoning` 增量通过事件发给 UI；
2. 按工具调用的 `index` 累积 `id`、`name`、`arguments`，流结束后重建标准 assistant 消息。

```ts
// 累积结构，教学简化
Map<index, { id, name, args }>
        ↓ 流结束，按 index 排序
assistant {
  role: 'assistant',
  content: fullText || null,
  tool_calls: [{ id, type: 'function', function: { name, arguments } }]
}
```

所以后续代码只有一套消息处理逻辑，不需要区分“流式工具调用”和“非流式工具调用”。

## 4. 同一片里可能有什么

`streamOnce()` 同时处理三类增量：

- `delta.content`：正文，追加到 `content`，发出 `delta` 事件；
- `delta.reasoning_content` 或 `delta.reasoning`：推理内容，发出 `reasoning` 事件；
- `delta.tool_calls`：调用碎片，只累积，不立即执行。

不同 OpenAI 兼容服务对推理字段命名不完全一致，所以代码兼容两个字段。新增服务商时，不要盲目增加字段：先观察真实协议，再补协议测试。

用量通常出现在最后一帧。代码同时识别 DeepSeek 的缓存字段与 OpenAI 风格的 `prompt_tokens_details.cached_tokens`，聚合成 `prompt / hit / miss / completion`。没有回报用量时，不应把“未知”当成“命中率为零”。

## 5. 工具调用的消息顺序

`runLoop()` 中顺序是固定的：

```text
1. messages.push(assistantMessage)
2. 没有 tool_calls → 发 assistant 事件并返回
3. 有 tool_calls → 逐个处理
4. 解析 arguments
5. 确认 name 在 available 中
6. runTool(name, args)
7. 发 tool_result 事件
8. messages.push({ role: 'tool', tool_call_id, name, content })
9. 本轮所有调用完成后进入下一步
```

第 5 步是一道协议边界：即使模型幻觉出一个工具名，也不能直接按名字从任意位置执行。当前请求可用集合 `available` 是允许调用的白名单；未知名称会变成错误结果，提示模型调用 `list_tools`。

### 为什么先 push assistant，再执行工具

工具结果必须引用原始 `call.id`。如果历史里没有带该 `tool_calls` 的 assistant 消息，下轮请求会出现“tool 消息没有对应调用”的协议错误。暂停时也要为未执行的调用补一条说明性 tool 应答，维持消息配对。

## 6. 错误在哪里被转换成上下文

| 失败点 | 当前处理 | 模型能否据此修正 |
| --- | --- | --- |
| 工具参数不是合法 JSON | 构造失败 `ToolResult` | 能，重新生成参数 |
| 工具名不在本轮可用集合 | 构造失败 `ToolResult` | 能，检索或换工具 |
| Ajv 参数校验失败 | `executeTool` 返回错误 | 能，按 schema 修正 |
| 权限拒绝 / 执行失败 | `executeTool` 返回错误 | 能，但可能需要人授权 |
| 模型请求异常 | 记录审计并抛出 | 本轮终止，由用户或上层处理 |
| 用户中止 | `aborted: true` 收尾 | 不应当作系统故障重试 |

这也是“错误信息是产品的一部分”的原因。`参数不合规：/text must be string` 比 `tool failed` 更可能让模型下一步就修对。

## 7. 工具结果不能无限进入上下文

[`src/core/bus.ts`](../src/core/bus.ts) 的 `clampForModel()` 把字符串化结果限制在 12000 字，并附加截断说明。它作用于发给模型的 `content`，不是把真实工具返回值截掉后才发给 UI。

设计工具时仍应主动返回小而结构化的结果：

```ts
// 不推荐：返回整份大文件或整个 API 原始响应
return hugeResponse;

// 推荐：只返回任务需要的字段，并提供分页或摘要
return { total, items: items.slice(0, 20), nextCursor };
```

截断是保险丝，不是良好的工具接口设计。

## 8. 停止条件与中止

当前有四类收尾：

1. **成功**：assistant 没有 `tool_calls`，返回最终回答；
2. **主动中止**：请求前、请求中或工具序列中检测到 `signal.aborted`；
3. **步数耗尽**：返回带说明的失败结果，不假装任务完成；
4. **不可恢复异常**：例如模型调用失败，向上抛错。

`ToolForge.chat()` 每轮新建 `AbortController`，因为 `AbortSignal` 一旦 aborted 就不能“重置”。复用旧控制器会让新一轮刚开始就被停止。

当前实现按消息中的 `tool_calls` 顺序逐个 `await`，不是并行执行。这样保证组合顺序和事件流简单可预测，但多个独立慢调用不能并发提速。若未来改成 `Promise.all`，还要设计结果事件顺序、取消语义和副作用边界，不能只换一行语法。

## 9. 事件不是模型消息

`AgentEvent` 服务于界面，消息数组服务于模型：

| 事件 | 典型消费者 | 是否直接进入模型历史 |
| --- | --- | --- |
| `step` | 显示第几步、工具数量 | 否 |
| `delta` | 流式正文 | 其累计正文会进入 assistant 消息 |
| `reasoning` | 可折叠思考块 | 不自动作为正文回灌 |
| `tool_call` | 工具徽章与参数展示 | 原始调用在 assistant 消息中 |
| `tool_result` | 成功/失败、耗时、预览 | 序列化结果进入 tool 消息 |
| `assistant` | 完整正文节点 | 已在 assistant 消息中 |

把事件与消息分开，可以避免为了 UI 展示改动模型协议。前端需要保存自己的片段状态，详见 [07 桌面状态](./07-ui-and-mcp.md)。

## 动手练习

1. **手写最小循环**：用假的 `client` 依次返回“一次工具调用”和“最终文本”，不请求网络，验证 messages 中出现 `assistant → tool → assistant`。
2. **碎片还原**：把同一个工具调用拆成五片，验证只有流结束后才执行一次，且参数完整。
3. **幻觉工具**：让假模型返回不存在的工具名，确认循环不崩溃，下一条 tool 消息包含可修正错误。
4. **中止配对**：让一条 assistant 消息包含两个调用，在第一个结束后中止，观察第二个调用如何补 tool 应答。

可参考 [`test/loop.test.ts`](../test/loop.test.ts) 的“循环能走通一次工具调用并收束”“模型调用不存在的工具”和“流式增量拼接”测试。

下一篇：[03 · 工具契约与声明式设计](./03-tool-contract.md)
