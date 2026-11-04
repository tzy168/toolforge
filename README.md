# ToolForge

**创建你自己的 Agent —— 一切皆 Tool 的桌面端 Agent。**

内核只有一个 LLM 循环，没有任何「写死的能力清单」。Agent 缺什么，就当场用 `create_tool` 造一件工具：跑一遍自带用例，过静态扫描，按能力定级，然后要么自动放行，要么转你人工点个头。造出来的工具会留在仓库里，下次开机还在。

![ToolForge](./preview.png)

## 它跟「又一个套壳 Chat」的区别

| 常见做法 | ToolForge |
| --- | --- |
| 工具写死在代码里，缺能力就等发版 | Agent 自己造工具，当场可用，通过审核后常驻 |
| 靠提示词约束安全 | 能力声明 + 进程隔离 + 模块拦截 + 审计日志，四层兜底 |
| 工具描述全量塞进上下文 | 两级召回，只注入跟当前任务相关的那十几个 |
| 信任「模型说它没问题」 | 用例不过不入库，高危代码直接拦下转人工 |

## 快速开始

```bash
pnpm install
pnpm build
pnpm start        # 桌面端
# 或
pnpm cli          # 终端 REPL
```

首次运行会在 `~/.toolforge/` 建仓库，并装入两件种子工具：`text_stats`（纯本地统计）和 `github_repo_info`（查仓库星数）。

模型配置：打开左下角齿轮 → 设置 → 模型。

- **内置服务商**：DeepSeek、Kimi，只需填 API Key；**模型名不给默认值**，点「获取模型」从服务商 `/models` 接口拉一份列表来选（也可以直接手填）。
- **自定义服务商**：任何 OpenAI 兼容接口，填名称、Base URL、模型名、API Key，模型名同样支持「获取模型」。
- 没填 API Key **或没选模型**的服务商不可选；清空 Key 会自动取消选中，避免带病运行。
- API Key 只存在主进程，写入 `~/.toolforge/settings.json`，界面永不回显。

> 之前给 Kimi 硬编码的 `moonshot-v1-8k` 已下线，会报 `404 Not found the model`。现在模型名由你或服务商列表决定，不会再猜。

也支持环境变量（优先级高于配置文件），便于 CI 或临时切换：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://your-gateway/v1   # 可选
OPENAI_MODEL=gpt-4o-mini                  # 可选
```

> 国内网络首次装依赖可能卡在 Electron 二进制上，设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再装。

## 用起来长什么样

桌面端有两个模式，对应两套人格：

- **Work** —— 干活。有现成工具就用，没有就临时造一件（只在本会话有效）。
- **Create Tools** —— 锻造。专心想「这能力该用什么方式实现」，产出的是可长期复用的工具。

左栏是任务列表，**按工作区分组**。每段对话是一个任务，各自记着自己的模式与工作区，切回来不用重选。顶栏右侧常驻显示当前模型与可用工具数。

### 工作区

工作区选择器在**输入框上方**，因为「这条任务在哪干活」属于输入的一部分。三种选择：

| 选项 | 含义 |
| --- | --- |
| 选择一个文件夹 | 绑定某个项目目录，Agent 能读写其中的文件 |
| **通用工作区** | 不绑定任何文件夹，适合纯计算、查资料这类活 |
| 不选（清空） | 这条任务暂时不碰文件 |

几点行为：

- **每个任务各存各的工作区**，互不干扰。新建任务默认是「未选择」，真正的空白起点。
- 点「＋ 新任务」会同时清空工作区、对话、输入框和滚动位置。
- 侧栏按工作区分组，点组标题可以折叠；具体项目排在前面，通用与未选的排在后面。
- Agent 知道当前项目在哪，提示词里会带上这个路径。
- 工具可以申请 `@workspace` 权限来读写这个目录——**只读自动放行（L1），要写必须你手动放行（L2）**，因为那是你的源码。
- 没选目录时工具会收到明确报错，不会猜一个路径。

工作区不是沙箱目录。脚本工具仍然只能访问自己的目录，`@workspace` 是一条需要显式声明、且写入要人工审核的额外通道，而不是给 Agent 开了整个磁盘。

空状态给了四个快捷入口（两个干活、两个造工具），点一下就把第一句话写进输入框，省得对着空框发呆。

设置页（左下角齿轮，`Esc` 返回）分两栏：

- **工具** —— 待放行队列、工具仓库、运行环境。仓库里每件工具都能开关或删除；跑挂过的会直接标红，不用等下次调用才发现。
- **模型** —— 多服务商配置。

REPL 里对应 `/work`、`/create`：

```
/work     切换干活模式
/create   切换造工具模式
/tools    列出仓库里所有工具
/approve <id>   放行一件待审工具
/exit     退出
```

**几处体验细节**：
- 首屏口号 **Forge what's missing.**：逐个字母错峰升起并去糊入场；关键词「Forge」每轮有一道高光连续扫过（跨整个单词，不是逐字母闪）；副标题里「当场造一件」用渐显下划线标出。
- **AI 执行中可以随时切走**：切到别的任务接着说别的事，切回来时那一轮的提问、工具调用轨迹、半截回答都按原样恢复，秒表接着走。输入框全程可用；觉得跑偏了点「暂停」就能停下，这一问一答仍留在历史里。
- **工具轨迹按模型的实际节奏排**：模型「说一句 → 调个工具 → 再看结果说一句」，界面上就按这个顺序交替出现，而不是把工具全堆在气泡上方。
- **思考过程可展开**：推理模型吐出的思考链收在一个默认折叠的「思考过程」块里，跑的时候自动展开，结束后收起。
- 等待回复时是点阵按对角波次亮起 + 走动的秒表，看得出"在干活"而不是卡住了；每一步开始时文案会更新并做一次模糊收束。
- 工具调用显示为带进度填充的徽章，实时显示已耗时，结束后转绿或抖动变红。
- 流式输出文末有打字机光标；出错时气泡带红色左边框，不会和正常回答混在一起。

## 界面动效的出处

几处等待与反馈动效的视觉参考了 [ReactBits](https://reactbits.dev) 的组件，但**没有引入 React**——本仓库界面是纯 HTML/CSS/JS，无打包器且 CSP 禁 CDN，装 React 版会破坏整条构建链。所以是按视觉语义用 CSS 重写的：

| 动效 | 参考组件 | 落地位置 |
| --- | --- | --- |
| 点阵波浪 + 秒表 | [Lattice Loader](https://reactbits.dev/micro/lattice-loader) | `.thinking`（AI 等待态） |
| 填充扫过 + 计时，结束转绿/红 | [Call Chip](https://reactbits.dev/micro/call-chip) | `.call-chip`（工具调用轨迹） |
| 逐字符错峰入场 | [Split Text](https://reactbits.dev/text-animations/split-text) | `.hero-ch`（首屏口号） |
| 高光扫过 | [Shiny Text](https://reactbits.dev/text-animations/shiny-text) | `.hero-key::after`（口号关键词） |
| 模糊收束 | [Blur Text](https://reactbits.dev/text-animations/blur-text) | `.thinking-label.blur-in`、`.hero-ch`（等待文案切换、文字入场） |
| 打字机光标 | [Text Type](https://reactbits.dev/text-animations/text-type) | `.msg-bot.md.streaming::after`（流式输出） |
| 网格纹理背景 | [Grid Pattern](https://reactbits.dev) | `.empty::before`（空状态） |

所有动效都在 `prefers-reduced-motion: reduce` 下自动关闭，只保留静态状态色。

## 工具的五种实现方式

优先级从高到低，能被声明式覆盖的绝不写代码 —— 代码的风险高一个数量级。

| kind | 说明 | 例子 |
| --- | --- | --- |
| `http` | 声明式取数，配 URL、header、提取路径 | 查 GitHub 仓库信息 |
| `transform` | 一段纯函数 JS，入参 `input`，返回值即结果 | 统计文本字数 |
| `compose` | 串起已有工具，用 `{{steps[0].result.x}}` 引用前一步 | 取数 → 清洗 → 落盘 |
| `script` | CommonJS 脚本，在子进程沙箱里跑，只能碰 `ctx.net` / `ctx.fs` | 需要循环、分支的复杂逻辑 |
| `shell` | 命令模板，白名单可执行文件，必须显式授权 | 最后退路 |

外部能力也能直接吃进来：在 `~/.toolforge/mcp.json` 里配好 MCP 服务器，它们的工具会出现在工具列表里（需要 `@modelcontextprotocol/sdk`，属可选依赖，没装也不影响开机）。

## 安全模型

**不是形式化沙箱，是三层防线叠加，外加一本账。**

1. **能力声明** —— 每件工具显式列出要什么：哪些域名、读哪些路径、写哪些路径、读哪些环境变量、能不能执行命令。默认全空。通配全部域名（`*`）一律拒绝。

   路径有三种写法：相对工具目录（工具自己的数据）、`@workspace`（用户选中的项目目录）、绝对路径。`@workspace` 需要用户在顶栏选好目录才生效，未选时工具会收到明确报错。
2. **进程隔离** —— 脚本工具另起子进程，用 Node 的 `--permission`（Node 22+）限定文件读写范围与子进程能力；运行时不支持该开关时降级并如实记录。当前到底有没有隔离，设置 → 工具 → 运行环境里会写明，**没跑过脚本工具时不会声称「已启用」**。
3. **模块拦截** —— 沙箱引导层锁定 `Module._load`，掐断 `http` / `https` / `net` / `child_process`，工具只能用注入的受控通道：

```js
module.exports = async (input, ctx) => {
  const res = await ctx.net.json('https://api.github.com/repos/nodejs/node');
  ctx.fs.write('cache/last.json', { stars: res.stargazers_count });
  return { stars: res.stargazers_count };
};
```

4. **审计** —— 每次工具调用落一行 JSONL 到 `~/.toolforge/audit/`，既是排障凭据，也是定级依据。

### 信任分级

按**能力**定级，不按**来源**。

| 等级 | 含义 | 处理 |
| --- | --- | --- |
| `L0` | 无任何权限，纯计算 | 自动放行 |
| `L1` | 只读网络 / 只读文件 / 只读工作目录 / 沙箱内跑代码 | 自动放行 |
| `L2` | 可写文件 / 可写工作目录 / 可读密钥 | 转人工 |
| `L3` | 可执行外部命令 / 静态扫描命中高危 | 转人工 |

静态扫描盯的是「不该出现的痕迹」：`eval`、`new Function`、偷偷 `require('child_process')`、绕过宿主直接用 `http`、整表读 `process.env`、大段 base64 载荷。

**用例不过，工具不入库** —— 这是硬门槛，没有例外。每件工具至少带一条 `{name, args, expect}`，`expect` 是作用域里有 `result` 的布尔表达式。

## 工具仓库长什么样

一切持久化都在 `~/.toolforge/`，CLI 和桌面端共用同一份。

```
~/.toolforge/
├── tools/
│   └── <id>/
│       ├── tool.json        规格（不含代码）
│       ├── <name>.cjs       script 类工具的代码
│       ├── .data/           该工具唯一可写的目录
│       └── .history/        历次版本快照，便于回滚
├── packs/                   导出的工具包
├── audit/                   按天切的 JSONL 审计日志
├── staging/                 暂存区
├── mcp.json                 MCP 服务器配置
└── settings.json            模型与密钥
```

想换位置？设 `TOOLFORGE_HOME` 即可。

同名工具重造会自动升一个 patch 版本（`0.1.0` → `0.1.1`），旧版本先落一份 `.history/` 快照再覆盖；单纯开关或放行不算版本更迭。读不出来的 `tool.json` 不会让列表整个崩掉，而是在设置 → 工具里单独列成一行红字。

## 工具包的导出与导入

桌面端设置 → 工具里的「导出全部」「导入工具包」；`~/.toolforge/packs/*.json` 是一个 `toolforge.pack/1` 格式的普通 JSON，可以进 git、发给同事。

导入默认**全部落为待放行** —— 导入不等于放行，你得先看清每件工具索要什么权限。同版本已存在的工具会被跳过，避免一次「导出再导入」把已放行的工具打回待审。命中高危静态扫描的工具直接拒收；导入结束后会把「成功几件、跳过几件、哪几件被拦」一次说清，而不是只报一个总数。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm test        # 单元测试（循环、定级、扫描、召回、规格校验、版本更迭）
pnpm selftest    # 端到端自检：造工具全链路 13 个断言
pnpm verify:switch  # 渲染层回归：AI 执行中切换任务不丢上下文
pnpm build       # 产出 dist/ 与 src/ui/build/
```

技术栈刻意极简：TypeScript + Node 内建能力 + `ajv` + `openai` + Electron。界面是纯 HTML/CSS/JS，不引任何 UI 框架。

架构、目录地图、加新 `kind` 的步骤、常见坑，都在 [AGENTS.md](./AGENTS.md)。

## 目录结构

```
src/
├── index.ts            ToolForge 门面
├── types.ts            全局类型契约
├── core/               规格、仓库、执行闸门、审核、召回、审计、打包
├── executors/          声明式执行器 + 子进程沙箱
├── agent/              LLM 循环、人格提示词、元工具
├── mcp/                MCP 适配器（可选依赖）
└── ui/                 Electron 渲染层
electron/               主进程与 preload 桥
bin/                    REPL 与启动器
test/                   单元测试
```

## License

私有项目，未授权分发。
