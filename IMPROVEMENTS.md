# 改进清单

> 来源：2026-11-05 全项目代码评审报告（正文存于本机临时目录 `C:\Users\new\AppData\Local\Temp\ToolForge-code-review-2026-11-05.md`，未入仓）。  
> 这里只记「要做什么、动哪个文件、怎么算做完」，不重复论证过程。

**规矩**

- 按 P0 → P3 的顺序推进，一次只做一项。
- 项前的方框只有**代码改完 + 验证跑过**才打勾；半途不算。
- 每项的非平凡逻辑都要留一条能失败的检查，并按 `AGENTS.md` 的要求做变异验证（把被测逻辑改坏，确认断言真的红，再改回来）。多项一起改时允许批量改坏一次验证，但每条新增断言都必须确实变红。
- 验证统一在隔离的 `TOOLFORGE_HOME` 下跑，别碰真实的 `~/.toolforge`。
- 打勾时在该项下补一行「验证：命令 + 结果」。

---

## P0 · 先焊安全边界

- [x] **1. 禁掉脚本子进程的全局网络能力**
  - 文件：`src/executors/runtime-child.cts`、`test/loop.test.ts`
  - 现状：模块拦截只管 `require()`；全局 `fetch` / `WebSocket` / `XMLHttpRequest` 不经过 require，`process.getBuiltinModule('http')` 也能绕过 `Module._load`。实测零 `net` 声明的 script 工具可联网且判 L1 自动放行，Node 的 `--permission` 不约束网络。
  - 做法：加载工具入口前，把这几个全局入口收成 `undefined`；`ctx.net` 用引导层预先缓存的 `httpNative/httpsNative`，不受影响。
  - 验收：新增回归断言——零权限工具里 `typeof fetch` / `typeof WebSocket` / `typeof process.getBuiltinModule` 均为 `'undefined'`，且放行后仍如此；`pnpm typecheck`、`pnpm test`、隔离 `pnpm selftest` 全绿；做一次变异验证。
  - 边界：这一步只堵最廉价的绕过路径；`process.binding` 与直接 `require('fs')` 已由第 2 项的白名单封堵。工具主动把全局写回来等路径，仍属文档已声明的「非形式化边界」。
  - 验证（2026-11-05）：`pnpm typecheck` 通过；`pnpm test` **23 / 23**（新增第 23 条）；隔离 `pnpm selftest` **13 / 13**；复跑评审时的联网实证，零权限脚本返回 `{"reached":false,"why":"fetch is not a function"}`；变异验证把 `stripGlobal` 调用注释掉后第 23 条变红（22 通过 / 1 失败，报错为断言不成立），恢复后复绿。
- [x] **2. 模块拦截从黑名单改成白名单**
  - 文件：`src/executors/runtime-child.cts`、`test/loop.test.ts`
  - 现状：`NET_MODULES` / `HARD_BLOCK` 是枚举式黑名单，`fs`、`fs/promises`、`module`、`vm`、`process` 都不在列；`process.binding` 未被处理。实测 `require('node:fs')` 能绕过 `guardFs`，仅在 `--permission` 生效时被 OS 层挡住，降级即失守。
  - 做法：改为「只放行必要模块」的白名单（例如 `path` 与已审过的纯 JS 依赖），补齐内建入口的封堵，并把 `process.mainModule` 置空；评估并写明对三方依赖的兼容性代价。
  - 验收：补回归用例如「直接读工具目录外的文件被拒」「工具改不回 `Module._load`」；`pnpm verify:deps`、`pnpm test`、隔离 selftest 通过。
  - 验证（2026-11-05）：改为 `ALLOW_BUILTIN_ROOTS` 白名单 + `Module.isBuiltin` 判定，非内建仍交原加载器；`Module._load` 冻结为不可写 / 不可配置，收掉 `process.binding` / `dlopen` / `_linkedBinding` 并置空 `mainModule`。新增第 24 条回归断言；`pnpm verify:deps` **27/27**、`pnpm verify:gate` **21/21** 通过，确认 dayjs 等三方依赖与 pack 往返未受影响；批量变异中该条变红。
  - 边界与代价：三方依赖若在初始化时 require 被禁内建（如 `fs`）会被拒，属刻意取舍；工具主动写回全局仍不保证，见文档「非形式化边界」。
- [x] **3. 收住 `transform` 的 `node:vm` 逃逸**
  - 文件：`src/executors/declarative.ts`、`src/core/review.ts`、`test/loop.test.ts`
  - 现状：宿主 realm 的 `input` / `JSON` / `Object` 直接进 `vm.createContext`，实测 `input.constructor.constructor(...)` 能拿到宿主 `process` 并读文件；用例断言 `vm.runInContext('Boolean(' + expect + ')')` 也没禁代码生成。而 `transform` 默认判 L0 自动放行。
  - 做法：在 vm 内部 `JSON.parse` 重建 `input`，切断宿主原型链；用例断言同样放到禁代码生成的 realm 里求值。（未做「冻结内建原型」与「把 transform 挪进子进程」，那是更彻底的可选后续。）
  - 验收：回归用例断言 transform 读不到宿主 `process` / 文件；README 边界清单同步写明 L0 的真实能力。
  - 验证（2026-11-05）：`runTransform` 只把 `JSON.stringify` 后的数据送进新 realm，在 realm 内 `JSON.parse` 重建 `input`；`runExamples` 的断言同样改在禁代码生成的 realm 内求值。新增第 25 条（构造器链逃逸失败 + 逃逸型断言不得通过），批量变异中该条变红。README 边界清单的同步归入第 20 项。
- [x] **4. 给 `isUsable` 的会话豁免加状态白名单**
  - 文件：`src/core/store.ts`、`src/core/bus.ts`、`src/types.ts`、`test/loop.test.ts`
  - 现状：`status==='active' || (sessionId 匹配)` 的第二条分支不看状态。实测用例失败的 `untested` 工具、依赖被拦的 `pending` 工具在创建会话内仍可正常调用，绕过了「用例门槛」。
  - 做法：会话豁免只允许 `active` / `pending`，排除 `untested` / `rejected` / `disabled`；给 `ExecuteOptions` 加 `allowUntested`，仅供 `create_tool` 的用例 runner 使用，保证用例仍跑得起来。
  - 验收：回归用例断言「用例未过的工具模型侧调不动，但用例阶段能跑」；`pnpm test`、隔离 selftest 通过。
  - 验证（2026-11-05）：`isUsable` 会话豁免只认 `pending`，`untested` / `rejected` / `disabled` 一律不可调；`ExecuteOptions.allowUntested` 仅由 `create_tool` 的用例 runner 传入。新增第 26 条（模型侧调不动、用例阶段确实执行、不注入模型），批量变异中该条变红。
- [x] **5. 人工放行与工具包导入补前置校验**
  - 文件：`src/index.ts`、`src/core/pack.ts`、`test/loop.test.ts`
  - 现状：`approve(id)` 无条件把 status 改 active，不查 `pending` / 用例结果 / 高危扫描；`importPack` 不校验 `schema`、不重算 `grade()`、不跑用例，且信任包内 `trust` 字段，`approve:true` 可一步放行。
  - 做法：approve 校验状态、`review.tests` 全过、无 high findings；导入校验 `toolforge.pack/1`、丢弃包内 `status/trust`、用 `grade()` 重算、移除或二次确认 `approve` 选项。
  - 验收：回归用例覆盖「approve 拒绝 untested」「伪造 trust 的包导入后按能力重算」。
  - 验证（2026-11-05）：`approve` 校验 `pending` / 用例全过 / 无 high findings；`importPack` 校验 `toolforge.pack/1`、丢弃包内 `status` / `trust` / `review`、用 `grade()` 重算，`approve` 选项已移除。新增第 27 条（拒绝 untested、伪造 L0 重算为 L3、正常 pending 可放行）；`pnpm verify:gate` **21/21** 通过；批量变异中该条变红。导入包没有本地用例记录，允许人工放行但审计标 `noTests`。
- [x] **6. HTTP 重定向逐跳校验域名**
  - 文件：`src/executors/declarative.ts`、`test/loop.test.ts`
  - 现状：`fetch` 默认跟随 3xx，`assertNet` 只检查渲染后的初始 URL。
  - 做法：`redirect:'manual'`，对 `Location` 逐跳 `assertNet`，最多 3 跳。
  - 验收：起本地服务返回跨主机 302，断言被拒。
  - 验证（2026-11-05）：`runHttp` 改为 `redirect:'manual'` 逐跳 `assertNet`，最多 3 跳，跨主机摘除 `Authorization` / `Cookie`，按 Fetch 规范改写 303 / 301 / 302 的方法。新增第 28 条（本地服务：同主机 302 可跟随、跨主机 302 被拒），批量变异中该条变红。

## P1 · 纵深与一致性

- [ ] **7. `installToolDeps()` 入口复查联网策略**
  - 文件：`src/core/deps.ts`
  - 现状：策略只在 `createTool` 一个调用点判断（`meta-tools.ts:344`），安装器自身不复查，新调用方即可绕过。
  - 验收：`pnpm verify:gate` 通过，补一条直接调用安装器被拒的用例。
- [ ] **8. 循环与界面补错误兜底**
  - 文件：`src/agent/loop.ts`、`src/ui/app.ts`
  - 现状：`runLoop` 的 `runTool()` 无 try/catch，`store.findByCallName` 的 IO 错误会让整轮 reject；UI 只检查 IPC envelope 的 `ok`，不检查 `ChatResult.ok`，业务失败说明被当成正常回答渲染。
  - 验收：`pnpm verify:switch` 通过。
- [ ] **9. 拆分「探测权限开关」与「执行工具」**
  - 文件：`src/executors/script.ts`
  - 现状：`badFlag` 时会重新 spawn 最多 3 次，有副作用的工具可能被重复执行。
  - 验收：补用例断言一次调用只执行一次。
- [ ] **10. 仓库读取与缓存的健壮性**
  - 文件：`src/core/store.ts`
  - 现状：脚本入口文件缺失时静默置 `''`，工具仍列 active；内存缓存不感知外部进程改动；`recordRun` 每次调用写盘并令全量缓存失效。
  - 验收：损坏工具被计入 `broken`；加基准或日志确认 IO 放大已收敛。
- [ ] **11. 审计脱敏与历史预算可配置**
  - 文件：`src/core/audit.ts`、`src/index.ts`
  - 现状：`summarize()` 只截断不脱敏（`doc/05:267` 已承认）；`HISTORY_CHAR_BUDGET=20000` 按字符估算，中文场景可能超上下文窗口。
  - 验收：含 `apiKey/token/authorization` 的参数摘要被掩码；预算可按服务商配置。

## P2 · 可维护性

- [ ] **12. 收紧核心消息类型**
  - 文件：`src/agent/loop.ts`
  - 现状：`ChatMessage = any`，配合 `as never` / `messages as never` 绕过 SDK 类型。
  - 做法：换用 `ChatCompletionMessageParam` / `ChatCompletionChunk`，去掉 `as never`。
- [ ] **13. `ToolImpl` 改判别联合**
  - 文件：`src/types.ts`、`src/core/spec.ts`
  - 现状：7 种 kind 的字段塞进一个全可选接口，加一种 kind 要手工同步 6 处（`AGENTS.md:79`）。
  - 验收：漏改一处即编译报错。
- [ ] **14. 拆分过长的文件**
  - 文件：`src/index.ts`（671 行）、`src/ui/app.ts`（2336 行）、`src/core/deps.ts`（615 行）
  - 做法：门面按「模型配置 / 工具治理 / 对话编排」分文件；UI 按 view 拆原生 ESM 模块，仍不引入打包器。
- [ ] **15. 清理编辑残留 + 元工具名单单一来源**
  - 文件：`src/agent/meta-tools.ts`（流程编号 1/2/4/3）、`src/core/bus.ts:18`（`ponytail:`）、`src/agent/prompts.ts`、`src/agent/loop.ts`
  - 顺带修：`manage_tool` 不在 `META_TOOL_NAMES` 时 `step.toolCount` 比 `state().toolCount` 多 1（`doc/06:55` 说明召回本身是有意设计，这里只统一统计口径）。
- [ ] **16. 收紧 `SAFE_BINS`**
  - 文件：`src/executors/declarative.ts`
  - 现状：`node` / `python` / `python3` / `curl` 在白名单内，`node -e` 即可任意代码执行；`doc/05:237` 已提示，但审核面板只显示命令名。

## P3 · 工程化与文档

- [ ] **17. 让 `pnpm selftest` 自带隔离的 `TOOLFORGE_HOME`**
  - 文件：`package.json`、`bin/cli.ts` 或新增 `scripts/selftest.mjs`
  - 现状：脚本不设 HOME，直接 `pnpm selftest` 会落进真实 `~/.toolforge`；仓库非空时 10/13（实测），CI 会红。
  - 验收：不设任何环境变量直接跑，13/13 且 `state().home` 指向临时目录。
- [ ] **18. 把安全回归补成套件**
  - 文件：`test/` 新建 `security.test.ts`
  - 内容：零权限不得联网、transform 不得读宿主文件、用例未过不可调用、approve 拒绝 untested、跨主机重定向被拒、降级路径能力面。第 1 项的用例可迁入。
- [ ] **19. 加最小 CI**
  - 文件：`.github/workflows/`
  - 链路：typecheck → build → test → 隔离 selftest → `verify:gate`。
- [ ] **20. 同步文档边界说明**
  - 文件：`README.md`、`doc/05-execution-security.md`、`doc/06-context-cache.md`
  - 内容：补「全局 fetch / vm 逃逸 / 重定向」；修正 `doc/05:224`「工具网络必须走 `ctx.net`」的措辞；写清第 2 项对三方依赖的兼容性影响。
  - 另：`doc/04-create-tool.md:181` 称「approve() 当前并未在每个入口重复检查全部测试条件」，第 5 项完成后已过时，需同步。
- [ ] **21. 确认并清理 2026-11-05 默认自检写入真实数据目录的改动**
  - 位置：`C:\Users\new\.toolforge`（6 件探针工具同名重建、`count_upper` 升 0.1.1 并新增 `.history`、`audit/2026-11-05.jsonl` 追加至 214 行、`save_note` 被 approve 置 active）。
  - **此项目须道友明确许可后才可动手**，未经确认不删除、不回滚、不移动任何文件。

---

## 进度记录

| 日期         | 完成项   | 验证                                                                  |
| ---------- | ----- | ------------------------------------------------------------------- |
| 2026-11-05 | 建立本清单 | 21 项，按 P0 → P3 排序                                                   |
| 2026-11-05 | 第 1 项 | typecheck 通过 / test 23-23 / 隔离 selftest 13-13 / 联网实证已堵 / 变异验证已红且已复绿 |
| 2026-11-05 | 第 2~6 项 | typecheck 通过 / test 28-28 / 隔离 selftest 13-13 / verify:deps 27-27 / verify:gate 21-21 / 批量变异 5 条新断言全红且已复绿 |
