# 07 · 桌面端、IPC 与 MCP

上一篇：[06 上下文与缓存](./06-context-cache.md) · 下一篇：[08 扩展与验证](./08-extend-and-verify.md)

## 本篇目标

核心循环之外，还有两件事决定这个 Agent 好不好用：**界面能不能忠实呈现一轮执行**，以及**外部能力能不能接进来**。本篇解释三条进程边界的划分、`window.tf` 这层桥、正在执行的一轮怎样在切任务后重建，以及 MCP 服务器如何被适配成普通 `Tool`。

重点源码：[`electron/main.cts`](../electron/main.cts)、[`electron/preload.cts`](../electron/preload.cts)、[`src/ui/app.ts`](../src/ui/app.ts)、[`src/ui/index.html`](../src/ui/index.html)、[`src/mcp/client.ts`](../src/mcp/client.ts)。

> 一句话结论：主进程持有 `ToolForge` 与所有密钥，渲染层只拿到 `{ ok, data }` 信封；界面自己不做业务判断，只按事件与返回重建视图。

## 1. 三条边界

| 层 | 能碰什么 | 碰不到什么 |
| --- | --- | --- |
| 主进程（`main.cts`） | `ToolForge`、文件系统、`fetch`、模型 API Key、MCP 子进程 | 直接操作 DOM |
| preload（`preload.cts`） | `ipcRenderer`，按固定清单暴露方法 | Node 的任意模块 |
| 渲染层（`app.ts`） | `window.tf`、`localStorage`、DOM | 文件系统、网络、`require` |

`BrowserWindow` 的配置就是这个边界的落点：

```ts
webPreferences: {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

界面是纯 HTML/CSS/JS，没有打包器，也不走 `tsc` 之外的构建链。`index.html` 里的 CSP 是：

```text
default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'
```

所以 `marked` / `DOMPurify` 不能从 CDN 引入，必须由 `scripts/copy-ui-vendor.mjs` 在构建时拷进 `src/ui/build/vendor/`，再由 `app.ts` 相对路径 import。

## 2. 启动顺序

```text
app.whenReady()
  → boot()
      新建 ToolForge({ onEvent })
      onEvent 里只做一件事：win.webContents.send('tf:event', event)
      await forge.init()          // 种子工具、恢复工作区、连接 MCP
  → createWindow()                // 此时窗口才出现
  → loadFile(src/ui/index.html)
```

`init()` 放在窗口之前，是因为模型、工具仓库与 MCP 连接都属于“能不能开工”的前置条件；窗口先出来只会让用户盯着一个还不能用的界面。

启动器 `bin/start.cts` 会先剔除 `ELECTRON_RUN_AS_NODE` 再拉 Electron，否则双击启动的进程会退化成纯 Node，连窗口都不开。

开发期还有几条环境变量入口，全部只在主进程读：

| 变量 | 作用 |
| --- | --- |
| `TF_SMOKE=1` | 加载完打印桥接状态并退出，用于冒烟 |
| `TF_SHOT=<png>` | 冒烟时截一张图 |
| `TF_SMOKE_JS="<js>"` | 截图前跑一段界面操作，验证非默认页面 |
| `TF_TURN_TIMEOUT` | 把一轮的兜底超时压短，验证“卡住能自动解锁” |
| `TF_PACK_SELFTEST=1` | 在打包形态里跑依赖链路自检 |

## 3. IPC：统一信封与一个 `guard`

所有 handler 都经 `guard()` 包一层：

```ts
// 教学简化
const guard = (fn) => async (...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};
```

于是渲染层永远拿到同一种形状：

```ts
type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };
```

这条约定比“每个 handler 自己 try/catch”重要：界面里所有 `await window.tf.xxx()` 都能用同一个分支处理失败，不会出现某处抛出未捕获的 rejection 把整段逻辑中断。

通道按用途分四组：

| 组 | 通道 |
| --- | --- |
| 对话 | `tf:chat`、`tf:stop` |
| 工具治理 | `tf:state`、`tf:approve`、`tf:reject`、`tf:remove`、`tf:setEnabled`、`tf:setDepPolicy`、`tf:exportPack`、`tf:importPack` |
| 模型与路径 | `tf:saveProvider`、`tf:removeProvider`、`tf:setActiveProvider`、`tf:listProviderModels`、`tf:pickFolder`、`tf:openWorkspace`、`tf:openHome` |
| 元信息 | `tf:about`、`tf:checkUpdate`、`tf:openExternal` |

几个刻意拆开的点：

- **`tf:setDepPolicy` 单独一条**。打开“联网安装白名单外依赖”等于允许 registry 上的代码进本机并被执行，它必须是一次可审计的人工动作，不能混进 `tf:saveProvider` 被顺手改掉。
- **`tf:pickFolder` 只返回路径**，不改全局状态。每个任务各存各的工作区，用在哪条任务是渲染层的决定。
- **`tf:openExternal` 只放行 `https://`**。渲染层里点链接一律经这里，别把任意协议的执行权交出去。
- **`tf:checkUpdate` 先查 `releases/latest`，没有就退回 `tags`**，否则一个还没发版的仓库会永远显示“已是最新”。

`tf:event` 是唯一的单向通道，不返回信封，只推 `AgentEvent`。

## 4. preload 是白名单，不是转发器

`preload.cts` 逐个方法写死，没有 `invoke(channel, ...)` 这种通用入口：

```ts
contextBridge.exposeInMainWorld('tf', {
  state: () => ipcRenderer.invoke('tf:state'),
  chat: (payload) => ipcRenderer.invoke('tf:chat', payload),
  // …每个方法对应一个明确的 handler
  onEvent: (cb) => ipcRenderer.on('tf:event', (_e, data) => cb(data)),
});
```

通用入口等于把整张 IPC 表交给渲染层，一旦 XSS 能执行脚本，就能调用任意主进程能力。新增 IPC 必须**同时**改 `main.cts` 与 `preload.cts`，以及 `app.ts` 里的 `Bridge` 接口——三处漏一处就是运行时 `undefined`。

## 5. 任务状态放在渲染层

桌面端的对话记录不进主进程仓库：

| 数据 | 位置 | 键 |
| --- | --- | --- |
| 任务列表、每个任务的历史与工作区 | `localStorage` | `toolforge.tasks` |
| 侧栏分组折叠状态 | `localStorage` | `toolforge.groups` |
| 侧栏是否收起 | `localStorage` | `toolforge.side` |
| 工具仓库、审计、配置 | `TOOLFORGE_HOME` | 见 [01](./01-architecture.md) |

`Task` 里的 `workspace` 有三种取值，别混：

```ts
type TaskWorkspace = string | 'general' | null;
// 字符串 = 具体文件夹；'general' = 通用工作区；null = 还没选
```

`'general'` 与 `null` 对后端都意味着“不绑定目录”，但界面要靠它区分“用户明确选了通用”和“用户还没选”，所以不能在存的时候先合并成 `null`。

`history` 在渲染层留 60000 字，后端 `trimHistory()` 用 20000 字。**渲染层给得更宽是有意的**：这里只负责别把 `localStorage` 撑爆，真发给模型前由后端按预算裁；如果这里先按后端预算削，前缀就会被提前破坏。

## 6. 正在执行的那一轮：存数据，不存 DOM

这是本文件里最容易被改坏的地方。

```ts
interface LiveRun {
  taskId: string;
  pendingInput: string;
  thinking: string;
  segments: Segment[];
  traceOpen: Map<number, boolean>;
  reasonOpen: Map<number, boolean>;
  started: number;
}
```

`segments` 是按模型实际产出顺序排列的片段：

```ts
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; trace: LiveTrace }
  | { kind: 'reasoning'; text: string; done: boolean };
```

为什么不存 DOM 节点：`renderHistory()` 会 `inner.innerHTML = ''`。如果 `liveRun` 里抓的是节点，切走一次它们就成孤儿——事件继续往里写，用户却永远看不到；切回来时上下文全空。用户随时可能切走，所以这一轮必须能从数据重建。

事件到片段的映射是确定的：

| 事件 | 对 `segments` 做什么 | 对界面做什么 |
| --- | --- | --- |
| `step` | 把上一条文字段封口 | 更新等待文案“第 N 步” |
| `reasoning` | 续写未完成的思考段，或新起一段 | 直接改文字（不整轮重画） |
| `delta` | 续写最后一条文字段，或新起一段 | 按帧合并后重画 |
| `tool_call` | 收尾思考段，push 一个 `ok === undefined` 的工具 | `paintAll()` |
| `tool_result` | 给最后一条还在跑的工具落定 `ok` / `ms` | `paintAll()` |
| `assistant` | 收尾思考段 | 无 |

两条收尾规则：

- `sealReasoning()`：模型开始吐正文或调工具，说明这一步想完了，思考段就地标 `done`。它只改数据、不碰 DOM，紧接着的重画会把它从“思考中…”翻成“思考完成”并自动收起。
- `sealTextSegment()`：新的一步开始时把上一段文字封口，这样“先说一句 → 调工具 → 再说一句”会按真实顺序排开，而不是糊成一整段。

事件处理的第一行是：

```ts
if (!liveRun) return;
const onScreen = activeId === liveRun.taskId;
```

数据永远照收，DOM 只在“这条任务正显示在屏幕上”时才碰。少这个判断，用户在 A 任务看着，B 任务的工具徽章会插进 A 的对话区。

### 两种重画策略

- `paintAll()`：低频事件（步骤、工具开始/结束）直接整轮重建 `.live-turn`，重建前用 `rememberOpen()` 记住用户手动开合过的思考块与工具组。
- `queueReplyPaint()`：流式正文每片都重新解析 Markdown 是 O(n²)，所以用 `requestAnimationFrame` 合并，一帧最多重画一次。

### 收尾必须先让出一次宏任务

```ts
await new Promise((resolve) => setTimeout(resolve, 0));
```

事件走 `webContents.send`，可能比 `chat()` 的返回值晚一拍到渲染层。不让出这一次宏任务，这一轮最后一步的 `reasoning` / `delta` / `assistant` 会赶在 `liveRun = null` 之后才到，被 `if (!liveRun) return` 整批丢掉——表现是“过程块里少了最后一步的思考”，而且时好时坏。`verify:switch` 正是靠这一步才稳定。

## 7. 一轮结束后：过程收进折叠块

`persistProcess()` 把整条 `segments` 写回 `task.process`（同时继续写老字段 `reasoning` / `steps`，供旧数据与旧逻辑读）。

落盘前有两步清理：

1. 去掉尾部空白文字段，免得过程里空一行；
2. 最后一段文字如果就是那句最终总结，从过程里剔掉——否则总结会在“任务过程”和正文里各出现一遍。判断用 `isFinalAnswer()`：流式碎片与后端返回的最终文本偶尔差一两个字符，只要一方是另一方的前缀就认定同一条。

`renderHistory()` 回放时，过程用 `processBlock()` 画成默认收起的 `<details class="process">`，摘要里带思考段数、工具件数、总耗时与失败数。

## 8. 三个兜底，别删

| 机制 | 位置 | 没有它会怎样 |
| --- | --- | --- |
| `startTicker()` / `stopTicker()` | 全局一个 100ms 定时器 | 每个元素各开一个 `setInterval`，轮次结束忘清就是泄漏 |
| `armWatchdog()` / `forceFinish()` | 默认 20 分钟，`?turnTimeout=` 可覆盖 | 任何卡死的请求会让 `busy` 永远为 true，之后所有输入被静默吞掉 |
| `send()` 里 `if (busy)` 的提示 | 弹窗说明“上一轮还在跑，可暂停” | 静默 return 会让人以为输入框坏了 |

`forceFinish()` 与 `send()` 的正常收尾共用同一套清理；两边各写一份，日后必漏。

输入框永远不禁用：`syncComposer()` 只控发送按钮的形态与占位文案。禁用 textarea 会让用户以为程序卡死，而且切到别的任务时他本该能接着说别的事；挡重复提交靠的是 `busy` 标志。

## 9. Markdown 与两类文本

```ts
function markdownToHtml(text: string): string {
  const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
```

- **模型输出**一律走 `markdownToHtml()`：模型可能吐出任意 HTML，必须先渲染再按白名单清洗。
- **用户输入**只用 `textContent`，靠 CSS 的 `pre-wrap` 保留换行，不渲染 Markdown——否则用户输入会被当成标记。

`scrollBottom()` 只在本来就贴着底部时才滚。流式输出时用户往上翻着读，硬拽回底部等于不让人看。

## 10. MCP：把外部工具源适配成 `Tool`

MCP 适配器（[`src/mcp/client.ts`](../src/mcp/client.ts)）解决的是冷启动：刚装好的 Agent 一件工具都没有，而外面已经有一堆现成的 MCP 服务器。

配置在 `~/.toolforge/mcp.json`：

```json
{
  "servers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/work"] }
  }
}
```

连接后每个远端工具被转成统一形状：

```ts
{
  id: `mcp:${server}:${remoteName}`,
  name: slug(`${server}_${remoteName}`),   // 例：filesystem_read_file
  kind: 'mcp',
  input: t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
  impl: { server, remoteName },
  permissions: { net: [], fsRead: [], fsWrite: [], exec: false, env: [] },
  status: 'active',
  trust: 'L1',
  sessionId: null,
}
```

适配过程中值得记住的几点：

- **SDK 是可选依赖。** `loadSdk()` 动态 import，装不上就把 `mcp.available` 置为 false，核心 Agent 照常开机——一个可选的集成不该拦住整个产品。
- **Windows 上 `npx` / `npm` / `pnpm` 是 `.cmd`**，必须 `cmd /c` 转一手，否则 `spawn` 直接 ENOENT。
- **名称要 slug。** 远端工具名可能带点、斜杠、大写，`slug()` 统一成小写字母数字下划线，并加服务器前缀避免重名。
- **调用结果要摊平。** `content` 数组里的 `text` 直接取，`image` 记成 `[图片]`，其余 `JSON.stringify`；`isError` 为真时抛错，让 `executeTool` 统一转成失败结果。
- **连接失败只记录不抛出。** 某个服务器挂了，`status` 里写一行“连接失败：…”，其他服务器照常可用。

### MCP 的安全边界必须说清

`executeTool()` 对 `kind === 'mcp'` 只做三件事：`isUsable`、参数校验、转发调用。**远端工具没有经过本地的静态扫描、没有走 `permissions` 判定、也不在子进程沙箱里**。把它标成 `L1` 只表示“接入方式的风险等级”，不表示它的真实能力已经被审计过。

所以审核 MCP 服务器时要看它自己的实现与配置（尤其 `command` 里跑了什么、`args` 指向哪个目录），而不是看界面上那个 `L1` 标签。

## 11. 改这块时的回归清单

1. 新增 IPC 是否同时改了 `main.cts`、`preload.cts`、`app.ts` 的 `Bridge`？
2. 失败的 IPC 是否仍返回 `{ ok:false }`，而不是抛出到渲染层？
3. 新事件是否在 `if (!liveRun)` 与 `activeId === liveRun.taskId` 两个判断之后才碰 DOM？
4. 切任务时这一轮还能不能重建（`liveRun` 里只存数据）？
5. 流式输出是否仍走按帧合并，而不是每片重解析 Markdown？
6. 新增的定时器是否在轮次结束时停掉？
7. 引入新的前端库时，是否同步改了 `copy-ui-vendor.mjs` 与 `vendor.d.ts`？
8. 改完跑一次 `pnpm verify:switch` 与 `pnpm verify:toolfilter`，确认基线还是绿的。

## 动手练习

1. 用 `TF_SMOKE=1 TF_SHOT=... pnpm start` 截一张设置页，确认桥接与页面都能加载。
2. 在 `liveRun.segments` 里加一种新片段（例如“计划”），只改数据与渲染，不改事件协议，观察切任务后能否重建。
3. 把 `queueReplyPaint()` 换成每片直接 `paintAll()`，用长回答感受卡顿，再改回来。
4. 配一个 MCP 服务器，观察它的工具名被 slug 成什么、召回评分是否命中；再故意写错 `command`，确认只有该服务器状态变红。
5. 打开 `mcp.json` 里一个能写文件的服务器，思考：这类能力为什么不能只靠本地 `trust` 标签判断？

下一篇：[08 · 扩展系统与验证设计](./08-extend-and-verify.md)
