# 03 · 工具契约与声明式设计

上一篇：[02 Agent 循环](./02-agent-loop.md) · 下一篇：[04 创建与审核](./04-create-tool.md)

## 本篇目标

本篇把一件工具拆成规格、实现、权限、用例和状态。重点源码：[`src/types.ts`](../src/types.ts)、[`src/core/spec.ts`](../src/core/spec.ts)、[`src/core/template.ts`](../src/core/template.ts)、[`src/executors/declarative.ts`](../src/executors/declarative.ts)。

## 1. 工具不是函数，而是一份可治理契约

一个普通函数通常只回答“输入什么、怎样计算”。`Tool` 还要回答：

- 模型凭什么知道何时调用它？——`name`、`description`、`meta.tags`；
- 参数是否合法？——`input` JSON Schema；
- 能力怎样实现？——`kind` 与 `impl`；
- 它能接触哪些外部资源？——`permissions`；
- 创建时怎样验收？——`examples`；
- 当前能否使用、谁可以临时用？——`status`、`trust`、`sessionId`；
- 重建后怎样追溯？——`version`、`meta.review`、`meta.lastRun`。

这些字段使同一个对象能同时服务于模型、执行器、审核界面、仓库和审计。

## 2. `normalizeTool()`：外部输入的唯一规范入口

[`src/core/spec.ts`](../src/core/spec.ts) 的 `normalizeTool(raw)` 接收不完全可信的 `RawTool`，返回新的规范 `Tool`，不修改入参。它负责：

1. 校验工具名、描述和 `kind`；
2. 给 JSON Schema 补默认结构；
3. 按 `kind` 整理 `impl`；
4. 补齐空权限，规范化域名和用例；
5. 校验三方依赖声明；
6. 给状态、信任等级、版本和元数据提供默认值。

### 名称与描述不是小事

名称须小写字母开头，只含小写字母、数字、下划线，长度 2～50。描述至少 8 个字符，但“至少 8 字”只是下限，不代表检索质量合格。

```text
差：处理数据
好：统计英文文本中的单词频率，返回按次数降序排列的 { word, count } 数组
```

描述既影响模型选择，也参与 [`retrieve.ts`](../src/core/retrieve.ts) 的召回评分。名称、标签和描述不是仓库里的装饰，而是模型的发现接口。

### Schema 默认拒绝额外字段

未提供完整 `input` 时，默认是：

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

调用时 [`bus.ts`](../src/core/bus.ts) 用 Ajv 再校验一次。规格校验与调用校验解决不同问题：前者确保“工具定义合法”，后者确保“这次参数合法”，不能互相替代。

## 3. 五种可创建类型，另有两种内部来源

`create_tool` 暴露的 `kind` 是：

```text
http / transform / compose / script / shell
```

全局 `ToolKind` 还包括：

- `mcp`：由 MCP 适配器根据远端工具生成，不能靠本地 `create_tool` 随便声明；
- `meta`：由内核动态构造的元工具，不作为普通仓库工具保存。

选择优先级是 **`http > transform > compose > script > shell`**。它不是性能排名，而是任意代码与授权风险递增的工程顺序。

## 4. `http`：让宿主代理网络

适合结构稳定的 API 请求。下面是示意规格，不是要求你手工写入 `tool.json`：

```json
{
  "name": "github_repo_info",
  "description": "查询 GitHub 仓库信息，入参 repo 形如 owner/name，返回仓库完整 JSON",
  "kind": "http",
  "input": {
    "type": "object",
    "properties": { "repo": { "type": "string" } },
    "required": ["repo"],
    "additionalProperties": false
  },
  "impl": {
    "method": "GET",
    "url": "https://api.github.com/repos/{{input.repo}}",
    "headers": { "User-Agent": "toolforge" },
    "extract": ""
  },
  "permissions": { "net": ["api.github.com"] },
  "examples": [
    {
      "name": "查询 nodejs/node",
      "args": { "repo": "nodejs/node" },
      "expect": "result.full_name === 'nodejs/node'"
    }
  ]
}
```

执行顺序在 `runHttp()`：

```text
渲染 URL 与 query
  → assertNet 检查最终 URL 的 hostname
  → 渲染 headers / body
  → fetch（带超时）
  → 非 2xx 抛错
  → 尝试 JSON.parse，失败则保留文本
  → extractPath 提取返回值
```

权限按**最终渲染后的 URL**检查，而不是只看规格里的静态字符串。`permissions.net` 支持精确域名与 `*.example.com`，但 `*` 永远不会匹配全网。

## 5. 模板语言：小而够用的数据插值

[`src/core/template.ts`](../src/core/template.ts) 提供：

- `{{input.repo}}`：读取本次入参；
- `{{now}}`：执行时生成的 ISO 时间；
- `{{env.KEY}}`：只来自权限声明允许的环境变量；
- `{{steps[0].result.x}}`：组合工具中读取前序结果；
- `extract: 'data.items[0]'` 或 `$.data.items[0]`：响应取值。

`renderDeep()` 会递归处理字符串、数组和对象，包括对象的键。对象值插入字符串时会 JSON 序列化，找不到的值变为空字符串。

这套模板不是完整表达式语言，不支持算术、过滤管道或任意 JavaScript。需要复杂转换时，优先考虑 `transform` 或 `script`，不要试图把程序塞进 URL 占位符。涉及用户输入的 URL 场景还应自行定义格式约束；当前模板只做字符串替换，不替你完成输入语义校验。

## 6. `transform`：同步纯计算优先

`transform` 的代码不是模块，也不是完整函数声明，而是函数体：

```js
const counts = new Map();
for (const word of String(input.text).toLowerCase().match(/[a-z]+/g) || []) {
  counts.set(word, (counts.get(word) || 0) + 1);
}
return [...counts]
  .map(([word, count]) => ({ word, count }))
  .sort((a, b) => b.count - a.count);
```

对应 `create_tool` 调用中，代码放在 `code` 字段，而不是 `impl`：

```json
{
  "name": "word_frequency",
  "description": "统计英文文本词频，返回按出现次数降序排列的词和次数",
  "kind": "transform",
  "input": {
    "type": "object",
    "properties": { "text": { "type": "string" } },
    "required": ["text"],
    "additionalProperties": false
  },
  "code": "return String(input.text).length;",
  "permissions": {},
  "examples": [{ "name": "空文本", "args": { "text": "" }, "expect": "result === 0" }]
}
```

这里为了展示字段形状把实现缩成一行；真正的词频工具应使用上面的完整函数体和对应结果断言。

`runTransform()` 用 `node:vm` 创建仅含 `input` 与部分内建对象的上下文，禁用字符串和 WASM 代码生成，并设置同步超时。它适合**短、同步、纯计算**。

不要把它宣传为不可信代码的强沙箱：它运行在宿主进程内，`vm` 有已知适用边界，恶意代码审查不能省略。需要异步网络或文件操作时也不要选它。

## 7. `compose`：复用比复制更重要

组合规格：

```json
{
  "name": "repo_then_summarize_shape",
  "description": "查询仓库信息后提取指定字段，演示组合工具的数据传递",
  "kind": "compose",
  "input": {
    "type": "object",
    "properties": { "repo": { "type": "string" } },
    "required": ["repo"]
  },
  "steps": [
    {
      "tool": "github_repo_info",
      "args": { "repo": "{{input.repo}}" }
    },
    {
      "tool": "pick_repo_fields",
      "args": { "data": "{{steps[0].result}}" }
    }
  ]
}
```

此例假设 `pick_repo_fields` 已存在。`runCompose()` 串行执行每一步，把结果累积为：

```ts
results = [
  { tool: 'github_repo_info', result: firstResult },
  { tool: 'pick_repo_fields', result: secondResult }
];
```

返回规则：只有一步时直接返回该步结果；多步时返回完整的 `results` 数组，而不是只返回最后一步。设计后续步骤或断言时必须按这个真实形状处理。

子工具不是直接调执行器，而是通过 `ctx.run` 回到 `ToolForge.runTool()`，并增加组合深度。因此子调用仍走权限、参数校验和审计；`executeTool` 将组合深度限制为最多 5 层，避免无限递归。

## 8. `script`：复杂逻辑的受控出口

脚本入口必须是 CommonJS 导出的函数：

```js
module.exports = async (input, ctx) => {
  const data = await ctx.net.json('https://api.github.com/repos/nodejs/node');
  ctx.log(`loaded ${data.full_name}`);
  return { name: data.full_name, stars: data.stargazers_count };
};
```

网络需要 `permissions.net: ['api.github.com']`。脚本可用的主要上下文：

| API | 用途 |
| --- | --- |
| `ctx.net.get/json/request` | 经域名检查的 HTTP |
| `ctx.fs.read/readJson/list/exists` | 经路径检查的读取 |
| `ctx.fs.write` | 经路径检查的写入；非字符串会 JSON 格式化 |
| `ctx.env(name)` | 读取单独声明的环境变量 |
| `ctx.workspace` | 当前项目目录；未选择时为 `null` |
| `ctx.workdir` | 工具数据目录 |
| `ctx.log` / `ctx.sleep` | stderr 日志、受限睡眠 |

子进程通过 stdin 收一个 JSON 载荷，通过 stdout 返回一个 JSON 结果。日志会重定向到 stderr，避免污染结果协议。实现细节和安全边界见 [05 执行与安全](./05-execution-security.md)。

`script` 可声明 `deps`，版本必须精确，且依赖安装走宿主策略，脚本不能自行执行 `npm install`。提示词中的旧表述“不许 require 第三方包”与当前依赖能力并存；**代码事实以 `spec.ts`、`deps.ts` 和子进程实际加载机制为准**，仅白名单或明确联网策略允许的依赖才可使用。

## 9. `shell`：最后退路，不是通用命令行

`runShell()` 有多层限制：

1. `permissions.exec === true`；
2. 可执行文件在 `SAFE_BINS` 白名单中；
3. 命令字符串不能含 `| & ; < > $ `` 等 shell 元字符；
4. 使用 `execFile(bin, args)`，不是把整串交给交互式 shell；
5. 环境变量只保留声明项与执行所需的基础环境；
6. 有执行超时和 stdout/stderr 长度上限。

不过白名单中的 `node`、`python`、`git`、`curl` 本身能造成很强副作用，所以 `shell` 一律 L3、需人工审核。**可执行文件名白名单不等于命令安全。**

## 10. 持久化时发生了什么

[`src/core/store.ts`](../src/core/store.ts) 在保存 `script` 时：

- 把代码写入 `<tool-dir>/<name>.cjs`；
- `tool.json` 的 `impl` 只保留入口、超时和依赖声明；
- 读取工具时再从入口文件把代码装回 `impl.code`。

因此不要假设导出或仓库里所有逻辑都内嵌在 `tool.json`。工具包导出会通过 `store.get()` 先得到完整运行时规格。

## 动手练习

1. 用 `transform` 创建 `word_frequency`，至少覆盖空文本、重复单词和大小写三组用例。
2. 先故意把 `input.text` 写成 `input.txt`，观察 Ajv 与执行错误有何不同。
3. 创建一件两步 `compose` 工具，预测它的返回是最后一个值还是数组，再运行验证。
4. 比较同一个功能分别用 `http + transform + compose` 和单个 `script` 实现：代码量、权限、可测试性、可复用性各有什么变化？
5. 阅读 `src/core/seed.ts`，说明两件种子工具分别覆盖了哪些契约字段。

下一篇：[04 · 创建、测试、定级与入库](./04-create-tool.md)
