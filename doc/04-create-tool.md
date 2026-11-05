# 04 · 创建、测试、定级与入库

上一篇：[03 工具契约](./03-tool-contract.md) · 下一篇：[05 执行与安全](./05-execution-security.md)

## 本篇目标

本篇追踪 `create_tool` 的完整生命周期。重点源码：[`src/agent/meta-tools.ts`](../src/agent/meta-tools.ts)、[`src/core/review.ts`](../src/core/review.ts)、[`src/core/store.ts`](../src/core/store.ts)。

## 1. 元工具：让核心循环不必懂“创建”

元工具定义在 `metaToolDefs`，目前包括：

| 名称 | 作用 |
| --- | --- |
| `list_tools` | 查看仓库完整状态，标出当前可调用项与损坏项 |
| `tool_search` | 用轻量索引检索可用工具 |
| `create_tool` | 创建、测试、定级并保存工具 |
| `manage_tool` | 查看、开关和删除仓库工具；删除需显式确认并先备份 |

`ToolForge.allTools()` 把这些定义转换为统一的 `Tool` 形状，`ToolForge.runTool()` 再把调用路由到对应 handler。模型看到的仍然是名字、描述和 JSON Schema。

这意味着“创造工具”不是 `runLoop()` 的一个特判。循环只看到一个工具调用，结果也按普通 `role=tool` 消息回灌。

## 2. 创建流程的真实顺序

`createTool(args, ctx)` 的主线如下：

```text
A. buildImpl + normalizeTool
   不合规 → 返回 stage=spec，不保存
   合规   → status=untested，记录当前 sessionId
        │
        ▼
B. store.save
   保存工具；同名重建处理版本与历史快照
        │
        ▼
C. staticScan
   对代码做启发式扫描，得到 findings；此时尚未决定 trust
        │
        ▼
D. 依赖闸门
   白名单外 + 联网开关关闭
   → pending / L3，不安装、不跑用例，返回 stage=deps
        │
        ▼
E. 安装允许的依赖并记录来源
   白名单复制，或开关允许时联网安装
        │
        ▼
F. runExamples
   经 executeTool 执行工具，再评估 expect
        │
        ▼
G. grade + 状态落盘
   用例失败 → untested
   用例通过且 grade.approved → active
   用例通过但需人工 → pending
```

这里有两个必须按源码理解的细节：

1. **规格合法后会先保存，再跑用例。** 用例失败的工具以 `untested` 留在仓库，供检查和重造，不是“磁盘上完全不存在”。
2. **静态扫描结果不会天然阻止后续用例执行。** 高危命中主要影响最终 L3 与人工审核；测试本身仍是在当前会话上下文中执行工具。不能把流程描述成“先证明安全，再第一次运行”。

## 3. 规格失败与执行失败是不同返回

规格失败：

```json
{
  "ok": false,
  "stage": "spec",
  "error": "description 太短：……",
  "hint": "按提示改规格，再调一次 create_tool"
}
```

用例失败则已经存在工具记录，返回包括：

- `stage: 'test'`；
- `tool.status: 'untested'`；
- 每条用例的 `note`；
- 同名修改后重新 `create_tool` 的提示。

`create_tool` handler 对很多业务失败返回的是“成功执行的元工具调用 + JSON 字符串里的 `ok:false`”。也就是说，外层 `ToolResult.ok` 表示**创建处理器是否正常运行**，内层 `ok` 才表示**工具是否通过创建验收**。读取结果时要区分两层。

## 4. 自带用例怎样运行

[`runExamples()`](../src/core/review.ts) 接收一个外部注入的 runner，避免 review 模块直接依赖完整调度链：

```ts
// 创建流程注入的 runner，教学简化
const runner = async (tool, args) => {
  const result = await executeTool(tool, args, {
    sessionId: currentSession,
    runner: composeRunTool,
  });
  if (!result.ok) throw new Error(result.error);
  return result.result;
};
```

每条 `example` 包含 `args` 与可选 `expect`：

```json
{
  "name": "大小写混合",
  "args": { "text": "aBcD" },
  "expect": "result === 2"
}
```

执行完成后，`expect` 在 `node:vm` 上下文中以 `Boolean(<expression>)` 求值，作用域提供 `result`，表达式超时为 1 秒。每条结果记录名称、通过状态、耗时、说明与成功样本摘要。

### 好用例应该测什么

至少覆盖：

- 一个正常输入，验证返回结构而不只是“不抛错”；
- 一个边界输入，例如空文本、空数组；
- 一个能区分错误实现的断言，例如精确值或排序；
- 涉及权限时，验证允许路径成功、未授权目标被拒绝。

不要写恒真断言，也不要只检查 `result` 存在。测试是创建门槛，不是生成文档时的装饰。

## 5. 信任定级：按能力，而不是按作者

`grade(tool, findings)` 的规则可以概括为：

```text
白名单外依赖                     → 最终钉为 L3，needsHuman=true
存在 high 级扫描命中             → L3
kind=shell 或 permissions.exec   → L3
fsWrite 非空或 env 非空          → L2
net/fsRead 非空或 kind=script    → L1
以上都没有                       → L0
```

依赖规则不是简单提前返回：即使已经确定白名单外依赖导致 L3，仍继续计算文件、网络、命令等风险，以便审核者看到完整理由。

注意几个容易误判的例子：

| 工具 | 等级 | 原因 |
| --- | --- | --- |
| 无权限 `transform` | L0 | 纯计算 |
| 无额外权限 `script` | L1 | 仍要执行代码 |
| 只读 `script` + `fsRead:['@workspace']` | L1 | 能看用户项目 |
| 只写自己 `.data` 的 `script` | L2 | 任何 `fsWrite` 都需人工 |
| 读指定 API Key 环境变量 | L2 | 能接触密钥 |
| `shell: echo hello` | L3 | 类型本身可执行外部命令 |

`trust` 是风险标签，不自动等价于当前可调用性；后者由状态和会话共同决定。

## 6. 生命周期状态不是一条单线

核心状态：

| 状态 | 含义 |
| --- | --- |
| `untested` | 初始待验，或用例未通过 |
| `pending` | 用例通过但需人工，或被依赖/审核流程挂起 |
| `active` | 已放行，可跨会话使用 |
| `rejected` | 人工拒绝 |
| `disabled` | 保留规格但停用 |

常见流转：

```text
                  用例通过 + 自动批准
untested  ────────────────────────────→ active
   │                                      ↑
   ├─用例通过 + 需人工→ pending ─approve──┤
   │                         │            │
   │                         └─reject→ rejected
   └─用例失败→ untested

active / pending / rejected ⇄ disabled（具体入口受人工管理规则约束）
```

不要把这张图当作所有 API 的形式化状态机：例如 `approve()` 是显式人工操作，当前并未在每个入口重复检查全部测试条件；`setEnabled(true)` 则明确阻止直接启用 `untested`。修改状态入口时，应补上统一不变量，而不是假设所有路径已经自动相同。

## 7. `isUsable()`：会话是第三个维度

[`src/core/store.ts`](../src/core/store.ts) 将“当前能否调用”集中为一个函数：

```ts
export function isUsable(tool: Tool, sessionId: string | null): boolean {
  return tool.status === 'active' ||
    (tool.sessionId !== null && tool.sessionId === sessionId);
}
```

于是：

- `active` 工具不依赖创建会话；
- 非 `active` 工具若 `sessionId` 与当前会话一致，仍有临时试用通道；
- 换会话后，未正式放行的工具不再可用；
- 人工 `approve()` 会设为 `active` 并清空 `sessionId`，转为常驻。

**临时可用不是安全批准。** 即使工具是 `pending` 或 `untested`，也不能只凭状态字面推断它在创建会话绝对无法执行；真实判定就是上面的函数。创建用例也正是靠这个通道运行的。

`store.usable()` 决定哪些仓库工具进入模型工具池，`executeTool()` 再检查一次，防止直接调用绕过列表过滤。这两处都必须调用 `isUsable()`。

## 8. 依赖闸门为什么在用例之前

跑用例就是执行代码，依赖的安装脚本或模块顶层代码也可能产生副作用。因此依赖策略必须先回答“代码从哪里来”：

1. `deps` 只能是 `script` 的声明，版本必须精确；
2. 命中离线白名单：宿主复制预构建依赖，不联网、不运行安装脚本；
3. 白名单外且联网开关关闭：不安装、不跑用例，创建流程落 `pending / L3`；
4. 白名单外但用户明确开启联网策略：允许安装并跑用例，最终仍为 L3，需人工审核；
5. 安装结果记录版本、integrity（若可得）、来源、体积和传递依赖数量。

联网安装开关由人通过设置页或专门方法控制，并写 `deps_policy` 审计，不应成为 Agent 可随意修改的普通工具参数。

## 9. 版本、快照与缓存失效

`store.save()` 处理同名重建：

- 如果旧、新规格版本相同，自动把新版本提升一个 patch；
- 版本变化时，把旧的 `tool.json` 规格写入 `.history/`；
- `patch()` 用于状态、审核和运行记录，传 `bump:false`，不因一次调用就升版本。

**历史快照是旧规格 JSON，不是整个工具目录的完整代码备份。** 若需要可靠回滚脚本实现，应扩展快照格式，而不是假设 `.history` 已经保存旧 `.cjs`。

同名重建还会影响两个缓存：

- `chat()` 的工具指纹包含 `name@version`，版本变化会重算召回；
- Ajv 校验器缓存键包含工具名与完整 schema，避免旧 schema 套到新实现。

## 10. 审核与审计不是同一件事

- `meta.review`：当前工具的审核记录，含等级、理由、扫描发现和用例结果；
- `meta.lastRun`：最近一次普通执行的健康状态；
- `audit/*.jsonl`：追加式事件流水，包括创建阶段、定级、调用、依赖和人工操作。

审核记录适合 UI 展示“这件工具为什么是这个状态”，审计适合按时间追踪“系统发生了什么”。审计失败当前不会阻断主流程，因此它是重要凭据，但不是一个不可丢失、不可篡改的合规账本。

## 动手练习

1. 在临时 `TOOLFORGE_HOME` 中运行 `pnpm selftest`，把 13 项断言映射到本篇的创建链路。
2. 创建一个断言必败的 `transform`，确认它仍在仓库列表中且状态为 `untested`；再同名修复，观察 patch 版本与历史规格。
3. 创建仅写自己数据目录的 `script`，预测它是 L1 还是 L2，再核对 `meta.review.reasons`。
4. 修改当前 `tf.sessionId` 后调用未放行工具，观察 `isUsable()` 的拦截；恢复原会话再比较。
5. 阅读 `createTool()`，指出静态扫描命中后、用例执行前为什么没有“高危即拒绝运行”的分支。若你要改变这个设计，需要怎样保证创建测试仍可安全进行？

下一篇：[05 · 执行闸门、权限与隔离](./05-execution-security.md)
