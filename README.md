# ToolForge

**创建你自己的 Agent —— 一切皆 Tool 的桌面端 Agent。**

内核只有一个 LLM 循环，没有任何「写死的能力清单」。Agent 缺什么，就当场用 `create_tool` 造一件工具：跑一遍自带用例，过静态扫描，按能力定级，然后要么自动放行，要么转你人工点个头。造出来的工具会留在仓库里，下次开机还在。

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-33-47848f?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-All%20rights%20reserved-lightgrey)

![ToolForge](./preview.png)

## 目录

- [它跟「又一个套壳 Chat」的区别](#它跟又一个套壳-chat的区别)
- [快速开始](#快速开始)
- [一件工具是怎么被造出来的](#一件工具是怎么被造出来的)
  - [五种实现方式](#五种实现方式)
  - [信任分级](#信任分级)
- [用起来长什么样](#用起来长什么样)
  - [工作区](#工作区)
  - [设置页与 REPL](#设置页与-repl)
- [界面细节与动效出处](#界面细节与动效出处)
- [安全模型](#安全模型)
- [数据目录](#数据目录)
- [工具包的导出与导入](#工具包的导出与导入)
- [开发](#开发)
- [常见问题](#常见问题)
- [License](#license)

## 它跟「又一个套壳 Chat」的区别

| 常见做法 | ToolForge |
| --- | --- |
| 工具写死在代码里，缺能力就等发版 | Agent 自己造工具，当场可用，通过审核后常驻 |
| 靠提示词约束安全 | 能力声明 + 进程隔离 + 模块拦截 + 审计日志，四层兜底 |
| 工具描述全量塞进上下文 | 两级召回，只注入跟当前任务相关的那十几个 |
| 信任「模型说它没问题」 | 用例不过不入库，高危代码直接拦下转人工 |

## 快速开始

要求 Node 20 以上（推荐 22，脚本工具的 OS 级隔离只在 22+ 才完整），包管理器用 pnpm。

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

环境变量优先级高于配置文件，便于 CI 或临时切换：

| 变量 | 作用 |
| --- | --- |
| `OPENAI_API_KEY` | 模型密钥 |
| `OPENAI_BASE_URL` | 兼容接口地址，如 `https://your-gateway/v1`（可选） |
| `OPENAI_MODEL` | 模型名（可选） |
| `TOOLFORGE_MAX_STEPS` | 单轮步数上限，默认 120，最高封顶 500 |
| `TOOLFORGE_HOME` | 工具仓库位置，默认 `~/.toolforge` |

> 国内网络首次装依赖可能卡在 Electron 二进制上，设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再装。

## 一件工具是怎么被造出来的

一条流水线，每一步都可能把工具打回去：

1. **提规格** —— Agent 给出 `name` / `description` / `kind` / `input` / `permissions` / `examples`，经 `normalizeTool` 归一化校验。校验失败的原话会直接回灌模型，让它自己改。
2. **跑自带用例** —— 每件工具至少一条 `{name, args, expect}`，`expect` 是作用域里有 `result` 的布尔表达式。**用例不过，工具不入库**，没有例外。
3. **静态扫描** —— 只盯「不该出现的痕迹」：`eval`、`new Function`、偷偷 `require('child_process')`、绕过宿主直接用 `http`、整表读 `process.env`、大段 base64 载荷。
4. **按能力定级** —— 见下方信任分级；低危自动放行，高危进待审队列等你点头。
5. **入库** —— 落进 `~/.toolforge/tools/<id>/`，同名重造自动升 patch 版本，旧版本先存一份快照。

### 五种实现方式

优先级从高到低，能被声明式覆盖的绝不写代码 —— 代码的风险高一个数量级。

| kind | 说明 | 例子 |
| --- | --- | --- |
| `http` | 声明式取数，配 URL、header、提取路径 | 查 GitHub 仓库信息 |
| `transform` | 一段纯函数 JS，入参 `input`，返回值即结果 | 统计文本字数 |
| `compose` | 串起已有工具，用 `{{steps[0].result.x}}` 引用前一步 | 取数 → 清洗 → 落盘 |
| `script` | CommonJS 脚本，在子进程沙箱里跑，只能碰 `ctx.net` / `ctx.fs` | 需要循环、分支的复杂逻辑 |
| `shell` | 命令模板，白名单可执行文件，必须显式授权 | 最后退路 |

外部能力也能直接吃进来：在 `~/.toolforge/mcp.json` 里配好 MCP 服务器，它们的工具会出现在工具列表里（需要 `@modelcontextprotocol/sdk`，属可选依赖，没装也不影响开机）。

### 信任分级

按**能力**定级，不按**来源**。

| 等级 | 含义 | 处理 |
| --- | --- | --- |
| `L0` | 无任何权限，纯计算 | 自动放行 |
| `L1` | 只读网络 / 只读文件 / 只读工作目录 / 沙箱内跑代码 | 自动放行 |
| `L2` | 可写文件 / 可写工作目录 / 可读密钥 | 转人工 |
| `L3` | 可执行外部命令 / 静态扫描命中高危 | 转人工 |

本会话临时造的工具（`sessionId` 非空）即使未放行，也只在你创建它的那次会话里可用；人工放行后清空 `sessionId`，转为常驻。

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

### 设置页与 REPL

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

## 界面细节与动效出处

**几处体验细节**：

- 首屏口号 **Forge what's missing.**：逐个字母错峰升起并去糊入场；关键词「Forge」每轮有一道高光连续扫过（跨整个单词，不是逐字母闪）；副标题里「当场造一件」用渐显下划线标出。
- **AI 执行中可以随时切走**：切到别的任务接着说别的事，切回来时那一轮的提问、工具调用轨迹、半截回答都按原样恢复，秒表接着走。输入框全程可用；觉得跑偏了点「暂停」就能停下，这一问一答仍留在历史里。
- **工具轨迹按模型的实际节奏排**：模型「说一句 → 调个工具 → 再看结果说一句」，界面上就按这个顺序交替出现，而不是把工具全堆在气泡上方。
- **连着调用的一串工具自动收成一组**：跑着时展开（得看见谁在跑），全部落定后自动收起，摘要里写着「已调用 N 件工具 · 合计耗时 · 失败几件」，点开看细节，你手动开合过的状态会被记住。
- **思考过程可展开**：推理模型吐出的思考链收在一个默认折叠的「思考过程」块里，跑的时候自动展开，结束后收起。
- 等待回复时是点阵按对角波次亮起 + 走动的秒表，看得出"在干活"而不是卡住了；每一步开始时文案会更新并做一次模糊收束。
- 工具调用显示为带进度填充的徽章，实时显示已耗时，结束后转绿或抖动变红。
- 流式输出文末有打字机光标；出错时气泡带红色左边框，不会和正常回答混在一起。
- 一轮带兜底超时，请求卡死也会自动解锁并说明情况，不会让输入框永远「打不了字」。

**动效的出处**：视觉参考了 [ReactBits](https://reactbits.dev) 的组件，但**没有引入 React**——本仓库界面是纯 HTML/CSS/JS，无打包器且 CSP 禁 CDN，装 React 版会破坏整条构建链。所以是按视觉语义用 CSS 重写的：

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

## 安全模型

**不是形式化沙箱，是三层防线叠加，外加一本账。**

1. **能力声明** —— 每件工具显式列出要什么：哪些域名、读哪些路径、写哪些路径、读哪些环境变量、能不能执行命令。默认全空。通配全部域名（`*`）一律拒绝。

   路径有三种写法：相对工具目录（工具自己的数据）、`@workspace`（用户选中的项目目录）、绝对路径。`@workspace` 需要用户先选好目录才生效，未选时工具会收到明确报错。
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

## 数据目录

一切持久化都在 `~/.toolforge/`（改 `TOOLFORGE_HOME` 可换位置），CLI 和桌面端共用同一份。

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

同名工具重造会自动升一个 patch 版本（`0.1.0` → `0.1.1`），旧版本先落一份 `.history/` 快照再覆盖；单纯开关或放行不算版本更迭。读不出来的 `tool.json` 不会让列表整个崩掉，而是在设置 → 工具里单独列成一行红字。

## 工具包的导出与导入

桌面端设置 → 工具里的「导出全部」「导入工具包」；`~/.toolforge/packs/*.json` 是一个 `toolforge.pack/1` 格式的普通 JSON，可以进 git、发给同事。

导入默认**全部落为待放行** —— 导入不等于放行，你得先看清每件工具索要什么权限。同版本已存在的工具会被跳过，避免一次「导出再导入」把已放行的工具打回待审。命中高危静态扫描的工具直接拒收；导入结束后会把「成功几件、跳过几件、哪几件被拦」一次说清，而不是只报一个总数。

## 开发

```bash
pnpm typecheck     # 类型检查，不产出
pnpm test          # 单元测试（循环、定级、扫描、召回、规格校验、版本更迭）
pnpm selftest      # 端到端自检：造工具全链路 13 个断言
pnpm verify:switch # 渲染层回归：AI 执行中切换任务不丢上下文
pnpm build         # 产出 dist/ 与 src/ui/build/
```

技术栈刻意极简：TypeScript + Node 内建能力 + `ajv` + `openai` + Electron。界面是纯 HTML/CSS/JS，不引任何 UI 框架；Markdown 渲染用 `marked`，输出一律经 `DOMPurify` 白名单清洗。这两个库由构建脚本拷进 `src/ui/build/vendor/`（CSP 禁 CDN、界面无打包器）。

架构、目录地图、加新 `kind` 的步骤、常见坑，都在 [AGENTS.md](./AGENTS.md)。

```
src/
├── index.ts            ToolForge 门面
├── types.ts            全局类型契约
├── core/               规格、仓库、执行闸门、审核、召回、审计、打包
├── executors/          声明式执行器 + 子进程沙箱
├── agent/              LLM 循环、人格提示词、元工具
├── mcp/                MCP 适配器（可选依赖）
└── ui/                 Electron 渲染层（纯 HTML/CSS/JS）
electron/               主进程与 preload 桥
bin/                    REPL 与启动器
scripts/                构建脚本与渲染层回归探针
test/                   单元测试
```

## 常见问题

**装依赖卡在 Electron 二进制？** 设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再装。

**模型报 404 `Not found the model`？** 服务商下线了旧模型名，去设置 → 模型点「获取模型」重新选一个。

**`settings.json` 被改名成 `settings.json.broken-<时间戳>`？** 读不出来时（常见于 Windows 记事本存成带 BOM 的 UTF-8）程序会先把原文备份再重建，**绝不静默覆盖你的配置**，把备份修好覆盖回去即可。

**工具说「没有工作区」？** 这条任务还没绑定目录，在输入框上方选一个文件夹，或换「通用工作区」。

**一轮跑太久被中断？** 单轮步数默认 120、带兜底超时；任务太大就拆小一点，或用 `TOOLFORGE_MAX_STEPS` 调高上限（封顶 500）。

## License

未附带 LICENSE 文件，默认保留所有权利（All rights reserved）：源码公开可读，但未经作者书面许可不得再分发、商用或衍生发布。
