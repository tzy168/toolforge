// 渲染进程。只跟 window.tf 这个桥打交道，碰不到 Node。
// marked 与 dompurify 是 ESM 产物，靠 scripts/copy-ui-vendor.mjs 拷到 build/vendor 再相对路径引入：
// 界面没有打包器，CSP 又不许连 CDN。
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

interface ToolSummary {
  id: string;
  name: string;
  description: string;
  kindLabel: string;
  trust: string;
  status: string;
  permissions: string;
  version: string;
  updatedAt: string | null;
  lastRun: { ok: boolean; ms: number; error: string | null; at: string } | null;
  review: {
    level: string;
    reasons?: string[];
    findings?: Array<{ level: string; msg: string; line: number }>;
    tests?: Array<{ name: string; ok: boolean; note: string; ms: number }>;
    at: string;
  } | null;
  source: string;
}

interface ProviderView {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
  custom: boolean;
}

interface ForgeState {
  home: string;
  model: string;
  models: { list: ProviderView[]; active: string | null };
  workspace: string | null;
  /** 此刻真正能用的工具数（元工具 + 已放行 + 本会话临时可用 + MCP），界面别自己数 */
  toolCount: number;
  tools: ToolSummary[];
  pending: ToolSummary[];
  broken: Array<{ id: string; error: string }>;
  mcp: { available: boolean; status: Record<string, string>; count: number };
  sandbox: { probed: boolean; flag: string | null };
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

interface EventPayload {
  type: string;
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  ms?: number;
  preview?: string;
  content?: string;
  delta?: string;
  /** 推理增量（type=reasoning）：模型的思考内容 */
  reasoning?: string;
  step?: number;
  toolCount?: number;
}

interface Bridge {
  state: () => Promise<Envelope<ForgeState>>;
  chat: (payload: {
    input: string;
    phase: string;
    history: Array<{ role: string; content: string }>;
    workspace?: string | null;
  }) => Promise<Envelope<{ reply: string; aborted?: boolean }>>;
  /** 暂停当前这一轮 */
  stop: () => Promise<Envelope<unknown>>;
  approve: (id: string) => Promise<Envelope<unknown>>;
  reject: (id: string) => Promise<Envelope<unknown>>;
  remove: (id: string) => Promise<Envelope<unknown>>;
  setEnabled: (id: string, enabled: boolean) => Promise<Envelope<unknown>>;
  saveProvider: (p: Partial<ProviderView> & { apiKey?: string }) => Promise<Envelope<unknown>>;
  removeProvider: (id: string) => Promise<Envelope<unknown>>;
  setActiveProvider: (id: string | null) => Promise<Envelope<unknown>>;
  listProviderModels: (p: { id: string; baseURL?: string; apiKey?: string }) => Promise<Envelope<string[]>>;
  openHome: () => Promise<Envelope<unknown>>;
  /** 只弹目录选择器，不改全局状态——每个任务各选各的 */
  pickFolder: () => Promise<Envelope<{ canceled: boolean; path?: string }>>;
  openWorkspace: (dir: string) => Promise<Envelope<unknown>>;
  exportPack: (payload: { name: string; ids: string[] }) => Promise<Envelope<{ canceled: boolean; path?: string; count?: number }>>;
  importPack: () => Promise<Envelope<{ canceled: boolean; results?: Array<{ ok: boolean; skipped?: string; error?: string }> }>>;
  onEvent: (cb: (event: EventPayload) => void) => void;
}

declare global {
  interface Window {
    tf?: Bridge;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const chat = $<HTMLDivElement>('#chat');
const inner = el('div', 'chat-inner');
chat.appendChild(inner);

let phase: 'work' | 'create' = 'work';
let busy = false;

/**
 * 正在执行的那一轮。
 *
 * 以前这里存的是 DOM 节点，切任务时 `renderHistory` 会把对话区整个清空，
 * 节点就成了孤儿：事件继续往里写，用户却永远看不到，切回来上下文也空了。
 * 所以改成存数据，切回该任务时按它重建界面。
 * 同一时刻只允许一轮（后端事件不带任务 id，并发会串台），靠 `busy` 保证。
 */
interface LiveTrace {
  name: string;
  args: string;
  /** undefined 表示还在跑 */
  ok?: boolean;
  ms?: number;
  t0: number;
}

/**
 * 这一轮里的一个片段，按模型实际产出的顺序排。
 *
 * 以前把所有工具堆在一个 `.trace` 里放在气泡上方，读起来像「先把所有活干完再说」，
 * 但模型其实是「说一句 → 调个工具 → 再看结果说一句」。所以改成有序片段：
 * 文本段与工具段交错，界面照原样重放。
 */
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; trace: LiveTrace };

interface LiveRun {
  taskId: string;
  /** 这一轮用户说的话。history 要等结束才 push，所以重建时得单独记一份 */
  pendingInput: string;
  /** 等待态文案，随 step 更新 */
  thinking: string;
  /** 模型的思考链（reasoning 增量累积），可折叠展示 */
  reasoning: string;
  /**
   * 这一步的思考是否已经收尾。
   *
   * 模型一旦开始吐正文或调工具，思考就已经结束了；标签得当场从「思考中…」翻成
   * 「思考完成」，不能挂着「思考中…」等整轮跑完。下一步重新吐思考时再翻回去。
   */
  reasoningDone: boolean;
  /** 按产出顺序排列的片段 */
  segments: Segment[];
  /**
   * 用户手动开合过的工具组：组序号 → 是否展开。
   *
   * 工具组默认「跑着展开、全跑完自动收起」。这个默认值每次都从数据算出来，
   * 但用户点开过某一组时得记住他的意思，否则下一次重画又给合回去。
   */
  traceOpen: Map<number, boolean>;
  started: number;
}

let liveRun: LiveRun | null = null;
// 流式片段按帧合并：每片都重新解析 Markdown 是 O(n²)，一屏的量级也够卡
let renderQueued = false;
/**
 * 「还没发出第一条消息」时的草稿工作区。
 * 没有活动任务时由它显示在 chip 上；发出第一条消息时固化进任务。
 * 新点「新任务」会重置为 null —— 那才是真正的空白。
 */
let draftWorkspace: TaskWorkspace = null;

/* ---------------- 任务（每段对话一条记录） ---------------- */

/**
 * 一个任务的工作区。
 * - 字符串：具体文件夹的绝对路径
 * - `'general'`：通用工作区，用来做不需要碰某个项目的活儿
 * - `null`：还没选（新任务默认就是它）
 */
type TaskWorkspace = string | 'general' | null;

interface Task {
  id: string;
  title: string;
  phase: 'work' | 'create';
  history: Array<{ role: string; content: string }>;
  at: number;
  /** 老数据没有这个字段，读出来是 undefined，按"未选"处理 */
  workspace?: TaskWorkspace;
  /** 最后一条回答的思考过程，重开任务时仍可展开 */
  reasoning?: string;
  /** 最后一条回答里调过的工具，按顺序 */
  steps?: Array<{ name: string; args: string; ok?: boolean; ms?: number }>;
}

const TASK_KEY = 'toolforge.tasks';
/** 侧栏分组折叠状态按工作区记住，键是工作区标识 */
const GROUP_KEY = 'toolforge.groups';

function taskWorkspace(t: Task): TaskWorkspace {
  return t.workspace ?? null;
}

// 任务只是本地对话记录，存在渲染层即可，不进主进程仓库
function loadTasks(): { tasks: Task[]; active: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(TASK_KEY) || '{}');
    if (Array.isArray(raw.tasks)) return { tasks: raw.tasks, active: raw.active ?? null };
  } catch {
    /* 坏数据直接当空 */
  }
  return { tasks: [], active: null };
}

function saveTasks(): void {
  try {
    localStorage.setItem(TASK_KEY, JSON.stringify({ tasks, active: activeId }));
  } catch {
    /* 存不下就算了，不影响对话 */
  }
}

let { tasks, active: activeId } = loadTasks();
let taskSeq = tasks.length;

function currentTask(): Task | null {
  return tasks.find((t) => t.id === activeId) ?? null;
}

function ensureTask(firstMessage: string): Task {
  const found = currentTask();
  if (found) {
    if (!found.history.length) found.title = firstMessage.slice(0, 28) || '新任务';
    return found;
  }
  const task: Task = {
    id: `t_${Date.now().toString(36)}_${taskSeq++}`,
    title: firstMessage.slice(0, 28) || '新任务',
    phase,
    history: [],
    at: Date.now(),
    // 新任务继承输入框上方当前选中的工作区
    workspace: draftWorkspace,
  };
  tasks.unshift(task);
  activeId = task.id;
  return task;
}

/** 工作区标识 → 给用户看的名字。'general' 与 null 都不指向具体文件夹 */
function workspaceLabel(ws: TaskWorkspace): string {
  if (ws === 'general') return '通用工作区';
  if (!ws) return '未选择工作区';
  const parts = ws.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || ws;
}

/** 侧栏分组键：同一个文件夹的任务归到一起 */
function groupKey(ws: TaskWorkspace): string {
  return ws ?? '__none__';
}

function loadGroups(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUP_KEY) || '{}');
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveGroups(): void {
  try {
    localStorage.setItem(GROUP_KEY, JSON.stringify(groups));
  } catch {
    /* 存不下不影响使用 */
  }
}

let groups = loadGroups();

function renderTasks(): void {
  const list = $<HTMLDivElement>('#taskList');
  list.innerHTML = '';
  if (!tasks.length) {
    const tip = el('div', 'side-empty');
    tip.textContent = '还没有任务。发一句话就开一个。';
    list.appendChild(tip);
    return;
  }

  // 按工作区分组。文件夹之间按最近活动排序，未选/通用的排在后面——
  // 具体项目通常更常用，先看到它们。
  const order: string[] = [];
  const byGroup = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = groupKey(taskWorkspace(t));
    if (!byGroup.has(k)) {
      byGroup.set(k, []);
      order.push(k);
    }
    byGroup.get(k)!.push(t);
  }
  order.sort((a, b) => {
    const weight = (k: string) => (k === '__none__' ? 2 : k === 'general' ? 1 : 0);
    return weight(a) - weight(b);
  });

  for (const key of order) {
    const rows = byGroup.get(key)!;
    const ws = rows[0] ? taskWorkspace(rows[0]) : null;
    const collapsed = groups[key] === true;

    const head = el('div', `group-head${collapsed ? ' collapsed' : ''}`);
    head.title = ws && ws !== 'general' ? ws : workspaceLabel(ws);
    const caret = el('span', 'group-caret');
    caret.textContent = '▾';
    const gname = el('span', 'group-name');
    gname.textContent = workspaceLabel(ws);
    const gcount = el('span', 'group-count');
    gcount.textContent = String(rows.length);
    head.append(caret, gname, gcount);
    head.onclick = () => {
      groups[key] = !collapsed;
      saveGroups();
      renderTasks();
    };
    list.appendChild(head);

    if (collapsed) continue;
    for (const task of rows) list.appendChild(taskRow(task));
  }
}

function taskRow(task: Task): HTMLElement {
  const row = el('div', `task${task.id === activeId ? ' active' : ''}`);
  row.title = task.title;
  const title = el('span', 'task-title');
  title.textContent = task.title;
  const del = el('button', 'task-del');
  del.textContent = '✕';
  del.title = '删除任务';
  del.onclick = (e) => {
    e.stopPropagation();
    tasks = tasks.filter((t) => t.id !== task.id);
    if (activeId === task.id) {
      activeId = null;
      openTask(null);
    }
    saveTasks();
    renderTasks();
  };
  row.append(title, del);
  row.onclick = () => openTask(task.id);
  return row;
}

/* ---------------- 视图切换 ---------------- */

/** 切换工作模式。页签点击与空状态快捷入口共用，避免两处各写一遍占位文案 */
function setPhase(next: 'work' | 'create'): void {
  phase = next;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', (t as HTMLElement).dataset.phase === phase);
  });
  // 占位文案由 setBusy 统一管（它同时要知道忙不忙），别再各写一份
  syncComposer();
  const task = currentTask();
  if (task) task.phase = phase;
  saveTasks();
}

function showView(name: 'chat' | 'settings'): void {
  $<HTMLElement>('#viewChat').hidden = name !== 'chat';
  $<HTMLElement>('#viewSettings').hidden = name !== 'settings';
  $<HTMLButtonElement>('#settingsBtn').classList.toggle('active', name === 'settings');
  $<HTMLButtonElement>('#settingsBtn').setAttribute('aria-expanded', String(name === 'settings'));
  if (name === 'settings') refresh();
}

/** 设置内页切换。后续加「大模型配置」只要多一个 data-pane 按钮和一个同名 pane */
function showPane(pane: string): void {
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.pane === pane));
  document.querySelectorAll<HTMLElement>('.pane').forEach((p) => {
    p.hidden = p.dataset.pane !== pane;
  });
}

document.querySelectorAll<HTMLElement>('.nav-item').forEach((nav) => {
  nav.addEventListener('click', () => showPane(nav.dataset.pane || 'tools'));
});

/* ---------------- 对话渲染 ---------------- */

/**
 * 只有本来就贴着底部时才自动滚。
 * 流式输出时用户往上翻着读，硬拽回底部等于不让人看。
 */
function scrollBottom(force = false): void {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  if (force || nearBottom) chat.scrollTop = chat.scrollHeight;
}

// 空状态里的快捷入口：直接替用户把第一句话写好，省得对着空框发呆
const QUICK_STARTS = [
  { phase: 'work' as const, label: '数一下这段文字的字数', text: '统计一下这段话的字数、词数和行数：' },
  { phase: 'work' as const, label: '查个 GitHub 仓库', text: '查一下 nodejs/node 这个仓库的星数' },
  { phase: 'create' as const, label: '造一个网页标题抓取工具', text: '造一个工具，输入网址返回该网页的标题' },
  { phase: 'create' as const, label: '造一个 JSON 字段整理工具', text: '造一个工具，把杂乱的 JSON 数组按指定字段整理成表格' },
];

function emptyState(): HTMLElement {
  const box = el('div', 'empty');
  box.id = 'empty';

  // 口号拆成逐字符的 span，靠 CSS 变量错开延迟，做出「一格一格成形」的入场。
  // 效果移植自 ReactBits 的 Split Text / Shiny Text / Blur Text，纯 CSS 实现。
  const hero = el('h1', 'hero');
  hero.setAttribute('aria-label', 'Forge what is missing');
  // 读屏器读整句，视觉上是一堆 span 挨个亮起来，所以把碎片标成装饰
  const frag = el('span', 'hero-frag');
  frag.setAttribute('aria-hidden', 'true');
  let seq = 0;
  for (const word of ['Forge', 'what’s', 'missing.']) {
    const w = el('span', 'hero-word');
    // 关键词：整词一起承载光泽。逐字母各挂一条渐变会碎成噪点
    if (seq === 0) {
      w.classList.add('hero-key');
      // 伪元素要高光层复刻文字，得把原文放进去
      w.dataset.text = word;
    }
    for (const ch of word) {
      const c = el('span', 'hero-ch');
      c.textContent = ch;
      c.style.setProperty('--i', String(seq++));
      w.appendChild(c);
    }
    frag.appendChild(w);
    // 词间补一个真实空格，保证复制出来的文本可读
    frag.appendChild(document.createTextNode(' '));
  }
  hero.appendChild(frag);

  const sub = el('p', 'hero-sub');
  sub.append('凡能力皆为工具——没有现成的，就');
  const mark = el('span', 'hero-mark');
  mark.textContent = '当场造一件';
  sub.append(mark, '。');

  box.append(hero, sub);
  const grid = el('div', 'quick');
  for (const q of QUICK_STARTS) {
    const btn = el('button', 'quick-item');
    const tag = el('span', `quick-tag ${q.phase}`);
    tag.textContent = q.phase === 'create' ? '造工具' : '干活';
    btn.append(tag, q.label);
    btn.onclick = () => {
      setPhase(q.phase);
      const input = $<HTMLTextAreaElement>('#input');
      input.value = q.text;
      growInput(input);
      input.focus();
      // 光标落在句尾，用户接着补参数就行
      input.setSelectionRange(q.text.length, q.text.length);
    };
    grid.appendChild(btn);
  }
  box.appendChild(grid);
  return box;
}

/**
 * Markdown → 安全 HTML。AI 输出来自模型，可能夹带任意 HTML，
 * 所以一律先 marked 渲染再用 DOMPurify 白名单洗一遍。
 */
function markdownToHtml(text: string): string {
  const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

/** 用户气泡：纯文本，靠 CSS 的 pre-wrap 保留换行，不渲染 MD（避免用户输入被当成标记） */
function userTurn(text: string): HTMLElement {
  const turn = el('div', 'turn turn-user');
  const bubble = el('div', 'msg-user');
  bubble.textContent = text;
  turn.appendChild(bubble);
  return turn;
}

/**
 * 按任务重建对话区。
 *
 * 工具调用轨迹不落盘（`ponytail:` 要留存得在 Task 里一起存 traces），
 * 但**正在执行的那一轮必须能重建**——否则切走再切回来，用户会看到自己的问题没了、
 * 界面卡在空白，而后台还在跑。所以 liveRun 里的用户消息、轨迹、半截正文都要画出来。
 */
function renderHistory(task: Task | null): void {
  inner.innerHTML = '';
  const history = task?.history ?? [];
  const live = task && liveRun && liveRun.taskId === task.id ? liveRun : null;

  if (!history.length && !live) {
    inner.appendChild(emptyState());
    return;
  }

  for (let i = 0; i < history.length; i += 2) {
    const user = history[i];
    const bot = history[i + 1];
    if (user) inner.appendChild(userTurn(user.content));
    if (!bot) continue;

    const turn = el('div', 'turn turn-bot');
    // 思考过程只属于最后一轮：每次对话都会覆盖 task.reasoning / task.steps
    const isLast = i + 1 === history.length - 1 && !live;
    if (isLast && task?.reasoning) turn.appendChild(reasoningBlock(task.reasoning, 'past'));
    if (isLast) {
      const traces: LiveTrace[] = (task?.steps || []).map((s) => ({ name: s.name, args: s.args, ok: s.ok, ms: s.ms, t0: 0 }));
      // 回放出来的工具调用一律收起：历史记录里再摆一排徽章最占地方
      if (traces.length) turn.appendChild(traceGroup(traces, 0, null));
    }
    const body = el('div', 'msg-bot md');
    body.innerHTML = bot.content ? markdownToHtml(bot.content) : '（没有输出）';
    turn.appendChild(body);
    inner.appendChild(turn);
  }

  if (live) {
    // 这一轮的提问还没落进 history（要等结束才 push），所以在这里补画
    inner.appendChild(userTurn(live.pendingInput ?? ''));
    inner.appendChild(buildLiveTurn(live));
    // 切回来时秒表要接着走（ticker 是全局的，通常还在转；这里兜一手）
    startTicker();
  }
  scrollBottom();
}

/** 单个工具徽章：填充扫过 + 计时，结束转绿或抖动变红。移植自 ReactBits Call Chip */
function traceChip(t: LiveTrace): HTMLElement {
  const chip = el('div', `call-chip${t.ok === undefined ? ' running' : t.ok ? ' done' : ' fail'}`);
  chip.dataset.t0 = String(t.t0);
  const nm = el('span', 't-name');
  nm.textContent = t.name;
  const args = el('span', 't-args');
  args.textContent = t.args;
  const state = el('span', 't-state');
  state.textContent = t.ok === undefined ? fmtElapsed(Date.now() - t.t0) : t.ok ? `✓ ${t.ms || 0}ms` : '✗ 失败';
  chip.append(nm, args, state);
  return chip;
}

/**
 * 工具调用分组：连着跑的一串工具收进一个可折叠块。
 *
 * 一轮里模型常连着调七八件工具，徽章一个占一行，正片全被顶到屏幕外。所以：
 * 跑着的时候展开（得看见谁在跑），全部落定就自动收起，只留一行摘要——
 * 件数、总耗时、失败数都写在摘要里，收起也不丢信息，想看细节点开就行。
 *
 * `gid` 是组在一轮里的序号，用来查用户手动开合过的意思（见 LiveRun.traceOpen）。
 * `live` 为 null 表示这组是历史回放，没有开合记忆，一律收起。
 */
function traceGroup(traces: LiveTrace[], gid: number, live: LiveRun | null): HTMLElement {
  // 只调了一件工具：本来就只有一行，再套摘要反而占地儿，直接给徽章
  if (traces.length === 1) return traceChip(traces[0]);

  const running = traces.some((t) => t.ok === undefined);
  const settled = traces.filter((t) => t.ok !== undefined).length;
  const failed = traces.filter((t) => t.ok === false).length;
  const total = traces.reduce((n, t) => n + (t.ms || 0), 0);

  const box = el('details', `trace-group${running ? '' : failed ? ' fail' : ' done'}`);
  // 自动默认值：还在跑就展开，跑完就收起
  const auto = running;
  box.open = live?.traceOpen.get(gid) ?? auto;
  box.dataset.g = String(gid);
  box.dataset.auto = auto ? '1' : '0';

  const sum = el('summary');
  sum.textContent = running
    ? traces.length > 1
      ? `工具调用中…（${settled}/${traces.length} 完成）`
      : '工具调用中…'
    : `已调用 ${traces.length} 件工具${total ? ` · 合计 ${fmtElapsed(total)}` : ''}${failed ? ` · ${failed} 件失败` : ''}`;
  box.appendChild(sum);

  const body = el('div', 'trace-group-body');
  for (const t of traces) body.appendChild(traceChip(t));
  box.appendChild(body);
  return box;
}

/**
 * 重画前把用户手动开合过的工具组记下来。
 * 和自动默认值一致说明他没动过，就别存成意图——否则该自动收起的那组永远收不起来。
 */
function rememberTraceOpen(old: HTMLElement): void {
  if (!liveRun) return;
  old.querySelectorAll<HTMLDetailsElement>('details.trace-group').forEach((d) => {
    const gid = Number(d.dataset.g);
    if (!Number.isFinite(gid)) return;
    if (d.open === (d.dataset.auto === '1')) liveRun!.traceOpen.delete(gid);
    else liveRun!.traceOpen.set(gid, d.open);
  });
}

/**
 * 思考块的三种状态。
 *
 * thinking = 模型正在想；done = 这一步想完了（整轮可能还在跑工具）；
 * past = 整轮已经结束，从 history 回放出来的。
 */
type ReasoningState = 'thinking' | 'done' | 'past';

const REASONING_LABEL: Record<ReasoningState, string> = {
  thinking: '思考中…',
  done: '思考完成',
  past: '思考过程',
};

/**
 * 思考块：模型吐出的 reasoning 内容，默认折叠。
 *
 * 推理模型的思考链动辄几千字，全展开会把正片挤走；但用户又想看它怎么想的，
 * 所以做成默认收起、点开可读。<details> 省掉一堆开合状态管理。
 *
 * 标签随状态走：想的时候是「思考中…」，一想完立刻翻成「思考完成」。
 * 别等整轮结束才变——否则用户以为它还在想，其实早就在调工具了。
 */
function reasoningBlock(text: string, state: ReasoningState): HTMLElement {
  const box = el('details', `reasoning${state === 'done' ? ' done' : ''}`);
  // 还在跑的时候先展开，让用户看到「它在想」；跑完收起，别占地方
  box.open = state !== 'past';
  const sum = el('summary');
  sum.textContent = REASONING_LABEL[state];
  const body = el('div', 'reasoning-body');
  body.textContent = text;
  box.append(sum, body);
  return box;
}

/**
 * 按 liveRun 的数据把「正在跑的这一轮」搭出来。
 * 片段按模型产出顺序穿插：文字段与工具段交错，和真实对话流一致。
 */
function buildLiveTurn(live: LiveRun): HTMLElement {
  const turn = el('div', 'turn turn-bot live-turn');

  // 想完了就写「思考完成」，别等整轮结束（结束态由 'past' 负责）
  if (live.reasoning) {
    turn.appendChild(reasoningBlock(live.reasoning, live.reasoningDone ? 'done' : 'thinking'));
  }

  // 连着调的几件工具合成一组（组序号用来记住用户手动开合过的意思）
  let gid = 0;
  for (let i = 0; i < live.segments.length; i++) {
    if (live.segments[i].kind === 'text') {
      const seg = live.segments[i] as { kind: 'text'; text: string };
      const bubble = el('div', 'msg-bot md');
      if (seg.text) bubble.innerHTML = markdownToHtml(seg.text);
      turn.appendChild(bubble);
      continue;
    }
    const traces: LiveTrace[] = [];
    while (i < live.segments.length && live.segments[i].kind === 'tool') {
      traces.push((live.segments[i] as { kind: 'tool'; trace: LiveTrace }).trace);
      i++;
    }
    i--; // 上面的 while 多走了一步，退回外层循环的下一格
    turn.appendChild(traceGroup(traces, gid++, live));
  }

  // 最后一段还是工具（或压根没有文字），就补一个等待态，否则会出现「只有徽章没有文字」的空档
  const last = live.segments[live.segments.length - 1];
  if (!last || last.kind === 'tool') {
    const bubble = el('div', 'msg-bot md typing');
    bubble.appendChild(thinkingBlock(live.thinking));
    turn.appendChild(bubble);
  } else {
    // 最后一段是文字：挂上打字光标，表示还可能继续来
    const bubbles = turn.querySelectorAll<HTMLElement>('.msg-bot');
    bubbles[bubbles.length - 1]?.classList.add('streaming');
  }
  return turn;
}

function openTask(id: string | null): void {
  activeId = id;
  const task = currentTask();
  // 每个任务记着自己的模式与工作区，切回来不用重选
  setPhase(task?.phase ?? 'work');
  if (task) draftWorkspace = taskWorkspace(task);
  renderWorkspace(task ? taskWorkspace(task) : draftWorkspace);
  renderTasks();
  renderHistory(task);
  showView('chat');
  saveTasks();
}

/* ---------------- 渲染仓库 ---------------- */

async function refresh(): Promise<void> {
  if (!window.tf) return;
  const res = await window.tf.state();
  if (!res.ok) return;
  const s = res.data;
  const live = s.tools.filter((t) => t.status !== 'rejected');

  $<HTMLSpanElement>('#toolCount').textContent = String(live.filter((t) => t.status !== 'pending').length);
  $<HTMLSpanElement>('#pendingCount').textContent = String(s.pending.length);
  $<HTMLSpanElement>('#statusLine').textContent = s.model;
  // 没配模型时整台机器都跑不动，提示要够显眼，别只是一行灰字
  const headModel = $<HTMLSpanElement>('#headModel');
  headModel.textContent = s.model;
  headModel.classList.toggle('unset', s.model === '未配置模型');
  $<HTMLSpanElement>('#headTools').textContent = `${s.toolCount} 件工具`;
  const home = $<HTMLSpanElement>('#homePath');
  home.textContent = s.home;
  home.title = s.home;

  renderModels(s.models);
  renderRuntime(s);

  const pendingList = $<HTMLDivElement>('#pendingList');
  pendingList.innerHTML = '';
  for (const t of s.pending) pendingList.appendChild(pendingCard(t));
  if (!s.pending.length) {
    const tip = el('p', 'hint');
    tip.textContent = '没有待放行的工具。';
    pendingList.appendChild(tip);
  }

  // 读不出来的工具目录单独列出来，别让用户以为工具凭空消失了
  const brokenList = $<HTMLDivElement>('#brokenList');
  brokenList.innerHTML = '';
  for (const b of s.broken) {
    const row = el('div', 'broken');
    row.textContent = `${b.id} 读不出来：${b.error}`;
    brokenList.appendChild(row);
  }

  const shown = s.tools.filter((x) => x.status !== 'pending' && x.status !== 'rejected');
  const list = $<HTMLDivElement>('#toolList');
  list.innerHTML = '';
  for (const t of shown) list.appendChild(toolRow(t));
  $<HTMLElement>('#toolEmpty').hidden = shown.length > 0;
}

/** 运行环境一行：沙箱到底有没有 OS 级隔离，不能靠默认值猜 */
function renderRuntime(s: ForgeState): void {
  const box = $<HTMLParagraphElement>('#sandboxLine');
  const { probed, flag } = s.sandbox;
  if (!probed) {
    box.textContent = '脚本沙箱：本次启动还没跑过脚本类工具，OS 级隔离尚未探测。';
  } else if (flag) {
    box.textContent = `脚本沙箱：Node ${flag} 生效，子进程只能读写声明范围内的路径。`;
  } else {
    box.textContent = '脚本沙箱：运行时不支持权限开关，已降级为无 OS 级隔离，仅靠模块拦截与能力白名单。';
  }
  box.classList.toggle('warn', probed && !flag);

  const mcpLine = $<HTMLParagraphElement>('#mcpLine');
  const status = Object.entries(s.mcp.status || {});
  if (!s.mcp.available) {
    mcpLine.textContent = 'MCP：未安装 @modelcontextprotocol/sdk，外部工具源停用。';
  } else if (!status.length) {
    mcpLine.textContent = 'MCP：已就绪，mcp.json 里还没有配置服务器。';
  } else {
    mcpLine.textContent = 'MCP：' + status.map(([name, text]) => `${name} ${text}`).join('；');
  }
}

/**
 * 渲染输入框上方的工作区 chip。
 *
 * 显示的是「当前任务的工作区」；没有活动任务时显示草稿值（下一条任务会用这个）。
 * 具体文件夹只显示最后一段，完整路径放 title。
 */
function renderWorkspace(ws: TaskWorkspace): void {
  const chip = $<HTMLButtonElement>('#wsPick');
  const name = $<HTMLSpanElement>('#wsName');
  chip.classList.toggle('unset', ws === null);
  chip.classList.toggle('general', ws === 'general');
  name.textContent = workspaceLabel(ws);
  chip.title =
    ws && ws !== 'general' ? `${ws}\n点击选择文件夹` : ws === 'general' ? '通用工作区：不绑定文件夹' : '本任务还没选工作区';
}

function toolRow(t: ToolSummary): HTMLElement {
  const row = el('div', 'tool');
  row.title = `${t.description}\n权限：${t.permissions}\n版本：${t.version}`;

  const dot = el('div', `dot ${t.status}`);
  const body = el('div', 'tool-body');
  const name = el('div', 'tool-name');
  name.textContent = t.name;
  const sub = el('div', 'tool-sub');
  const chip = el('span', `chip ${t.trust}`);
  chip.textContent = t.trust;
  // 不用 innerHTML：kindLabel 虽然来自常量，但工具名与版本可能来自损坏的 tool.json
  sub.append(chip, `${t.kindLabel} · v${t.version}`);
  const desc = el('div', 'tool-desc');
  desc.textContent = t.description;

  body.append(name, sub, desc);
  // 跑挂了和从没跑过要能一眼分开，否则用户只能靠记忆
  if (t.lastRun && !t.lastRun.ok) {
    const fail = el('div', 'tool-fail');
    fail.textContent = `上次执行失败：${t.lastRun.error || '未知错误'}`;
    fail.title = t.lastRun.at;
    body.appendChild(fail);
  } else if (t.lastRun) {
    const okLine = el('div', 'tool-ok');
    okLine.textContent = `上次执行成功 · ${t.lastRun.ms}ms`;
    okLine.title = t.lastRun.at;
    body.appendChild(okLine);
  }

  const actions = el('div', 'tool-actions');
  actions.append(enableSwitch(t), removeBtn(t));
  // 用例没过 / 未审核的工具，开关先禁用，避免绕过审核直接启用
  row.append(dot, body, actions);
  return row;
}

/** 删除：目录连同历史快照一起删，所以必须问一次 */
function removeBtn(t: ToolSummary): HTMLElement {
  const btn = el('button', 'tool-del');
  btn.textContent = '删除';
  btn.title = '从仓库里彻底删除这件工具';
  btn.onclick = async () => {
    if (!confirm(`删除工具「${t.name}」？目录与历史快照会一并移除，无法撤销。`)) return;
    const res = await window.tf?.remove(t.id);
    if (res && !res.ok) alert(res.error);
    refresh();
  };
  return btn;
}

/** 开关：把工具在「可用 / 停用」之间切换，只改状态不动规格 */
function enableSwitch(t: ToolSummary): HTMLElement {
  const on = t.status === 'active';
  const wrap = el('label', 'switch');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = on;
  box.disabled = t.status === 'untested' || t.status === 'pending';
  box.title = box.disabled ? '用例未通过或尚未放行，暂不能开关' : on ? '已启用，点击停用' : '已停用，点击启用';
  const track = el('span', 'switch-track');
  box.onchange = async () => {
    box.disabled = true;
    const res = await window.tf?.setEnabled(t.id, box.checked);
    if (res && !res.ok) {
      alert(res.error);
      box.checked = !box.checked;
    }
    box.disabled = false;
    refresh();
  };
  wrap.append(box, track);
  return wrap;
}

function pendingCard(t: ToolSummary): HTMLElement {
  const card = el('div', 'pending-card');
  const head = el('div', 'pending-head');
  const name = el('div', 'tool-name');
  name.textContent = t.name;
  const chip = el('span', `chip ${t.trust}`);
  chip.textContent = t.trust;
  head.append(name, chip);

  // 定级理由里「可写文件：notes」这类只是把权限重说一遍，界面上重复一遍纯属噪音；
  // 真正需要单独提示的是静态扫描命中的高危项
  const hits = (t.review?.reasons || []).filter((r) => r.includes('静态扫描'));
  const perm = el('div', 'pending-perm');
  perm.textContent = t.permissions;
  card.append(head, perm);
  for (const hit of hits) {
    const warn = el('div', 'pending-warn');
    warn.textContent = hit;
    card.appendChild(warn);
  }

  // 用例明细和扫描结果原来只在数据里，界面上看不见，放行等于闭眼签字
  const tests = t.review?.tests || [];
  if (tests.length) {
    const detail = el('details', 'pending-detail');
    const sum = el('summary');
    const passed = tests.filter((r) => r.ok).length;
    sum.textContent = `自带用例 ${passed}/${tests.length} 通过${t.review?.findings?.length ? ` · 扫描命中 ${t.review.findings.length} 条` : ''}`;
    detail.appendChild(sum);
    for (const r of tests) {
      const line = el('div', `pending-test ${r.ok ? 'ok' : 'fail'}`);
      line.textContent = `${r.ok ? '✓' : '✗'} ${r.name}${r.note ? ' — ' + r.note : ''}`;
      detail.appendChild(line);
    }
    for (const f of t.review?.findings || []) {
      const line = el('div', `pending-test ${f.level === 'high' ? 'fail' : ''}`);
      line.textContent = `第 ${f.line} 行 ${f.level}：${f.msg}`;
      detail.appendChild(line);
    }
    card.appendChild(detail);
  }

  const actions = el('div', 'pending-actions');
  actions.append(
    actionBtn('放行', 'btn-approve', () => window.tf?.approve(t.id)),
    actionBtn('拒绝', 'btn-reject', () => window.tf?.reject(t.id))
  );
  card.appendChild(actions);
  return card;
}

/** 放行/拒绝共用：失败就弹错，成功后统一刷新 */
function actionBtn(text: string, cls: string, run: () => Promise<Envelope<unknown>> | undefined): HTMLElement {
  const btn = el('button', cls);
  btn.textContent = text;
  btn.onclick = async () => {
    const res = await run();
    if (res && !res.ok) alert(res.error);
    refresh();
  };
  return btn;
}

/* ---------------- 多模型 ---------------- */

// 拉取过的模型列表按服务商缓存，刷新界面后下拉选项还在
const modelCache = new Map<string, string[]>();

/** 用缓存的候选填一个 datalist，两个入口（每行的、新增表单的）都走这里 */
function fillDatalist(list: HTMLDataListElement, ids: string[]): void {
  list.innerHTML = '';
  for (const id of ids) {
    const opt = el('option');
    opt.value = id;
    list.appendChild(opt);
  }
}

/** 「获取模型」共用：拉不到就弹错，拉到就写缓存 + 填 datalist */
async function fetchModels(
  btn: HTMLButtonElement,
  payload: { id: string; baseURL?: string; apiKey?: string },
  list: HTMLDataListElement,
  onDone?: (ids: string[]) => void
): Promise<void> {
  btn.disabled = true;
  const res = await window.tf?.listProviderModels(payload);
  btn.disabled = false;
  if (!res || !res.ok) {
    alert((res && !res.ok && res.error) || '拉取失败');
    return;
  }
  const ids = res.data;
  modelCache.set(payload.id, ids);
  fillDatalist(list, ids);
  onDone?.(ids);
}

function renderModels(models: ForgeState['models']): void {
  const list = $<HTMLDivElement>('#modelList');
  list.innerHTML = '';
  for (const p of models.list) list.appendChild(modelRow(p, models.active));

  // 自定义表单里的模型名也复用同一个候选来源，
  // 拉取时用的是表单里刚填的 Base URL 与 Key
  fillDatalist($<HTMLDataListElement>('#mpModelList'), modelCache.get('__form__') || []);
}

function modelRow(p: ProviderView, active: string | null): HTMLElement {
  const ready = p.hasKey && Boolean(p.model);
  const row = el('div', `model${p.id === active ? ' active' : ''}${ready ? '' : ' unset'}`);

  const head = el('div', 'model-head');
  const radio = el('input', 'model-radio');
  radio.type = 'radio';
  radio.name = 'model';
  radio.checked = p.id === active;
  // 缺 Key 或缺模型都不可选，鼠标点不动、键盘也选不了
  radio.disabled = !ready;
  radio.title = !p.hasKey ? '还没填 API Key' : !p.model ? '还没选模型' : '点击切换到这家';
  radio.onchange = async () => {
    const res = await window.tf?.setActiveProvider(p.id);
    if (res && !res.ok) alert(res.error);
    refresh();
  };

  const body = el('div', 'model-body');
  const name = el('div', 'model-name');
  name.textContent = p.label;
  const sub = el('div', 'model-sub');
  sub.textContent = !p.hasKey ? '未填 API Key，不可选' : `${p.model || '未选模型'} · ${p.baseURL}`;
  body.append(name, sub);
  head.append(radio, body);

  // 内置服务商删不掉，只给自定义的显示删除
  if (p.custom) {
    const del = el('button', 'ghost danger');
    del.textContent = '删除';
    del.onclick = async () => {
      if (!confirm(`删除服务商「${p.label}」？`)) return;
      const res = await window.tf?.removeProvider(p.id);
      if (res && !res.ok) alert(res.error);
      refresh();
    };
    head.append(del);
  }

  const fields = el('div', 'model-fields');
  const listId = `model-opts-${p.id}`;
  const modelInput = el('input', 'model-input');
  modelInput.value = p.model;
  modelInput.placeholder = '模型名，可点「获取模型」选择';
  modelInput.setAttribute('list', listId);
  modelInput.autocomplete = 'off';

  const datalist = document.createElement('datalist');
  datalist.id = listId;
  fillDatalist(datalist, modelCache.get(p.id) || []);

  const key = el('input', 'model-key');
  key.type = 'password';
  key.placeholder = p.hasKey ? '已配置，填新的可覆盖' : '填入 API Key';
  key.autocomplete = 'off';

  const fetchBtn = el('button', 'ghost');
  fetchBtn.textContent = '获取模型';
  fetchBtn.title = '按当前 Base URL 与 API Key 向服务商拉一份可用模型列表';
  fetchBtn.onclick = () =>
    fetchModels(fetchBtn, { id: p.id, baseURL: p.baseURL, apiKey: key.value.trim() || undefined }, datalist, (ids) => {
      if (!modelInput.value && ids.length === 1) modelInput.value = ids[0];
      modelInput.focus();
    });

  const save = el('button', 'ghost solid');
  save.textContent = '保存';
  save.onclick = async () => {
    const apiKey = key.value.trim();
    if (!apiKey && !p.hasKey) {
      alert('请填入 API Key');
      return;
    }
    const model = modelInput.value.trim();
    if (!model) {
      alert('请选定模型名，可点「获取模型」从服务商拉取');
      return;
    }
    const res = await window.tf?.saveProvider({ id: p.id, apiKey: apiKey || undefined, model });
    if (res && !res.ok) {
      alert(res.error);
      return;
    }
    key.value = '';
    refresh();
  };

  fields.append(modelInput, key, fetchBtn, save, datalist);
  row.append(head, fields);
  return row;
}

$<HTMLButtonElement>('#mpFetch').addEventListener('click', async () => {
  const baseURL = $<HTMLInputElement>('#mpBaseURL').value.trim();
  const apiKey = $<HTMLInputElement>('#mpKey').value.trim();
  if (!baseURL || !apiKey) {
    alert('先填 Base URL 与 API Key，才能拉模型列表');
    return;
  }
  await fetchModels(
    $<HTMLButtonElement>('#mpFetch'),
    { id: '__form__', baseURL, apiKey },
    $<HTMLDataListElement>('#mpModelList'),
    () => $<HTMLInputElement>('#mpModel').focus()
  );
});

$<HTMLButtonElement>('#mpAdd').addEventListener('click', async () => {
  const label = $<HTMLInputElement>('#mpLabel').value.trim();
  const baseURL = $<HTMLInputElement>('#mpBaseURL').value.trim();
  const model = $<HTMLInputElement>('#mpModel').value.trim();
  const apiKey = $<HTMLInputElement>('#mpKey').value.trim();
  // id 由名称派生，重名时加时间后缀区分
  const base = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'custom';
  const id = /^[a-z][a-z0-9_-]{1,39}$/.test(base) ? base : `c_${Date.now().toString(36)}`;
  if (!label) {
    alert('请填名称');
    return;
  }
  if (!model) {
    alert('请填模型名，或点「获取模型」拉一份列表');
    return;
  }

  const res = await window.tf?.saveProvider({ id, label, baseURL, model, apiKey, custom: true });
  if (res && !res.ok) {
    alert(res.error);
    return;
  }
  for (const sel of ['#mpLabel', '#mpBaseURL', '#mpModel', '#mpKey']) {
    $<HTMLInputElement>(sel).value = '';
  }
  refresh();
});

/* ---------------- 发送 ---------------- */

/**
 * 同步输入区的状态：按钮可用性 + 占位文案。
 *
 * 输入框**永远不禁用**——切到别的任务时用户应该能接着说别的事，
 * 禁用还会让人以为程序卡死了。真正挡住重复提交的是 `busy` 这个标志。
 */
function setBusy(v: boolean): void {
  busy = v;
  syncComposer();
}

function syncComposer(): void {
  const btn = $<HTMLButtonElement>('#sendBtn');
  const stop = $<HTMLButtonElement>('#stopBtn');
  btn.disabled = busy;
  btn.title = busy ? '上一轮还在跑，等它结束' : '';
  // 忙的时候露出「暂停」，用户随时能把跑偏的一轮掐掉
  stop.hidden = !busy;
  stop.disabled = false;
  $<HTMLTextAreaElement>('#input').placeholder = busy
    ? '上一轮还在跑…可以先切到别的任务'
    : phase === 'create'
      ? '描述你要造的工具，例如：抓取某个页面的标题'
      : '说说你要做什么…（Shift + Enter 换行）';
}

$<HTMLButtonElement>('#stopBtn').addEventListener('click', () => void stopRun());

function shorten(s: string, n: number): string {
  return s && s.length > n ? s.slice(0, n) + '…' : s || '';
}

function fmtElapsed(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 一个统一的心跳给所有等待态刷时长。
 * 不给每个元素各开一个定时器：轮次结束忘清一个就是内存泄漏。
 */
let ticker: number | null = null;

function startTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(() => {
    const now = Date.now();
    // 秒表跟着 liveRun 的起点走，切任务重建后读数依然连续
    const clock = inner.querySelector<HTMLElement>('.thinking-clock');
    if (clock && liveRun) clock.textContent = fmtElapsed(now - liveRun.started);
    for (const chip of document.querySelectorAll<HTMLElement>('.call-chip.running')) {
      const state = chip.querySelector<HTMLElement>('.t-state');
      if (state) state.textContent = fmtElapsed(now - Number(chip.dataset.t0 || now));
    }
  }, 100);
}

function stopTicker(): void {
  if (ticker === null) return;
  clearInterval(ticker);
  ticker = null;
}

/** 等待态：点阵 + 文案 + 秒表。视觉效果移植自 ReactBits 的 Lattice Loader */
function thinkingBlock(text: string): HTMLElement {
  const box = el('div', 'thinking');
  const grid = el('div', 'lattice');
  grid.setAttribute('aria-hidden', 'true');
  // 3×5 个格子，按 r+c 定相位，亮带沿对角线扫过去
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = el('i');
      cell.style.setProperty('--d', String(r + c));
      grid.appendChild(cell);
    }
  }
  const label = el('span', 'thinking-label');
  label.textContent = text;
  const clock = el('span', 'thinking-clock');
  clock.textContent = '0ms';
  box.append(grid, label, clock);
  return box;
}

/** 换一句等待文案。重放一次模糊收束，让「第 2 步」这种变化看得出来 */
function setThinkingLabel(text: string): void {
  const label = inner.querySelector<HTMLElement>('.thinking-label');
  if (!label) return;
  label.textContent = text;
  label.classList.remove('blur-in');
  void label.offsetWidth; // 强制回流，动画才会重播
  label.classList.add('blur-in');
}

/** 出错态：给气泡加个红色左边框，别让错误混在正常回答里 */
function showError(bubble: HTMLElement, message: string): void {
  bubble.classList.remove('typing', 'streaming');
  bubble.classList.add('bubble-error');
  bubble.textContent = message;
}

/**
 * 一轮允许跑多久。
 *
 * 后端有自己的超时（单次请求 20s、脚本工具 30s），但整轮可能串很多步，
 * 累起来仍可能卡死在某个角落（网络半开、SDK 解析异常）。一旦卡住，
 * `busy` 会永远为 true，之后所有输入都被静默吞掉——用户看到的就是「输入框打不了字」。
 * 所以这里留一道兜底：到点强制收尾，把控制权还给人。
 *
 * 步数上限提到 60 步后，一轮能跑的时间也变长了，兜底时间跟着放到 20 分钟：
 * 否则正常的 40 多步任务会在半路被误杀。
 *
 * `?turnTimeout=3000` 可覆盖——自动化测试靠它在几秒内验证兜底真的成立。
 * 走 URL 而不是脚本注入，是因为模块在页面脚本执行时就求值了，那时注入已经晚了。
 */
const turnTimeoutMs = (() => {
  const raw = Number(new URLSearchParams(location.search).get('turnTimeout'));
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60 * 1000;
})();
let watchdog: number | null = null;

function armWatchdog(taskId: string): void {
  clearWatchdog();
  watchdog = window.setTimeout(() => {
    watchdog = null;
    if (!liveRun || liveRun.taskId !== taskId) return;
    // 让后端也停手，别在后台继续烧 token
    void window.tf?.stop();
    forceFinish(
      taskId,
      `这一轮跑了太久（${Math.round(turnTimeoutMs / 1000)} 秒），已自动停止。可以接着发消息，或拆小一点再试。`
    );
  }, turnTimeoutMs);
}

function clearWatchdog(): void {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

/**
 * 强制收尾：不管请求那边还在不在，先把界面解锁。
 * 和 send() 的正常收尾共用同一套清理，避免两边各写一份、日后改漏。
 */
function forceFinish(taskId: string, message: string): void {
  const task = tasks.find((t) => t.id === taskId);
  if (task && liveRun) {
    const answer = liveRun.segments
      .filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
      .map((s) => s.text)
      .join('')
      .trim();
    task.history.push(
      { role: 'user', content: liveRun.pendingInput },
      { role: 'assistant', content: answer || `（${message}）` }
    );
    task.history = task.history.slice(-8);
    if (liveRun.reasoning) task.reasoning = liveRun.reasoning;
  }
  clearWatchdog();
  stopTicker();
  liveRun = null;
  setBusy(false);
  saveTasks();
  if (activeId === taskId) renderHistory(currentTask());
  scrollBottom();
}

async function send(text: string): Promise<void> {
  if (!text.trim()) return;
  if (busy) {
    // 静默 return 会让人以为输入框坏了。说清楚是「上一轮还在跑」，
    // 并指出可以暂停——否则用户只能干等，看着像程序卡死。
    const other = liveRun && liveRun.taskId !== activeId;
    alert(
      other
        ? '另一条任务还在执行中。可以先暂停它（输入框右侧的「暂停」），或等它跑完。'
        : '这一轮还在执行中。可以点「暂停」停下，或等它跑完。'
    );
    return;
  }
  if (!window.tf) {
    alert('请在 Electron 中运行：pnpm start');
    return;
  }
  const task = ensureTask(text);
  task.at = Date.now();
  // 任务列表按最近活动排序
  tasks = [task, ...tasks.filter((t) => t.id !== task.id)];
  renderTasks();

  const empty = inner.querySelector('#empty');
  if (empty) empty.remove();

  inner.appendChild(userTurn(text));

  // 记成数据而不是抓着 DOM：用户随时可能切走，切回来要能照原样重建
  liveRun = {
    taskId: task.id,
    pendingInput: text,
    thinking: '思考中…',
    reasoning: '',
    reasoningDone: false,
    segments: [],
    traceOpen: new Map(),
    started: Date.now(),
  };
  inner.appendChild(buildLiveTurn(liveRun));
  setBusy(true);
  startTicker();
  armWatchdog(task.id);
  scrollBottom();

  let streamed = '';
  let failed = '';
  let aborted = false;
  try {
    const res = await window.tf.chat({
      input: text,
      phase,
      history: task.history,
      // 'general' 与 null 对后端都意味着「不绑定目录」，具体路径才传下去
      workspace: typeof task.workspace === 'string' ? task.workspace : null,
    });
    if (res.ok) {
      // 最终文本以返回值收尾，覆盖流式过程中可能被丢弃的尾部碎片
      streamed = res.data.reply || '';
      aborted = Boolean(res.data.aborted);
    } else {
      failed = res.error;
    }
  } catch (err) {
    failed = (err as Error).message;
  }

  // 无论成败都把这一问一答落进 history：否则切走再回来，用户的问题凭空消失
  const answer = streamed || (aborted ? '（已暂停）' : '');
  task.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
  task.history = task.history.slice(-8);
  // 思考过程与工具轨迹一起留在任务上，重开也能看
  if (liveRun?.reasoning) task.reasoning = liveRun.reasoning;
  task.steps = [...(liveRun?.segments || [])]
    .filter((s): s is { kind: 'tool'; trace: LiveTrace } => s.kind === 'tool')
    .map((s) => ({ name: s.trace.name, args: s.trace.args, ok: s.trace.ok, ms: s.trace.ms }));

  clearWatchdog();
  stopTicker();
  liveRun = null;
  setBusy(false);
  saveTasks();

  // 用户若已切走，就别把人拽回来；等他切回来时 renderHistory 会画出完整记录
  if (activeId === task.id) {
    renderHistory(task);
    if (failed) {
      const last = inner.querySelector<HTMLElement>('.turn-bot:last-child .msg-bot');
      if (last) showError(last, '出错了：' + failed);
    } else {
      scrollBottom();
    }
  }
  refresh();
}

/** 暂停当前这轮。后端会中止请求，chat() 带着 aborted=true 返回，走正常收尾 */
async function stopRun(): Promise<void> {
  if (!busy) return;
  await window.tf?.stop();
  // 按钮立刻变灰，别让用户连点；真正解锁在 send() 的收尾里
  $<HTMLButtonElement>('#stopBtn').disabled = true;
}

/* ---------------- 事件绑定 ---------------- */

$<HTMLFormElement>('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLTextAreaElement>('#input');
  const text = input.value;
  input.value = '';
  growInput(input);
  send(text);
});

$<HTMLTextAreaElement>('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>('#composer').requestSubmit();
  }
});

/**
 * 按内容撑高输入框。超过 160px 才允许滚动——
 * 否则单行时 scrollHeight 比 clientHeight 多出的那零点几像素会让 Chromium 画出滚动条。
 */
const INPUT_MAX = 160;

function growInput(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  const full = input.scrollHeight;
  input.style.height = Math.min(full, INPUT_MAX) + 'px';
  input.style.overflowY = full > INPUT_MAX ? 'auto' : 'hidden';
}

$<HTMLTextAreaElement>('#input').addEventListener('input', (e) => growInput(e.target as HTMLTextAreaElement));

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => setPhase((tab.dataset.phase as 'work' | 'create') || 'work'));
});

$<HTMLButtonElement>('#newTaskBtn').addEventListener('click', () => {
  activeId = null;
  // 新任务必须是彻底空白的：工作区、选中态、对话、输入框残留、滚动位置全清
  draftWorkspace = null;
  const input = $<HTMLTextAreaElement>('#input');
  input.value = '';
  growInput(input);
  renderWorkspace(null);
  renderTasks();
  renderHistory(null);
  showView('chat');
  chat.scrollTop = 0;
  input.focus();
  saveTasks();
});

$<HTMLButtonElement>('#importBtn').addEventListener('click', async () => {
  const res = await window.tf?.importPack();
  if (res && res.ok && !res.data.canceled) {
    const results = res.data.results || [];
    const added = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.ok);
    const lines = [`导入 ${added} 件工具，已进入待放行队列`];
    if (skipped) lines.push(`跳过 ${skipped} 件（同版本已存在）`);
    // 失败原因要摊开：静态扫描拦下的工具，用户得知道为什么进不来
    for (const f of failed) lines.push(`✗ ${f.error || '未知错误'}`);
    alert(lines.join('\n'));
  }
  refresh();
});

$<HTMLButtonElement>('#exportBtn').addEventListener('click', async () => {
  if (!window.tf) return;
  const res = await window.tf.state();
  if (!res.ok) return;
  const ids = res.data.tools.filter((t) => t.status === 'active').map((t) => t.id);
  if (!ids.length) {
    alert('没有已放行的工具可导出');
    return;
  }
  const out = await window.tf.exportPack({ name: `pack-${Date.now()}`, ids });
  if (out.ok && !out.data.canceled) alert(`已导出 ${out.data.count} 件工具\n${out.data.path}`);
});

$<HTMLSpanElement>('#homePath').addEventListener('click', () => window.tf?.openHome());

/* 工作目录：左键选目录，已选中时右键清除 */
/* ---------------- 工作区选择器 ---------------- */

const wsMenu = $<HTMLDivElement>('#wsMenu');
const wsMenuBtn = $<HTMLButtonElement>('#wsMenuBtn');

function setMenuOpen(open: boolean): void {
  wsMenu.hidden = !open;
  wsMenuBtn.setAttribute('aria-expanded', String(open));
}

wsMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenuOpen(wsMenu.hidden);
});

// 菜单内部的点击不要冒泡到 document，否则"点别处关闭"的逻辑会抢先把它关掉
wsMenu.addEventListener('click', (e) => e.stopPropagation());

// 点别处就收起，别让菜单挡着对话
document.addEventListener('click', (e) => {
  if (wsMenu.hidden) return;
  if (wsMenu.contains(e.target as Node) || wsMenuBtn.contains(e.target as Node)) return;
  setMenuOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !wsMenu.hidden) setMenuOpen(false);
});

/**
 * 改工作区：有活动任务就改任务本身；否则改草稿（等下一条任务用）。
 * 两种情况都不动其它任务——每个任务的工作区互相独立。
 */
function applyWorkspace(ws: TaskWorkspace): void {
  draftWorkspace = ws;
  const task = currentTask();
  if (task) task.workspace = ws;
  saveTasks();
  renderWorkspace(ws);
  renderTasks();
}

wsMenu.addEventListener('click', async (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.ws-option');
  if (!opt) return;
  const act = opt.dataset.act;
  setMenuOpen(false);

  if (act === 'general') {
    applyWorkspace('general');
    return;
  }
  if (act === 'clear') {
    applyWorkspace(null);
    return;
  }
  if (act === 'folder') {
    const res = await window.tf?.pickFolder();
    if (!res) return;
    if (!res.ok) {
      alert(res.error);
      return;
    }
    if (res.data.canceled || !res.data.path) return;
    applyWorkspace(res.data.path);
  }
});

// 点 chip 本体 = 选文件夹，最常用的一步不必先开菜单
$<HTMLButtonElement>('#wsPick').addEventListener('click', async () => {
  const res = await window.tf?.pickFolder();
  if (!res) return;
  if (!res.ok) {
    alert(res.error);
    return;
  }
  if (res.data.canceled || !res.data.path) return;
  applyWorkspace(res.data.path);
});

/* ---------------- 侧栏收放与设置页 ---------------- */

const side = $<HTMLElement>('#side');
const expandBtn = $<HTMLButtonElement>('#expandBtn');
const SIDE_KEY = 'toolforge.side';

// 收起状态记住，下次开机保持用户习惯
function setSide(open: boolean): void {
  side.classList.toggle('collapsed', !open);
  expandBtn.hidden = open;
  localStorage.setItem(SIDE_KEY, open ? '1' : '0');
}

$<HTMLButtonElement>('#collapseBtn').addEventListener('click', () => setSide(false));
expandBtn.addEventListener('click', () => setSide(true));
setSide(localStorage.getItem(SIDE_KEY) !== '0');

$<HTMLButtonElement>('#settingsBtn').addEventListener('click', () => {
  showView($<HTMLElement>('#viewSettings').hidden ? 'settings' : 'chat');
});
$<HTMLButtonElement>('#backBtn').addEventListener('click', () => showView('chat'));
document.addEventListener('keydown', (e) => {
  // 设置页是独立页面，Esc 相当于返回
  if (e.key === 'Escape' && !$<HTMLElement>('#viewSettings').hidden) showView('chat');
});

if (window.tf) {
  window.tf.onEvent((event) => {
    if (!liveRun) return;
    // 用户可能已经切到别的任务；此时数据照收，但界面不碰
    const onScreen = activeId === liveRun.taskId;

    if (event.type === 'reasoning' && event.reasoning) {
      liveRun.reasoning += event.reasoning;
      // 又在吐思考了（多半是下一步）：标签翻回「思考中…」
      setReasoningDone(false, onScreen);
      if (!onScreen) return;
      // 思考块是纯文本累积，直接改文本比整轮重画便宜得多
      const box = inner.querySelector<HTMLDetailsElement>('.live-turn .reasoning');
      if (box) {
        const body = box.querySelector('.reasoning-body');
        if (body) body.textContent = liveRun.reasoning;
      } else if (inner.querySelector('.live-turn')) {
        paintAll();
      }
      return;
    }

    if (event.type === 'tool_call') {
      // 开始调工具 = 刚才那段思考已经收尾
      setReasoningDone(true, onScreen);
      liveRun.segments.push({
        kind: 'tool',
        trace: { name: event.name || '', args: shorten(JSON.stringify(event.args || {}), 90), t0: Date.now() },
      });
      if (onScreen) paintAll();
      return;
    }

    if (event.type === 'tool_result') {
      // 落定最后一条还在跑的工具
      const tool = [...liveRun.segments]
        .reverse()
        .find((s): s is { kind: 'tool'; trace: LiveTrace } => s.kind === 'tool' && s.trace.ok === undefined);
      if (tool) {
        tool.trace.ok = Boolean(event.ok);
        tool.trace.ms = event.ms;
      }
      if (onScreen) paintAll();
      return;
    }

    if (event.type === 'step') {
      // 新的一步：把半截文字收尾成独立片段，后续文字另起一段。
      // 这样「先说一句 → 调工具 → 再说一句」会按真实顺序排下去，而不是全糊成一段。
      sealTextSegment();
      liveRun.thinking = `思考中…（第 ${event.step} 步，${event.toolCount} 件工具在场）`;
      if (onScreen) setThinkingLabel(liveRun.thinking);
      return;
    }

    if (event.type === 'assistant') {
      // 这一步的正文已经吐完，思考早就结束了；兜个底，免得只走非流式时标签赖在「思考中…」
      setReasoningDone(true, onScreen);
      return;
    }

    if (event.type === 'delta' && event.delta) {
      // 开始吐正文，说明思考收尾了——用户等着看的是这一句，不是那句「思考中…」
      setReasoningDone(true, onScreen);
      const last = liveRun.segments[liveRun.segments.length - 1];
      if (last && last.kind === 'text') last.text += event.delta;
      else liveRun.segments.push({ kind: 'text', text: event.delta });
      if (!onScreen) return;
      queueReplyPaint();
    }
  });
}

/**
 * 翻思考块的标签：thinking↔done。
 *
 * 「想完了」这件事不必等整轮结束——模型开始吐正文或调工具时就已经成立。
 * 只改 summary 的文案和 done 类，不整轮重画：这一步可能反复发生（多步任务每步都想一次），
 * 重画会把用户正在读的内容抖一下。切到别的任务时只记账、不碰 DOM，
 * 因为此刻页面上的节点不属于这一轮。
 */
function setReasoningDone(done: boolean, onScreen: boolean): void {
  if (!liveRun || liveRun.reasoningDone === done) return;
  liveRun.reasoningDone = done;
  if (!onScreen) return;
  const box = inner.querySelector<HTMLDetailsElement>('.live-turn .reasoning');
  if (!box) return; // 思考块还没画出来（比如这一轮压根没思考），下次重画自然带上
  box.classList.toggle('done', done);
  const sum = box.querySelector('summary');
  if (sum) sum.textContent = done ? REASONING_LABEL.done : REASONING_LABEL.thinking;
}

/** 把当前开着的文字段封口，让下一段文字另起一个气泡 */
function sealTextSegment(): void {
  const last = liveRun?.segments[liveRun.segments.length - 1];
  if (last && last.kind === 'text' && !last.text.trim()) {
    // 只可能是空白，直接丢掉，免得留下空气泡
    liveRun!.segments.pop();
  }
}

/**
 * 整轮重画。事件粒度是「工具、步骤」这类低频动作，重画一遍最省心；
 * 高频的流式文字走 queueReplyPaint 增量更新，不会每片都重建。
 */
function paintAll(): void {
  const old = inner.querySelector<HTMLElement>('.live-turn');
  if (!old || !liveRun) return;
  // 保留用户手动展开/收起思考块与工具组的意图
  const wasOpen = old.querySelector<HTMLDetailsElement>('.reasoning')?.open;
  rememberTraceOpen(old);
  const fresh = buildLiveTurn(liveRun);
  const box = fresh.querySelector<HTMLDetailsElement>('.reasoning');
  if (box && wasOpen !== undefined) box.open = wasOpen;
  old.replaceWith(fresh);
  scrollBottom();
}

/** 流式正文按帧合并重画最后一段文字（每片都解析 Markdown 是 O(n²)） */
function queueReplyPaint(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const turn = inner.querySelector<HTMLElement>('.live-turn');
    if (!turn || !liveRun) return;
    const last = liveRun.segments[liveRun.segments.length - 1];
    if (!last || last.kind !== 'text') return;

    // 整轮重画比「精确定位到最后一个气泡」更稳：片段数很少，代价可以忽略
    paintAll();
  });
}

/* ---------------- 启动 ---------------- */

// 启动一律从空白工作区开始：新开窗口是为了干新活，不是接着上次的对话。
// 历史任务仍在左栏里，点一下就回去。
openTask(null);
showView('chat');
refresh();

export { };
