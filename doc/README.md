# ToolForge 源码课：从一个循环到可扩展 Agent

这套文档面向想理解或二次开发 Agent 的开发者。主线不是逐个罗列文件，而是跟随一次调用，逐步回答：**模型怎样决策，工具怎样成为能力，系统怎样约束并记住这些能力。**

文中代码片段默认是保留关键逻辑的**教学简化版**，省略部分错误处理与兼容逻辑；实现事实以仓库源码为准。文档尽量引用稳定的文件路径和符号名，而不是容易失效的行号。

## 建议的学习方式

1. 先读 [01 整体架构](./01-architecture.md)，建立全局图，不急着抠每一行。
2. 每读一篇，打开对应源码，用符号名定位核心函数。
3. 完成每篇末尾的小练习；先预测结果，再运行验证。
4. 改代码前读根目录 [`AGENTS.md`](../AGENTS.md)，尤其是执行入口、类型兼容和安全约束。
5. 用临时 `TOOLFORGE_HOME` 做实验，不拿日常工具仓库当测试垃圾场。

## 学习路线

| 顺序 | 文档 | 核心问题 | 主要源码 |
| --- | --- | --- | --- |
| 01 | [整体架构与调用链](./01-architecture.md) | 系统有哪些层？一次请求怎样走完？ | `src/index.ts` |
| 02 | [Agent 循环与流式协议](./02-agent-loop.md) | 模型、工具、消息历史怎样交替？ | `src/agent/loop.ts` |
| 03 | [工具契约与声明式设计](./03-tool-contract.md) | 一件工具为什么不只是代码？ | `src/types.ts`、`src/core/spec.ts` |
| 04 | [创建、测试、定级与入库](./04-create-tool.md) | `create_tool` 怎样把想法变成能力？ | `src/agent/meta-tools.ts`、`src/core/review.ts` |
| 05 | [执行闸门、权限与隔离](./05-execution-security.md) | 调用如何被校验、执行、审计？ | `src/core/bus.ts`、`src/executors/` |
| 06 | [工具召回、上下文与缓存](./06-context-cache.md) | 工具变多以后怎样控制上下文？ | `src/core/retrieve.ts`、`src/index.ts` |
| 07 | [桌面状态、IPC 与 MCP](./07-ui-and-mcp.md) | 核心如何接入界面和外部工具？ | `electron/`、`src/ui/`、`src/mcp/` |
| 08 | [扩展系统与验证设计](./08-extend-and-verify.md) | 如何安全地加能力并证明没改坏？ | `test/`、`scripts/`、`AGENTS.md` |

## 先记住这五个不变量

这五条比背目录更重要：

1. **普通工具调用只走 `executeTool()`。** 否则可用性检查、参数校验或审计会被绕过。
2. **外部工具规格只走 `normalizeTool()`。** 创建、读取仓库和导入包共用同一个规范入口。
3. **状态与信任等级不是一回事。** `status` 管生命周期，`trust` 描述能力风险，`sessionId` 管临时可用范围。
4. **错误是模型下一步的输入。** 错误消息必须指出哪里错、怎样修，而不是只抛一个笼统的 `failed`。
5. **安全是分层降级且有边界的。** 扫描、权限、子进程、审核和审计各有盲区，不能相互冒充。

## 最短源码阅读清单

时间有限时，按这个顺序读：

```text
src/types.ts
  ↓ 理解 Tool / Permissions / ToolResult / AgentEvent
src/index.ts                 ToolForge.chat / runTool
  ↓
src/agent/loop.ts            runLoop / streamOnce
  ↓
src/agent/meta-tools.ts      createTool
  ↓
src/core/bus.ts              executeTool
  ↓
src/executors/declarative.ts + src/executors/script.ts
```

读完后再补 `store.ts`、`review.ts` 和 `retrieve.ts`，就能掌握核心闭环。

## 环境准备

```bash
pnpm install
pnpm shared:deps
pnpm typecheck
pnpm test
```

Node 20+ 可运行，推荐 Node 22+。`shared:deps` 构建离线依赖白名单；不做依赖工具实验时，它不是理解 Agent 循环的前置知识，但干净 clone 后建议先构建，避免把“白名单目录尚未生成”误判成业务 bug。

后续实验建议使用独立数据目录：

```powershell
# PowerShell 示例
$env:TOOLFORGE_HOME = Join-Path $env:TEMP "toolforge-learning"
pnpm selftest
```

```bash
# macOS / Linux 示例
TOOLFORGE_HOME="$(mktemp -d)/toolforge-learning" pnpm selftest
```

## 学完后你应该能做什么

- 不靠框架，手写一个带工具调用的最小 Agent 循环。
- 解释流式 `tool_calls` 为什么不能逐片直接执行。
- 设计一份兼顾模型选择、参数校验和权限治理的工具规格。
- 区分“测试通过”“自动放行”“人工批准”“本会话可用”。
- 给工具增加一种新的执行类型，并补齐规格、分发、元工具 schema 和测试。
- 找到上下文抖动、缓存失效、历史截断和工具结果过大的原因。
- 对安全能力作准确陈述：知道系统防了什么，也知道没防什么。

下一步：[01 · 整体架构与调用链](./01-architecture.md)
