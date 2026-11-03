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
  step?: number;
  toolCount?: number;
}

interface Bridge {
  state: () => Promise<Envelope<ForgeState>>;
  chat: (payload: { input: string; phase: string; history: Array<{ role: string; content: string }> }) => Promise<Envelope<{ reply: string }>>;
  approve: (id: string) => Promise<Envelope<unknown>>;
  reject: (id: string) => Promise<Envelope<unknown>>;
  remove: (id: string) => Promise<Envelope<unknown>>;
  setEnabled: (id: string, enabled: boolean) => Promise<Envelope<unknown>>;
  saveProvider: (p: Partial<ProviderView> & { apiKey?: string }) => Promise<Envelope<unknown>>;
  removeProvider: (id: string) => Promise<Envelope<unknown>>;
  setActiveProvider: (id: string | null) => Promise<Envelope<unknown>>;
  listProviderModels: (p: { id: string; baseURL?: string; apiKey?: string }) => Promise<Envelope<string[]>>;
  openHome: () => Promise<Envelope<unknown>>;
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
let currentTurn: HTMLElement | null = null;
let lastTraceItem: { item: HTMLElement; detail: HTMLElement; state: HTMLElement } | null = null;
// 流式回答的累积文本，每轮开始清空
let streamBuffer = '';
// 流式片段按帧合并：每片都重新解析 Markdown 是 O(n²)，一屏的量级也够卡
let renderQueued = false;

/* ---------------- 任务（每段对话一条记录） ---------------- */

interface Task {
  id: string;
  title: string;
  phase: 'work' | 'create';
  history: Array<{ role: string; content: string }>;
  at: number;
}

const TASK_KEY = 'toolforge.tasks';

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
  };
  tasks.unshift(task);
  activeId = task.id;
  return task;
}

function renderTasks(): void {
  const list = $<HTMLDivElement>('#taskList');
  list.innerHTML = '';
  if (!tasks.length) {
    const tip = el('div', 'side-empty');
    tip.textContent = '还没有任务。发一句话就开一个。';
    list.appendChild(tip);
    return;
  }
  for (const task of tasks) {
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
        activeId = tasks[0]?.id ?? null;
        openTask(activeId);
      }
      saveTasks();
      renderTasks();
    };
    row.append(title, del);
    row.onclick = () => openTask(task.id);
    list.appendChild(row);
  }
}

/* ---------------- 视图切换 ---------------- */

/** 切换工作模式。页签点击与空状态快捷入口共用，避免两处各写一遍占位文案 */
function setPhase(next: 'work' | 'create'): void {
  phase = next;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', (t as HTMLElement).dataset.phase === phase);
  });
  $<HTMLTextAreaElement>('#input').placeholder =
    phase === 'create' ? '描述你要造的工具，例如：抓取某个页面的标题' : '说说你要做什么…（Shift + Enter 换行）';
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
  box.innerHTML = '<h1>创建你自己的 Agent</h1><p>凡能力皆为工具。缺什么，让它现造一件。</p>';
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

/** AI 气泡：渲染成 Markdown；内容为模型输出，已过 DOMPurify */
function botTurn(content = ''): HTMLElement {
  const turn = el('div', 'turn turn-bot');
  const body = el('div', 'msg-bot md');
  body.innerHTML = content ? markdownToHtml(content) : '';
  turn.appendChild(body);
  return turn;
}

// 切换任务时从 history 重建对话；工具调用轨迹不落盘，重建后只留问答
// ponytail: 轨迹只在当前会话可见，要留存得在 Task 里一起存 turns
function renderHistory(task: Task | null): void {
  inner.innerHTML = '';
  const history = task?.history ?? [];
  if (!history.length) {
    inner.appendChild(emptyState());
    return;
  }
  for (let i = 0; i < history.length; i += 2) {
    const user = history[i];
    const bot = history[i + 1];
    if (user) inner.appendChild(userTurn(user.content));
    if (bot) inner.appendChild(botTurn(bot.content || '（没有输出）'));
  }
  scrollBottom();
}

function openTask(id: string | null): void {
  activeId = id;
  const task = currentTask();
  // 每个任务记着自己的模式，切回来不用重选
  setPhase(task?.phase ?? 'work');
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
  $<HTMLSpanElement>('#headTools').textContent = `${live.filter((t) => t.status === 'active').length} 件工具`;
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

function setBusy(v: boolean): void {
  busy = v;
  $<HTMLButtonElement>('#sendBtn').disabled = v;
  $<HTMLTextAreaElement>('#input').disabled = v;
}

function shorten(s: string, n: number): string {
  return s && s.length > n ? s.slice(0, n) + '…' : s || '';
}

function addTrace(event: EventPayload): void {
  if (!currentTurn) return;
  const trace = currentTurn.querySelector('.trace');
  if (!trace) return;

  const item = el('div', 'trace-item');
  const nm = el('span', 't-name');
  nm.textContent = event.name || '';
  const detail = el('span');
  detail.textContent = event.type === 'tool_call' ? shorten(JSON.stringify(event.args || {}), 90) : '';
  const state = el('span');
  state.textContent = event.type === 'tool_call' ? '…' : '';
  item.append(nm, detail, state);

  if (event.type === 'tool_call') {
    trace.appendChild(item);
    lastTraceItem = { item, detail, state };
  } else if (lastTraceItem) {
    lastTraceItem.state.textContent = event.ok ? `✓ ${event.ms || 0}ms` : '✗';
    lastTraceItem.state.className = event.ok ? 't-ok' : 't-fail';
    lastTraceItem = null;
  }
  scrollBottom();
}

async function send(text: string): Promise<void> {
  if (busy || !text.trim()) return;
  if (!window.tf) {
    alert('请在 Electron 中运行：pnpm start');
    return;
  }
  setBusy(true);
  const task = ensureTask(text);
  task.at = Date.now();
  // 任务列表按最近活动排序
  tasks = [task, ...tasks.filter((t) => t.id !== task.id)];
  renderTasks();

  const empty = inner.querySelector('#empty');
  if (empty) empty.remove();

  inner.appendChild(userTurn(text));

  // 一条 AI 回复里可能有多轮工具调用，trace 记在气泡上方
  currentTurn = el('div', 'turn turn-bot');
  currentTurn.innerHTML = '<div class="trace"></div><div class="msg-bot md typing">思考中…</div>';
  inner.appendChild(currentTurn);
  scrollBottom();

  const turn = currentTurn;
  const bubble = turn.querySelector('.msg-bot') as HTMLElement;
  let streamed = '';
  try {
    const res = await window.tf.chat({ input: text, phase, history: task.history });
    bubble.classList.remove('typing');
    if (res.ok) {
      // 最终文本以返回值收尾，覆盖流式过程中可能被丢弃的尾部碎片
      streamed = res.data.reply || '';
      bubble.innerHTML = streamed ? markdownToHtml(streamed) : '（没有输出）';
      task.history.push({ role: 'user', content: text }, { role: 'assistant', content: streamed });
      task.history = task.history.slice(-8);
    } else {
      bubble.textContent = '出错了：' + res.error;
    }
  } catch (err) {
    bubble.classList.remove('typing');
    bubble.textContent = '出错了：' + (err as Error).message;
  }

  currentTurn = null;
  lastTraceItem = null;
  setBusy(false);
  scrollBottom();
  saveTasks();
  refresh();
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
  renderTasks();
  renderHistory(null);
  showView('chat');
  $<HTMLTextAreaElement>('#input').focus();
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
    if (event.type === 'tool_call' || event.type === 'tool_result') addTrace(event);
    if (event.type === 'step' && currentTurn) {
      // 每一步开始时清空累积文本：前一步的内容多半是「我先查一下」，最终答案在最后一步
      streamBuffer = '';
      const tip = currentTurn.querySelector<HTMLElement>('.msg-bot.typing');
      if (tip) tip.textContent = `思考中…（第 ${event.step} 步，${event.toolCount} 件工具在场）`;
    }
    // 流式增量：先拼到本地字符串，再按帧整段重渲染 MD（每片都解析会 O(n²)）
    if (event.type === 'delta' && currentTurn && event.delta) {
      streamBuffer += event.delta;
      const turn = currentTurn;
      turn.querySelector('.msg-bot.typing')?.classList.remove('typing');
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(() => {
          renderQueued = false;
          const bubble = turn.querySelector<HTMLElement>('.msg-bot');
          if (!bubble) return;
          bubble.innerHTML = markdownToHtml(streamBuffer);
          scrollBottom();
        });
      }
    }
  });
}

/* ---------------- 启动 ---------------- */

if (!activeId && tasks.length) activeId = tasks[0].id;
openTask(activeId);
showView('chat');
refresh();

export {};
