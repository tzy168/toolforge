# 05 · 执行闸门、权限与隔离

上一篇：[04 创建与审核](./04-create-tool.md) · 下一篇：[06 上下文与缓存](./06-context-cache.md)

## 本篇目标

本篇回答三个问题：一次普通工具调用必经哪些检查？`script` 的父子进程怎样通信？现有安全边界在哪里？

重点源码：[`src/core/bus.ts`](../src/core/bus.ts)、[`src/core/permissions.ts`](../src/core/permissions.ts)、[`src/executors/script.ts`](../src/executors/script.ts)、[`src/executors/runtime-child.cts`](../src/executors/runtime-child.cts)、[`src/core/audit.ts`](../src/core/audit.ts)。

> 本篇先给结论：ToolForge 当前是**多层防护的工程运行时**，不是可安全执行任意敌意代码的形式化沙箱。理解边界和理解防线同样重要。

## 1. `executeTool()`：唯一的普通工具执行闸门

核心顺序：

```text
输入 Tool + args + { sessionId, depth, runner }
  │
  ├─ 1. 组合深度检查
  ├─ 2. isUsable(tool, sessionId)
  ├─ 3. Ajv 校验 args
  ├─ 4. 按 kind 分发
  │     ├─ mcp    → callMcpTool
  │     ├─ script → runScript
  │     └─ 其他   → runDeclarative
  ├─ 5. 记录 lastRun（MCP 除外）
  ├─ 6. 写 tool_call 审计
  └─ 7. 返回统一 ToolResult
```

异常被转换为 `{ ok:false, error, ms }`，因此调用方能统一展示和回灌。不要因为某个执行器会抛错，就在 Agent 层另写一套参数和权限逻辑。

### Ajv 校验器缓存

`validatorFor()` 的缓存键是：

```text
tool.name + "\u0000" + JSON.stringify(tool.input)
```

只按名字缓存会产生真实 bug：同名工具重建后 schema 已变，旧校验器却还在。当前键把 schema 内容纳入身份，是自然且必要的缓存失效策略。

### 统一返回与模型截断是两步

- `executeTool()` 返回原始 `result`，供 UI、组合工具和后续代码使用；
- `runLoop()` 调用 `clampForModel()` 后，才把最长 12000 字的字符串放进模型消息。

不要把截断逻辑塞进执行器，否则 compose 的子步骤也会意外丢数据。

## 2. 权限声明不是权限执行

`Permissions` 默认全空：

```ts
{
  net: [],
  fsRead: [],
  fsWrite: [],
  exec: false,
  env: []
}
```

声明描述工具“应该能做什么”，真正的拦截发生在执行路径：

| 能力 | 声明 | 主要执行检查 |
| --- | --- | --- |
| 声明式 HTTP | `net` | `assertNet()`，检查渲染后 URL 的 hostname |
| script HTTP | `net` | 子进程 `rawRequest()` 内的 `hostOk()` |
| script 文件 | `fsRead/fsWrite` | 子进程 `guardFs()` |
| 环境变量 | `env` | `pickEnv()` 与 `ctx.env()` |
| 外部命令 | `exec` | `execAllowed()`，再加命令与参数约束 |

如果新增执行器忘了调用相应检查，`permissions` 就只是 UI 上的文字。这就是为什么每加一种 `kind`，都必须同时审规格、分发、执行与测试。

## 3. 域名与环境变量

`hostAllowed()` 支持：

```text
api.github.com       只匹配这个主机
*.example.com        匹配 example.com 及其子域
*                    永远拒绝，不能开放全网
```

`normalizePermissions()` 会把带协议的输入收敛为 hostname，但仍应直接写域名，避免产生错误直觉。URL 的用户信息、端口、路径不是权限匹配维度；检查依据是 `new URL(...).hostname`。

环境变量采用逐项复制：

- 声明式模板只看到 `pickEnv(tool)` 返回的变量；
- script 子进程基础环境只保留 `PATH`、`SYSTEMROOT` 等必要项，再叠加声明变量；
- `ctx.env('KEY')` 还会检查 `allowedEnv`。

这不等于密钥永远不会泄漏：工具一旦能读密钥，又能访问网络，就可能把密钥发送出去。因此 `env` 定级为 L2，审核时必须把网络权限一起审查。

## 4. 工作区与路径解析

特殊根 `@workspace` 表示用户为当前任务选择的项目目录。每轮 `ToolForge.chat({ workspace })` 会显式调用 `setWorkspaceDir()`，再构造提示词和运行工具，避免只依赖 UI 先异步同步一个全局开关。

### 默认根

子进程 `guardFs()` 中：

- 读取的默认根是工具目录 `toolDir`；
- 写入的默认根是工具数据目录 `dataDir`，即 `.data`；
- `@workspace` 是另一个候选根，指向当前项目。

例如：

```ts
permissions: { fsRead: ['@workspace'] }
ctx.fs.read('src/index.ts')
```

在已选工作区时，解析候选依次是：

```text
<toolDir>/src/index.ts       不在 @workspace 授权根内，拒绝
<workspace>/src/index.ts     在 @workspace 内，允许
```

若同时声明工具目录规则与 `@workspace`，首个满足规则的候选路径胜出。这样既能读工具自带资源，也能用自然相对路径访问项目。

`ctx.fs.write('notes/a.txt', ...)` 在 `fsWrite:['notes']` 时指向 `<toolDir>/.data/notes/a.txt`；要改项目文件，则必须声明 `fsWrite:['@workspace']`，并使用能解析到项目内的路径。

### 目录边界

判断基于 `path.resolve` 后的目录包含关系：目标可以等于根目录，或位于 `root + path.sep` 之下。未选择工作区时，`@workspace` 不会变成一个可猜出的磁盘路径。

但当前实现不是完整的文件系统安全证明：

- 文本路径检查不等同于解析所有符号链接后的真实路径策略；
- 声明权限与 Node OS 权限开关不是同一层；
- 运行时不支持权限模型时会降级，见下一节；
- 绝对路径规则的授权需要额外谨慎，不能因为它不是 `@workspace` 就视为天然安全。

## 5. `script`：父进程负责资源，子进程负责运行

[`runScript()`](../src/executors/script.ts) 先准备：

```text
entry      工具目录中的 <name>.cjs
toolDir    工具根目录
dataDir    工具 .data 目录
workspace  当前工作区或 null
perm       权限声明
input      本次参数
```

这些信息序列化成 JSON，经 stdin 发给子进程。子进程运行编译后的 `runtime-child.cjs`，加载工具入口并调用：

```js
const fn = require(entry);
const result = await fn(input, ctx);
```

结果经 stdout 返回：

```json
{ "ok": true, "result": {} }
```

或：

```json
{ "ok": false, "error": "具体错误" }
```

父进程设置执行超时，到期强制结束子进程；脚本返回不可序列化或超过 2MB 的结果时，引导层返回错误。日志重定向到 stderr，以免 `console.log()` 破坏 stdout 的单 JSON 协议。

### 为什么用进程而不是只传回调

独立进程让运行时可以：

- 限制堆内存（当前启动参数为 256MB）；
- 使用 Node 文件与子进程权限模型；
- 在超时后终止执行；
- 在加载用户脚本前准备受控模块环境；
- 用简单的 stdin/stdout 协议隔离结果与日志。

但进程隔离本身不自动限制文件和网络；下面的权限开关与模块拦截才是关键。

## 6. Node 权限开关：能力探测与降级

`PERM_FLAGS` 依次尝试：

```text
--permission
--experimental-permission
无权限开关（降级）
```

启用权限模型时，启动参数只额外放行：

- 读取工具目录；
- 读取 `runtime-child.cjs`；
- 写入工具 `.data`；
- 声明 `@workspace` 时，读取或写入当前工作区。

没有机械地把每条 fs 规则都转成 `--allow-fs-*`。某些通配或尚未创建的路径在 Node 权限参数解析时可能直接导致进程退出，这是源码注释记录过的实际兼容性问题。

当 stderr 明确显示运行时不认识当前 flag，父进程尝试下一个；不能把普通工具错误一律误判为“权限开关不支持”。若全部不可用，则设置 `permDisabled`，以后不再带 OS 文件权限开关运行。

`permissionSupport()` 返回：

```ts
{ probed: boolean, flag: string | null }
```

- `probed:false`：本次启动尚未跑过 script，不能声称隔离已启用；
- `flag:'--permission'` 等：探测到的启动开关；
- `flag:null` 且已探测：已降级，无这层 OS 文件权限隔离。

Electron 内置 Node 与系统 Node 的能力可能不同，所以开发机验证通过不等于打包后相同。

## 7. 模块拦截与受控 `ctx`

子进程引导层先加载自己所需的原生模块，再改写 `Module._load`：

- 阻止 `http/https/net/tls/dgram/http2/undici` 等直接网络模块；
- 阻止 `child_process/cluster/worker_threads/inspector` 等模块；
- 其他模块交给原始加载器；
- 工具网络必须走 `ctx.net`，文件必须走 `ctx.fs`。

`ctx.net` 的响应体有 5MB 上限；`ctx.fs` 的每个操作先经过 `guardFs()`；`ctx.env` 只读白名单变量。

**修改 `Module._load` 是运行时约束，不是形式化边界。** 静态扫描能识别部分显式绕过，但不能证明所有混淆、依赖行为和运行时技巧都安全。尤其允许三方依赖后，审核对象不只是入口文件，还包括整棵依赖树。

## 8. 声明式执行器也有不同风险面

不要把“只有 script 需要注意安全”当成结论：

- `http` 在宿主进程发请求，依赖 hostname 白名单和输入约束；它还可能访问用户内网中明确被授权的地址。
- `transform` 在宿主 `node:vm` 中同步执行，有超时但不是独立进程。
- `compose` 的每个子工具各自过闸门，但父工具描述不一定完整呈现子工具的全部副作用。
- `shell` 即使可执行文件在白名单内，`node/python/git/curl` 的参数也能带来高风险行为，因此统一 L3。
- `mcp` 把调用交给独立外部服务器；本地 `Tool` 形状不代表远端实现已经经过同样的扫描与沙箱。

权限审核要看**最终能力组合**，不是只看 `kind` 名称。

## 9. 审计：记录什么，没记录什么

`executeTool()` 无论成功失败都会尝试追加 `tool_call`：

```json
{
  "ts": "ISO 时间",
  "type": "tool_call",
  "tool": "工具名",
  "kind": "script",
  "trust": "L1",
  "sessionId": "s_...",
  "ok": true,
  "ms": 12,
  "args": "截断后的参数摘要",
  "error": null
}
```

参数和错误会摘要化，避免默认写入超大文本。还有创建、审核、模型错误、依赖安装、人工批准等事件。

需要知道的边界：

- 日志在本机普通 JSONL 文件中，不是防篡改日志；
- 写入失败被吞掉，不阻断业务；
- 摘要仍可能包含敏感内容，不能当成自动脱敏系统；
- `lastRun` 记健康状态，审核记录和审计流水则是不同数据结构。

## 10. 做一次安全审查时的清单

新增或修改工具执行能力时，至少问：

1. 是否所有普通调用都经过 `executeTool()`？
2. schema 能否拒绝多余参数与危险输入形状？
3. 权限是否默认最小，UI 是否完整展示组合风险？
4. 域名和路径检查是否作用于**解析后的最终目标**？
5. 用例运行前是否已经允许代码执行？创建流程的授权顺序是否诚实？
6. Node 权限开关不可用时，界面和文档是否明确降级？
7. 依赖、MCP 与 shell 是否越过了本地入口代码审查的假设？
8. 错误是否可修正，审计是否足够定位，又不夸大脱敏能力？

## 动手练习

1. 调用 `text_stats` 时多传一个字段，定位错误从 Ajv 到 `ToolResult` 再到模型消息的路径。
2. 创建一个声明 `net:['example.com']` 的脚本，分别请求允许和未允许域名，比较错误。
3. 创建只读 `@workspace` 的脚本，在选中和未选中目录两种情况下读取同一路径。
4. 查看 `buildScriptArgs()`，解释为什么不能简单把 `fsRead:['**']` 直接拼成 `--allow-fs-read=...`。
5. 运行一次 script 后查看 `tf.state().sandbox`，不要只看静态代码就声称当前启用的是哪一种隔离。

下一篇：[06 · 工具召回、上下文与缓存](./06-context-cache.md)
