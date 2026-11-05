# 08 · 扩展系统与验证设计

上一篇：[07 桌面端与 MCP](./07-ui-and-mcp.md)

## 本篇目标

前七篇解释“现在是什么”。这一篇回答“怎么安全地加东西，以及怎么证明没加坏”。

内容分三块：加一种新 `kind` 的完整改动清单、给工具加三方依赖的正确顺序、仓库里那几套验证脚本各自在证什么。最后是一组可以照着做的实践练习。

重点源码：[`test/loop.test.ts`](../test/loop.test.ts)、[`scripts/`](../scripts/)、[`AGENTS.md`](../AGENTS.md)、[`bin/cli.ts`](../bin/cli.ts)。

> 一句话结论：这个仓库的验证不是“跑一遍看没报错”，而是**每条不变量都留了一个能失败的检查**。

## 1. 加一种新 `kind`

`kind` 是一条穿透整个系统的链路，漏一处就会出现“能造不能跑”或“能跑但 UI 不认”。按顺序改：

| 步 | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `src/types.ts` | 往 `ToolKind` 里加一项 |
| 2 | `src/core/spec.ts` | `KINDS` 数组、`KIND_LABEL` 文案、`normalizeImpl()` 分支 |
| 3 | `src/core/bus.ts` | `executeTool()` 的分发分支，或确认它能落进声明式执行器 |
| 4 | `src/executors/declarative.ts` | 若是声明式，加 `runXxx()` |
| 5 | `src/agent/meta-tools.ts` | `createToolSchema.kind.enum` 与 `buildImpl()` |
| 6 | `src/agent/prompts.ts` | 锻造师人格里的优先级清单 |
| 7 | `test/loop.test.ts` | 至少一条覆盖新类型的用例 |

为什么第 6 步不能省：模型选哪种 `kind` 完全由提示词里的优先级决定。加了类型但没进提示词，等于加了一个模型永远不会选的死代码。

### 第 3 步的判断：要不要单开执行器

```text
这个 kind 需要「进程隔离 / 异步 IO / 外部运行时」吗？
  ├─ 需要 → 像 script 一样单独的执行器，自己负责权限与超时
  └─ 不需要 → 落进 runDeclarative，宿主全程代理 IO
```

声明式优先不是审美偏好：`http` / `transform` / `compose` / `shell` 都在宿主进程里跑，权限检查是 `assertNet()` 这类同步函数，一眼能看全；`script` 是唯一需要子进程、`--permission`、`Module._load` 拦截的路径。新增一种需要任意代码执行的 `kind`，就要重复一遍 `script` 那套复杂度——先问值不值。

### 别忘了执行侧的对应检查

`permissions` 只是声明，真正的拦截在每条执行路径上：

| 能力 | 声明 | 必须在哪检查 |
| --- | --- | --- |
| 网络 | `net` | 声明式用 `assertNet()`；子进程用 `hostOk()` |
| 文件 | `fsRead` / `fsWrite` | 子进程 `guardFs()`；宿主 `pathAllowed()` |
| 环境变量 | `env` | `pickEnv()` 与 `ctx.env()` |
| 外部命令 | `exec` | `execAllowed()` + 命令白名单 |

新执行器忘了调相应检查，`permissions` 就只是设置页上的一行文字。

## 2. 给工具加三方依赖

依赖只能**声明**，不能自己装。工具的 `impl.deps` 是 `{包名: 精确版本}`，只允许 `script` 类声明。

### 版本必须精确的原因

```
1.2.3   ✅ 可复现
^1.2.3  ❌ 半年后装出来另一份代码
latest  ❌ 同上，而且无法审计
git:/file:/http:  ❌ 可指向任意代码
```

`normalizeDeps()` 会直接拒掉后三类，并给出可以照着改的错误信息——错误是喂回模型的，必须说清怎么修。

### 两条通道

```text
声明 deps
  ↓
命中 shared-deps.json（同名同版本）
  → installSharedDeps()：纯文件复制，不联网、不跑脚本
  ↓ 未命中
联网开关开着？
  ├─ 关 → 不装、不跑用例，落 pending + L3，stage='deps'
  └─ 开 → npm install --ignore-scripts，装完实测校验，仍为 L3
```

**顺序不能反**：跑用例就是执行代码，依赖的安装脚本或模块顶层代码也可能有副作用。所以“代码从哪来”必须先有答案，再谈执行。

### 三道实测

不管走哪条通道，装完都要过：

1. 版本与声明完全一致（信磁盘上的 `package.json`，不信包管理器的“成功”）；
2. 无 `.node` 原生二进制（在 `--permission` 下加载行为不可控，也无法审计）；
3. 传递依赖 ≤ 60 个包、总量 ≤ 20MB。

### 往白名单里加包的流程

```bash
pnpm curate:deps <pkg[@ver]...>   # 体检，给结论，不改文件
pnpm shared:deps                  # 落成 vendor/shared-deps
pnpm verify:whitelist             # 五条标准全过才算数
```

五条标准里**第 5 条必须实测**：`require` 要在系统 Node **和** Electron 内置 Node（20.18.3）下都成功。Node 22 能 `require()` 加载 ESM，20.18 不能——`uuid@14`、`marked@18`、`nanoid@6`、`he@2` 全是在开发机上一切正常、到打包版就 `ERR_REQUIRE_ESM`。只按 registry 元数据审，这种错会一路带到用户手里。

## 3. 验证脚本各自在证什么

仓库里没有引入测试框架，验证靠三类东西：单元测试、CLI 自检、界面探针。

### `pnpm test` —— 核心不变量

[`test/loop.test.ts`](../test/loop.test.ts) 用 `node --test`，22 条用例，覆盖的是“改坏了会静默出错”的地方：

| 主题 | 断言在防什么 |
| --- | --- |
| 循环收束 | 工具调用后消息序列是 `assistant → tool → assistant` |
| 空正文 | 按 `finish_reason` 给出可读原因，而不是一句“（没有输出）” |
| 幻觉工具名 | 变成可修正的 `ToolResult`，而不是崩溃 |
| 定级 | L0/L1/L2/L3 按能力走，不按来源 |
| 静态扫描 | 常见的偷偷摸摸能被抓住 |
| 召回 | 任务词能钓出对的工具；`lastRun` 提权不改变序列化顺序 |
| 历史裁剪 | 只在超预算时裁，且从问答边界起算 |
| 流式 | 增量按顺序拼回完整消息，工具调用也能流式还原 |
| 校验器缓存 | 同名重建后校验器跟着新 schema 走 |
| BOM | 带 BOM 的设置文件能读，解析失败不覆盖用户配置 |
| 沙箱参数 | 只给 `@workspace` 加白名单，别让旧规则把子进程搞崩 |
| 工作区 | 逐轮覆盖全局状态，不同任务不串味 |

所有测试都把 `TOOLFORGE_HOME` 指到临时目录。**别拿真实的 `~/.toolforge` 当试验场。**

### `pnpm selftest` —— 造工具全链路

[`bin/cli.ts`](../bin/cli.ts) 的 `--selftest` 不碰模型，直接调 `runTool()` 走完 13 项：

```text
种子工具到位 → transform 可执行 → 参数校验生效
→ 造 L0 工具并自动放行 → 新工具当场可用
→ 用例必败则不予放行 → 高危代码判 L3
→ 脚本工具在子进程里跑通 → 未声明域名被拦
→ 写盘类判 L2 待人工 → 未放行工具不能跨会话
→ 人工放行后转常驻 → 审计日志落盘
```

它的价值在于**不用模型也能验证整条创建流水线**：改 `review.ts` 的定级规则、`bus.ts` 的闸门顺序、`store.ts` 的状态流转，跑一次就知道有没有把链路弄断。

### `pnpm verify:switch` —— 一轮执行的界面回归

25 项断言，起一个只收不回的假模型服务，自动走完：

```text
发送 → 切走 → 切回 → 暂停 → 历史续聊 → 卡死超时解锁
```

它验的是“用户能感知到的错”：切回来上下文还在不在、正在跑的那一轮能不能重建、输入框还能不能打字、暂停后发送按钮是否解锁、思考是否按原位渲染而不是全堆在开头、超时会不会给说明而不是静默。

实现上走 `TF_SMOKE` 通道：Electron 加载完页面，执行一段探针脚本，把断言结果打成 JSON 到 stdout。不需要额外的测试框架。

### `pnpm verify:toolfilter` —— 设置页筛选

12 项，在真实 DOM 上点等级 tab、敲搜索框，验的是筛选、模糊搜索、两者叠加、空状态文案，以及**刷新后条件不丢**（`trustFilter` / `toolQuery` 是模块状态，`refresh()` 不该把它们弹回去）。

### 依赖与闸门

| 命令 | 验什么 |
| --- | --- |
| `pnpm verify:deps` | 依赖声明校验、安装、落盘记录、沙箱内 `require`、已装跳过 |
| `pnpm verify:gate` | 白名单内自动装、白名单外**既没装也没跑用例**、pack 往返不丢依赖 |
| `pnpm verify:whitelist` | 五条标准逐条验，一条不过就退出非零 |
| `pnpm verify:pack` | 真拉起打包后的 exe，白名单通道与随包 npm 联网通道各跑一遍 |

`verify:pack` 是唯一无法在开发态替代的一项：开发态 `process.execPath` 是 `node.exe`，同级就带 npm；打包态是 `ToolForge.exe`，npm 只能靠随包分发。这两条路径的差别恰好就是“双击图标还能不能用”的全部内容。

## 4. 留一条能失败的检查

非平凡逻辑必须留一条“改坏了会红”的断言。写法不限于形式，但**必须真的能失败**。

变异验证的做法：

```text
1. 写下断言
2. 故意改坏被测逻辑（删掉那个判断、把 >= 改成 >）
3. 跑一次，确认断言变红
4. 改回来，确认变绿
```

不经过第 3 步，你无法知道这条断言到底在测什么——很多“通过”的测试只是因为断言恒真。

### 什么算“能失败的检查”

| 反面例子 | 问题 |
| --- | --- |
| `assert.ok(result)` | 只要返回对象就过，实现错了也过 |
| `assert.ok(typeof x === 'string')` | 同上 |
| 只跑 happy path | 边界与拒绝路径全没验 |

正面写法是断言具体值或具体关系：

```ts
// 召回：既要求找到目标，也要求排除相似但权限完全不同的那件
const picked = selectTools(tools, '统计中文字数');
assert.ok(picked.some((t) => t.name === 'zh_count'));
assert.ok(!picked.some((t) => t.name === 'zh_count_remote'));

// 序列化稳定性：selected 集合不变时，字节序列也不该变
const a = JSON.stringify(selectTools(tools, 'q').map((t) => t.name));
tool.meta.lastRun = { ok: true, ms: 1, error: null, at: '' };
const b = JSON.stringify(selectTools(tools, 'q').map((t) => t.name));
assert.equal(a, b);
```

## 5. 改动前的自检清单

改任何一块之前，先跑一次基线，确认本来就是绿的：

```bash
pnpm typecheck
pnpm test
pnpm selftest
```

改对应模块时再补跑：

| 改动范围 | 必跑 |
| --- | --- |
| 渲染层任务切换 / 流式渲染 | `pnpm verify:switch` |
| 设置页工具筛选 | `pnpm verify:toolfilter` |
| 依赖安装 / 白名单 | `pnpm verify:deps`、`pnpm verify:gate` |
| `shared-deps.json` | `pnpm verify:whitelist` |
| 打包脚本 | `pnpm verify:pack` |
| 任何 UI 改动 | `pnpm build`（`src/ui/build/app.js` 是产物且被 gitignore） |

## 6. 五个常见误解

| 误解 | 事实 |
| --- | --- |
| “白名单构建失败所以工具判 L3，是 bug” | 干净 clone 后没跑 `pnpm shared:deps`，本来就没有白名单，这是设计好的降级 |
| “测试通过 = 工具安全” | 用例只证明它在这几个输入下行为正确，不证明它对敌意输入安全 |
| “`sessionId` 能让未放行工具跑，说明审核可绕过“ | 那是有意的会话内试用通道，跨会话即失效；`isUsable()` 是唯一判定 |
| “MCP 工具标 L1 所以风险低” | 标签只描述接入方式，远端实现不经本地扫描，必须自己看它的实现 |
| “`node:vm` 是沙箱“ | 它在宿主进程内，不是隔离边界；`script` 的子进程也只是多层防护之一 |

## 7. 实践项目

按难度递增，每个都能独立完成：

1. **给召回加一条评估集**：造 20 件名字相近的工具，写一个脚本断言“目标入选、相似但危险的不入选”，再故意把评分改坏，确认断言变红。
2. **加一种 `kind`**：实现 `file`（声明式读一个文件并返回内容，路径走 `permissions.fsRead`），按第 1 节七步全部改一遍，跑 `pnpm selftest` 补一条用例。
3. **补一条依赖通道的测试**：验证“白名单外的依赖在开关关闭时既没安装也没跑用例”，用 `fs.existsSync(node_modules)` 与 `meta.review.tests.length` 两个方向断言。
4. **改一处定级规则**：让 `fsWrite` 指向工具自己的 `.data` 时不再转人工（只做实验，别提交），观察 `selftest` 与 `verify:gate` 各红在哪几条，说明为什么这个改动不该进主干。
5. **给 MCP 加一层本地审核**：设计一个方案，让 MCP 工具首次出现时落 `pending` 而不是直接 `active`，并说明它会不会破坏“SDK 没装也能开机”。

## 8. 回到起点

读完这八篇，你应该能回答最初那个问题：**为什么是 Tool Is All You Need？**

不是因为工具比提示词重要，而是因为“工具”是唯一一个能同时承载**能力、契约、测试、权限、审计、版本、复用**的抽象。提示词决定模型怎么想，循环决定它怎么试，而工具决定这个系统能不能在一次次任务之后变得更强。

如果只想记住一句话：

> 让模型负责决策，让工具把决策变成可验证、可授权、可审计、可复用的行动。

回到 [学习路线](./README.md) 或 [项目主页](../README.md)。
