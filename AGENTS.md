# AGENTS.md

给在本仓库里干活的人和 Agent 看的说明书。产品介绍见 [README.md](./README.md)，这里只讲「怎么改、别踩哪」。

## 一句话

ToolForge 是一个「一切皆 Tool」的桌面 Agent：内核只有一个 LLM 循环，Agent 缺能力就用 `create_tool` 现造一件工具，经静态扫描 + 用例验证 + 信任分级后入库。

## 命令

```bash
pnpm install          # 首次；国内网络需先设 ELECTRON_MIRROR（见 pnpm-workspace.yaml 注释）
pnpm build            # tsc 两次：主进程/CLI（tsconfig.json）+ 渲染层（tsconfig.ui.json）
pnpm typecheck        # 只检查不产出
pnpm test             # 先 build，再跑 dist/test/loop.test.js
pnpm selftest         # 端到端自检：造工具全链路 13 个断言，CI 里最好也跑
pnpm start            # Electron 桌面端
pnpm cli              # 终端 REPL（/work /create /tools /approve <id> /exit）
```

跑单个测试文件：`pnpm build && node --test dist/test/loop.test.js`。

## 目录地图

| 路径 | 职责 |
| --- | --- |
| `src/types.ts` | 全局契约（Tool / Permissions / ToolResult / AgentEvent）。改它等于改全系统 |
| `src/index.ts` | `ToolForge` 门面：init / chat / runTool / approve / state / pack |
| `src/core/spec.ts` | 原始规格 → 规范 Tool 的唯一入口，校验失败信息直接回灌模型 |
| `src/core/store.ts` | 工具仓库读写（`~/.toolforge/tools/<id>/`），带内存缓存与版本快照；`isUsable()` 是「能不能用」的唯一判定 |
| `src/core/bus.ts` | `executeTool`：唯一的执行闸门（状态 → 参数校验 → 分发 → 审计） |
| `src/core/review.ts` | 静态扫描规则、按能力定级、跑自带用例 |
| `src/core/permissions.ts` | 域名/路径/环境变量白名单判定 |
| `src/core/retrieve.ts` | 两级召回，只把相关工具 schema 注入模型 |
| `src/core/models.ts` | 多模型服务商：DeepSeek/Kimi 预设、自定义合并、选中判定 |
| `src/core/{template,audit,pack,paths,seed}.ts` | 占位符取值、审计日志、工具包导入导出、目录常量、种子工具 |
| `src/executors/declarative.ts` | http / transform / shell / compose 四种声明式实现 |
| `src/executors/script.ts` | 起子进程跑脚本类工具，试探 `--permission` 开关 |
| `src/executors/runtime-child.cts` | 沙箱引导层：锁 `Module._load`，注入受控 `ctx.net` / `ctx.fs` |
| `src/agent/{loop,prompts,meta-tools}.ts` | LLM 循环、两套人格提示词、元工具（list/search/create） |
| `src/mcp/client.ts` | 可选 MCP 适配器，SDK 没装也要能开机 |
| `src/ui/` | 纯 HTML/CSS/JS 渲染层，`app.ts` 只经 `window.tf` 通信；`vendor.d.ts` 声明 marked/dompurify |
| `scripts/copy-ui-vendor.mjs` | 构建时把 marked / dompurify 的 ESM 产物拷到 `src/ui/build/vendor/`（CSP 禁 CDN，界面无打包器） |
| `electron/` | `main.cts` 主进程 + IPC handler，`preload.cts` 桥接白名单 |
| `bin/cli.ts` | REPL 与 `--selftest` |
| `bin/start.cts` | 启动器：剔除 `ELECTRON_RUN_AS_NODE` 再拉 Electron |

## 硬约束

1. **所有执行必经 `executeTool`**（`src/core/bus.ts`）。别在别处直接调执行器，否则绕过权限门、参数校验和审计。
2. **规格必经 `normalizeTool`**（`src/core/spec.ts`）。入库、导入包、MCP 转工具都走它，返回新对象，不改入参。
3. **模型输出一律过 `markdownToHtml`**（`src/ui/app.ts`）：marked 渲染后必须经 DOMPurify 白名单清洗，模型可能吐出任意 HTML。用户输入则只用 `textContent`，不渲染 MD。
4. **流式增量用 `AgentEvent.type === 'delta'`**：主进程 `runLoop` 已经把 SSE 碎片拼回完整 message，新增事件类型时别破坏这个形状。
5. **错误信息是产品的一部分**。`normalizeTool` / `validateArgs` / 沙箱抛的错会被原样喂回模型，写清楚「哪里不对、怎么改」。
6. **脚本代码不落 `tool.json`**，写到 `<id>/<name>.cjs`；`store.read()` 时再读回 `impl.code`。
7. **`src/types.ts` 是契约**。加字段只能加可选字段，不删不改名（旧仓库里的 `tool.json` 可能还在用老结构）。
8. **不新增依赖**。HTTP 用内置 `fetch`，schema 校验用已有的 `ajv`，动画/UI 框架一律不进。
9. **注释与用户可见文案用中文**，写「为什么这么写」而不是「这行在做什么」。
10. **ESM 内部 import 带 `.js` 后缀**（NodeNext 解析）；`.cts` 文件里写 CommonJS，产物是 `.cjs`，用于 Electron 主进程和沙箱引导层。
11. **「工具能不能用」只有一处判定**：`store.isUsable(tool, sessionId)`。`store.usable()` 与 `executeTool` 都调它，别再各写一遍条件。
12. **同名重建自动升 patch 版本**（`store.save` 里的 `bumpPatch`），旧规格先落 `.history/` 快照；`store.patch()` 只改状态、传 `bump: false` 不升版本。
13. **参数校验器的缓存键要带 schema**。同名工具重建后 schema 会变，只按名字缓存会把旧校验器套到新规格上。

## 加一种新工具类型（kind）

按顺序改，漏一处就会出现「能造不能跑」或「能跑但 UI 不认」：

1. `src/types.ts` → `ToolKind`
2. `src/core/spec.ts` → `KINDS`、`KIND_LABEL`、`normalizeImpl()` 分支
3. `src/core/bus.ts` → `executeTool` 的分发分支（或落进声明式执行器）
4. `src/executors/declarative.ts` → 若为声明式，加 `runXxx`
5. `src/agent/meta-tools.ts` → `createToolSchema.kind.enum` + `buildImpl()`
6. `src/agent/prompts.ts` → 锻造师人格里的优先级清单（决定模型什么时候选它）

新增 `kind` 后跑 `pnpm selftest`，至少补一条用例覆盖它。

## 安全模型（改动前务必理解）

三层防线，都不完备，别宣传成「沙箱」：

- **能力声明**：`permissions` 默认全空；域名白名单不支持 `*`；路径必须落在工具目录内。
- **进程隔离**：脚本工具起子进程，优先用 Node 的 `--permission`（Node 22+）/ `--experimental-permission`（Node 20），逐个试探，都不行就**降级为无 OS 级隔离**（`permDisabled`），这是已知取舍。探测结果经 `permissionSupport()` 进 `ForgeState.sandbox`，设置页会如实显示；`probed: false` 表示本次启动还没跑过脚本工具，不能声称隔离已生效。
- **模块拦截**：`runtime-child.cts` 里改写 `Module._load`，掐断 http/https/net/child_process，工具只能用注入的 `ctx.net` / `ctx.fs`。
- **路径守卫只有一份**：真正拦路径的是 `runtime-child.cts` 的 `guardFs`，宿主侧不再另留一份等价实现。

定级按能力走，不按来源：`L0` 无权限 / `L1` 只读网络或沙箱跑代码 / `L2` 写盘或读密钥 → 转人工 / `L3` 可执行命令或静态扫描命中高危 → 转人工。改 `grade()` 会同时影响自动放行策略，改之前先看 `test/loop.test.ts` 里的定级用例。

## 状态机

```
untested ──用例通过、低危──> active
   │                          ↑
   └─用例通过、需人工──> pending ──approve──> active
                          └──reject──> rejected
```

`sessionId` 非空的工具即使未放行，也只在创建它的那次会话里可用；这条判定收在 `store.isUsable()` 一处，`store.usable()` 与 `executeTool` 都走它。放行时清空 `sessionId` 转为常驻。

## 验证要求

- 非平凡改动后跑 `pnpm typecheck`，再跑 `pnpm selftest`（走完整链路：造工具、用例门槛、定级、跨会话隔离、审计）。
- 只改 UI 时也要跑一次 `pnpm build`，`src/ui/build/app.js` 是产物且被 gitignore，`index.html` 直接引它。
- 测试一律把 `TOOLFORGE_HOME` 指到临时目录，别污染真实的 `~/.toolforge`。
- 非平凡逻辑要留一条能失败的检查：`test/loop.test.ts` 里新增断言后，用变异验证一次（把被测逻辑改坏，确认断言真的红），再改回来。

## 常见坑

- **Windows 下 npx/npm/pnpm 是 `.cmd`**，MCP 连接必须经 `cmd /c` 转一手（`src/mcp/client.ts` 已处理）。
- **Electron 内置的 Node 未必支持权限开关**，`runScript` 的 `badFlag` 判定靠 stderr 关键字，别把工具自身的报错误判成降级。
- **渲染层没有 Node**：`contextIsolation: true`、`sandbox: true`，CSP 禁内联脚本。新 IPC 必须同时在 `preload.cts` 白名单里出现。
- **前端第三方库要靠构建脚本拷贝**：界面无打包器，`marked` / `dompurify` 由 `scripts/copy-ui-vendor.mjs` 复制进 `src/ui/build/vendor/`（该目录被 gitignore），加新库时记得同步改脚本并补 `vendor.d.ts` 声明。
- **模型上下文会被撑爆**：结果超 12000 字在 `clampForModel` 截断，工具注入走 `selectTools` 召回，别改成全量注入。
- **流式渲染要按帧合并**：`delta` 事件可能几十毫秒来一片，每片都 `markdownToHtml` 重解析是 O(n²)，`app.ts` 用 `requestAnimationFrame` 节流。别把这一层去掉。
- **别在流式输出时强制 `scrollTop` 到底**：用户往上翻着读时硬拽回底部等于不让人看，`scrollBottom()` 只在贴底时才滚。
- **截图验证**：`TF_SMOKE=1` 会加载完即退出并打印桥接状态；再加 `TF_SHOT=<png 路径>` 落一张截图，`TF_SMOKE_JS="<js>"` 可在截图前跑一段界面操作（例如点开设置页），用来验证非默认页面。
