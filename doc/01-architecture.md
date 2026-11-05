# 01 · 整体架构与调用链

上一篇：[学习路线](./README.md) · 下一篇：[02 Agent 循环](./02-agent-loop.md)

## 本篇目标

读完本篇，你应该能画出一次用户请求的完整路径，并说明每一层为什么存在。先理解依赖方向，再读具体函数，能避免在 UI、模型协议和工具安全细节里迷路。

## 1. Tool Is All You Need 到底是什么意思

它不是说“只要有工具，就不需要提示词、状态、权限或 UI”，而是说：

> **能力的统一抽象是 Tool；其他模块负责让工具可发现、可创建、可执行、可治理。**

因此，ToolForge 没有一个巨大的 `switch (userIntent)` 来处理天气、搜索、文件等任务。核心只关心：

1. 当前模型能看到哪些工具；
2. 模型选择回答，还是调用工具；
3. 工具结果怎样成为下一轮模型输入；
4. 新工具怎样进入同一套协议。

`create_tool` 本身也是工具，是这套设计能自我扩展的关键。核心循环不需要知道“正在创建能力”和“正在查仓库”有什么业务区别。

## 2. 四层结构

```text
┌───────────────────────────────────────────────────────────┐
│ 接入层：Electron 桌面端 / CLI                              │
│ 任务、工作区、事件展示、用户配置、人工审核                 │
└──────────────────────────┬────────────────────────────────┘
                           │ ToolForge 公共门面
┌──────────────────────────▼────────────────────────────────┐
│ Agent 层：chat → runLoop → runTool                         │
│ 提示词、历史、工具召回、流式消息、tool_calls、中止         │
└──────────────────────────┬────────────────────────────────┘
                           │ Tool 统一契约
┌──────────────────────────▼────────────────────────────────┐
│ 工具治理层：spec / store / review / retrieve / bus / audit │
│ 规格、版本、测试、定级、权限、参数校验、审计               │
└──────────────────────────┬────────────────────────────────┘
                           │ kind 分发
┌──────────────────────────▼────────────────────────────────┐
│ 执行层：http / transform / compose / script / shell / MCP  │
│ 声明式执行器、子进程引导层、外部工具适配器                 │
└───────────────────────────────────────────────────────────┘
```

这个依赖方向很重要：Agent 层不直接拼命令或直接读工具文件，执行层也不直接请求模型。每层通过较小的契约通信。

## 3. `ToolForge` 门面：系统的装配点

先读 [`src/index.ts`](../src/index.ts)，重点看四个成员：

| 符号 | 职责 |
| --- | --- |
| `init()` | 建数据目录、安装种子工具、恢复工作区、初始化 MCP |
| `allTools()` | 汇总内核元工具、当前可用仓库工具和 MCP 工具 |
| `runTool()` | 把名称调用路由到元工具或普通工具执行闸门 |
| `chat()` | 组装消息、定义工具提供者、启动 Agent 循环 |

`state()`、`approve()`、`setEnabled()`、`exportPack()` 等方法则服务于设置页和人工管理。桌面端与 CLI 不各自实现一套 Agent，而是共同调用这个类。

### 为什么需要门面

如果没有 `ToolForge`，UI 可能直接操作仓库，CLI 可能直接调用执行器，两边的权限和状态规则很快就会分叉。门面把“系统如何装配”集中起来，也让 `--selftest` 可以绕开模型，直接验证工具创建全链路。

## 4. 一次普通请求的完整路径

假设用户说：“查一下 `nodejs/node` 的 GitHub 信息，再总结。”

```text
用户输入
  │
  ▼
ToolForge.chat({ input, phase, history, workspace })
  │  1. 设置本轮工作区与 AbortController
  │  2. buildSystemMessages() 生成系统提示词
  │  3. trimHistory() 保留预算内的完整问答
  │  4. 添加本轮 user 消息
  ▼
runLoop(...)
  │  5. toolProvider() 得到本轮工具 schemas
  │  6. streamOnce() 请求模型并拼回流式片段
  ▼
assistant.message 含 tool_calls: github_repo_info(...)
  │  7. 先把完整 assistant 消息 push 进 messages
  │  8. JSON.parse(arguments)
  ▼
ToolForge.runTool(name, args)
  │  9. 找到工具；不是元工具，所以进入 executeTool
  ▼
executeTool(tool, args)
  │ 10. isUsable → Ajv 参数校验 → runDeclarative
  │ 11. HTTP 域名检查 → fetch → extract
  │ 12. 记录运行健康与审计；返回 ToolResult
  ▼
runLoop
  │ 13. clampForModel() 限制结果长度
  │ 14. push role=tool 消息，tool_call_id 必须对应
  ▼
再次 streamOnce()
  │ 15. 模型读到工具结果，生成无 tool_calls 的回答
  ▼
ChatResult { reply, steps, ok, sessionId, usage }
```

注意第 7 和第 14 步的顺序：**assistant 的工具调用和 tool 的应答必须成对进入消息历史。** 只把返回值塞给下一次请求、却漏掉原始 assistant 消息，OpenAI 兼容接口通常会拒绝请求。

## 5. 一次“能力不存在”的路径

假设任务需要一个尚未存在的词频工具：

```text
模型请求 → tool_search / list_tools 查现有能力
        → 没有合适工具
        → create_tool({ name, kind, input, code, permissions, examples })
        → 规格校验、依赖检查、用例执行、定级、保存状态
        → 返回新工具信息
        → 模型在下一步调用 word_frequency
        → executeTool 执行新工具
        → 模型根据结果回答
```

`chat()` 中的工具集合有缓存，但不是整轮永远不变。它根据 `name@version` 列表生成指纹：刚创建或重建工具导致指纹变化时，会重新召回，让新工具在本轮后续步骤里出现。详细原因见 [06 上下文与缓存](./06-context-cache.md)。

## 6. 两类调用，两个入口

`ToolForge.runTool()` 先查元工具：

```ts
// 教学简化
if (findMetaTool(name)) {
  return runMetaHandler(...);
}
const tool = store.findByCallName(name) || findMcpTool(name);
return executeTool(tool, args, { sessionId, runner: ... });
```

- **元工具**是内核 TypeScript 代码，通过 `findMetaTool()` 找到处理器，管理工具系统自身。
- **普通工具**有持久化规格或 MCP 适配规格，统一经过 `executeTool()`。

因此，“所有执行必经 `executeTool`”准确地说是指**普通工具**。不要为了让元工具形式统一，就随手把内核管理操作搬到脚本沙箱里；也不要给普通工具新增旁路。

## 7. 核心数据结构就是模块边界

先读 [`src/types.ts`](../src/types.ts) 中四个类型：

| 类型 | 它回答的问题 |
| --- | --- |
| `Tool` | 这项能力是什么、怎样实现、要什么权限、现在能否使用？ |
| `ToolResult` | 这次执行是否成功、结果或错误是什么、耗时多久？ |
| `Permissions` | 它声明能访问哪些网络、文件、环境变量和命令？ |
| `AgentEvent` | 核心执行过程中，接入层需要实时看到什么？ |

例如 `ToolResult` 不让执行器直接抛给 UI，而是统一成 `{ ok, result?, error?, ms }`。这样模型能收到可修正的错误，CLI 能打印结果，桌面端能画成功/失败轨迹，审计也能记录同一语义。

## 8. 数据存在哪里

有两类持久化，不要混淆：

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| 工具规格、脚本、版本、审核、审计、模型配置 | `TOOLFORGE_HOME`，默认 `~/.toolforge` | 桌面与 CLI 共享，跨重启 |
| 桌面任务标题、对话历史、工作区选择、最后一轮过程 | 渲染层 `localStorage` | 当前桌面前端本地状态 |

工具仓库布局由 [`src/core/store.ts`](../src/core/store.ts) 和 [`src/core/paths.ts`](../src/core/paths.ts) 定义：

```text
tools/<id>/
├── tool.json          # 规格；script 不在这里内嵌代码
├── <name>.cjs         # script 的入口代码
├── .data/             # 默认脚本数据目录
├── .history/          # 旧规格快照
└── node_modules/      # 声明并安装依赖后才存在
```

脚本代码与 `tool.json` 分离，是为了让规格文件保持可读，同时让子进程有明确入口。`store.read()` 负责把代码读回运行时 `Tool`。

## 9. 暂时不需要理解的模块

第一遍读源码时，可以先跳过：

- `src/core/deps.ts` 与 `scripts/build-*`：依赖供应链和发布工程；
- `src/core/models.ts`：多服务商配置，不影响工具循环主干；
- `src/ui/style.css`：视觉表现，不影响核心状态机；
- 安装包脚本：只有分发 Windows 产物时才需要深入。

它们很重要，但不适合和 Agent 循环同时塞进第一遍阅读。

## 动手练习

1. 在 `src/index.ts` 的 `chat()`、`runTool()` 和 `src/agent/loop.ts` 的 `runLoop()` 各画一个书签。
2. 不运行程序，回答：模型一次消息里返回两个工具调用时，它们是在下一次模型请求前还是请求后执行？查看 `runLoop()` 验证。
3. 跟踪 `text_stats`：从 `src/core/seed.ts` 的规格，到 `runTool()`，再到 `runTransform()`。
4. 思考一个设计题：如果新增“发送邮件”，应该加在 `runLoop()`、UI，还是工具层？写出你的理由。

下一篇：[02 · Agent 循环与流式协议](./02-agent-loop.md)
