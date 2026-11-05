const electron = require('electron') as typeof import('electron');
const path = require('node:path') as typeof import('node:path');
const fs = require('node:fs') as typeof import('node:fs');
const { app, BrowserWindow, ipcMain, shell, dialog, net } = electron;

type Forge = import('../src/index.js', { with: { 'resolution-mode': 'import' } }).ToolForge;

let win: Electron.BrowserWindow | null = null;
let forge: Forge | null = null;

async function boot(): Promise<void> {
  const { ToolForge } = await import('../src/index.js');
  forge = new ToolForge({
    onEvent: (event) => {
      if (win && !win.isDestroyed()) win.webContents.send('tf:event', event);
    },
  });
  await forge.init();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 界面是纯 HTML/CSS/JS，不进编译流程，仍从源码目录加载
  const query: Record<string, string> = {};
  // 允许测试把一轮的兜底超时调短，好在几秒内验证「卡住能自动解锁」
  if (process.env.TF_TURN_TIMEOUT) query.turnTimeout = process.env.TF_TURN_TIMEOUT;
  win.loadFile(path.resolve(__dirname, '..', '..', 'src', 'ui', 'index.html'), { query });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  // 冒烟自检：TF_SMOKE=1 时加载完即验证桥接并退出，不打扰人
  if (process.env.TF_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const bridge = await win!.webContents.executeJavaScript('typeof window.tf');
        const title = await win!.webContents.executeJavaScript('document.title');
        console.log(`[smoke] bridge=${bridge} title=${title}`);
        // 可选：截图前先跑一段界面操作，用来验证非默认页；返回字符串会打到 stdout
        if (process.env.TF_SMOKE_JS) {
          const out = await win!.webContents.executeJavaScript(process.env.TF_SMOKE_JS);
          if (out !== undefined) console.log(`[smoke] js=${typeof out === 'string' ? out : JSON.stringify(out)}`);
        }
        if (process.env.TF_SHOT) {
          await new Promise((r) => setTimeout(r, 900));
          const img = await win!.webContents.capturePage();
          fs.writeFileSync(process.env.TF_SHOT, img.toPNG());
          console.log(`[smoke] shot=${process.env.TF_SHOT}`);
        }
      } catch (err) {
        console.log('[smoke] failed: ' + (err as Error).message);
      }
      setTimeout(() => app.quit(), 200);
    });
  }
}

function guard<T extends unknown[]>(fn: (...args: T) => unknown) {
  return async (...args: T): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  };
}

/* ---------------- 关于与版本检查 ---------------- */

/**
 * 关于页要的四样东西全从 package.json 读：名字、版本、简介、仓库地址。
 * 发版时只改那一个文件，界面跟着变，不用两处对表。
 */
interface PkgMeta {
  version?: string;
  description?: string;
  repository?: string | { url?: string };
}

const PKG: PkgMeta = (() => {
  try {
    // main.cjs 在 dist/electron 下，往上两层就是项目根
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as PkgMeta;
  } catch {
    return {};
  }
})();

const APP_VERSION = PKG.version || app.getVersion();

/** 仓库标识 owner/name。允许 git+https://…x.git 这类写法，统一成浏览器打得开的地址 */
const REPO_SLUG = (() => {
  const raw = typeof PKG.repository === 'string' ? PKG.repository : PKG.repository?.url || '';
  const m = raw.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : 'tzy168/toolforge';
})();

const REPO_URL = `https://github.com/${REPO_SLUG}`;

/** 只按数字段比大小，'v1.2.3' 与 '1.2.3' 等价；解析不出来的段当 0 */
function cmpVersion(a: string, b: string): number {
  const num = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).map((s) => Number.parseInt(s, 10) || 0);
  const x = num(a);
  const y = num(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 查 GitHub API。404 表示「没有」而不是「出错」，交给调用方决定怎么退 */
async function githubJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'toolforge-updater',
  };
  // 有 token 就用，免得撞上匿名限流；没配也照样能查
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  return res.json();
}

/**
 * 检查新版本。
 *
 * 先看 releases/latest；仓库还没发过 release 时退回 tags——否则刚起步的项目会永远
 * 报「已是最新」。比的是 tag 号而不是提交数，避免把日常提交算成新版本。
 */
async function checkUpdate(): Promise<Record<string, unknown>> {
  const api = `https://api.github.com/repos/${REPO_SLUG}`;
  const release = (await githubJson(`${api}/releases/latest`)) as {
    tag_name?: string;
    html_url?: string;
    body?: string;
    published_at?: string;
  } | null;

  let latest: string | null = null;
  let source: 'release' | 'tag' = 'release';
  let url: string | null = `${REPO_URL}/releases`;
  let notes: string | null = null;
  let publishedAt: string | null = null;

  if (release?.tag_name) {
    latest = String(release.tag_name);
    url = release.html_url || url;
    notes = typeof release.body === 'string' ? release.body.slice(0, 2000) : null;
    publishedAt = release.published_at || null;
  } else {
    const tags = (await githubJson(`${api}/tags?per_page=1`)) as Array<{ name?: string }> | null;
    source = 'tag';
    url = `${REPO_URL}/tags`;
    if (Array.isArray(tags) && tags[0]?.name) latest = String(tags[0].name);
  }

  if (!latest) {
    return { current: APP_VERSION, latest: null, hasUpdate: false, source, url: REPO_URL, notes, publishedAt };
  }
  return { current: APP_VERSION, latest, hasUpdate: cmpVersion(latest, APP_VERSION) > 0, source, url, notes, publishedAt };
}

/* ---------------- Uiverse 在线 loader 目录 ---------------- */

/**
 * Node 内置 fetch 的 TLS 指纹会被 Cloudflare 挡成 403，所以这里走 Electron 的
 * net.fetch（Chromium 网络栈）。只放行 uiverse.io 下的组件路径，别让 IPC 变成任意代理。
 * 联网只在用户点「获取在线样式」时发生，开机与对话都不碰网络。
 */
const UV_ORIGIN = 'https://uiverse.io';
const UV_POST = /^\/([A-Za-z0-9_-]+)\/([a-z]+-[a-z]+-\d+)$/;

async function uvPage(pathname: string): Promise<string> {
  const res = await net.fetch(UV_ORIGIN + pathname, {
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Uiverse 返回 ${res.status}`);
  return res.text();
}

/**
 * 列表页 ?page=1 是第 2 页（不带参数才是第 1 页），每页约 34 款。
 * 页码上限做一道夹逼，免得 IPC 被人拿去当任意翻页器刷站。
 */
async function loaderList(page = 0): Promise<Array<{ author: string; slug: string; path: string }>> {
  const n = Number.isFinite(page) ? Math.min(Math.max(Math.floor(page), 0), 50) : 0;
  const html = await uvPage(n === 0 ? '/loaders' : `/loaders?page=${n}`);
  const re = /href="\/([A-Za-z0-9_-]+)\/([a-z]+-[a-z]+-\d+)"/g;
  const seen = new Set<string>();
  const out: Array<{ author: string; slug: string; path: string }> = [];
  for (const m of html.matchAll(re)) {
    const path = `/${m[1]}/${m[2]}`;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ author: m[1], slug: m[2], path });
    if (out.length >= 24) break;
  }
  return out;
}

/** 组件页把 HTML/CSS 塞在一段 JSON 字符串里，\n 与 HTML 实体都是字面量，先还原 */
function decodeSnippet(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // 页面里属性写成 class=\&quot;loader\&quot;：实体前那道反斜杠必须一起吃掉，
    // 否则解出来是 class=\"loader\"，类名带反斜杠，Shadow DOM 里 CSS 一条都匹配不上。
    .replace(/\\?&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\"/g, '"');
}

/**
 * 原尺寸只用来算等比缩放。只认规则块里独立声明的 width/height，
 * 避开 border-width 这类子串；也认 --size: 70px 的变量写法。
 * 取见到的最大值，宁可多缩一点也不能把大场景裁掉。
 */
function loaderSize(css: string): { width: number; height: number } {
  const dim = (prop: string): number | null => {
    const re = new RegExp('(?:^|[;{]\\s*)' + prop + '\\s*:\\s*(\\d+(?:\\.\\d+)?)px', 'gm');
    const vals = [...css.matchAll(re)].map((m) => Number(m[1])).filter((n) => n > 0);
    return vals.length ? Math.max(...vals) : null;
  };
  const varVals = [...css.matchAll(/--[\w-]+\s*:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  const fallback = varVals.length ? Math.max(...varVals) : 48;
  return { width: dim('width') ?? fallback, height: dim('height') ?? fallback };
}

/** 样式只在 Shadow DOM 里生效，但外链、固定定位与脚本痕迹仍要掐掉 */
function safeLoaderCss(css: string): string {
  return css
    .replace(/@import[^;]*;/gi, '')
    .replace(/url\(\s*[^)]*\)/gi, 'none')
    .replace(/expression\s*\([^)]*\)/gi, '0')
    .replace(/(-moz-binding|behavior)\s*:[^;]*;?/gi, '')
    .replace(/position\s*:\s*fixed/gi, 'position: absolute')
    .slice(0, 12000);
}

async function loaderCss(path: string): Promise<{ css: string; html: string; width: number; height: number }> {
  if (!UV_POST.test(path)) throw new Error('不是有效的 Uiverse 组件地址');
  const page = await uvPage(path);
  const htmlAt = page.indexOf('&lt;!-- HTML --&gt;');
  const cssAt = page.indexOf('/* CSS */');
  if (htmlAt < 0 || cssAt < 0 || cssAt < htmlAt) throw new Error('这个组件页解析不出 CSS/HTML');
  const end = page.indexOf('&quot;,&quot;author', cssAt);
  const raw = page.slice(cssAt, end > cssAt ? end : cssAt + 12000);
  const block = decodeSnippet(raw);
  const css = safeLoaderCss(block.slice(block.indexOf('*/') + 2));
  const html = decodeSnippet(page.slice(htmlAt, cssAt))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/javascript:/gi, '')
    .slice(0, 4000);
  const size = loaderSize(css);
  return { css, html, width: size.width, height: size.height };
}

ipcMain.handle('tf:loaderList', guard((_e: unknown, page?: number) => loaderList(Number(page) || 0)));
ipcMain.handle('tf:loaderCss', guard((_e: unknown, path: string) => loaderCss(String(path))));

ipcMain.handle(
  'tf:about',
  guard(() => ({
    name: 'ToolForge',
    version: APP_VERSION,
    description: PKG.description || '',
    repo: REPO_URL,
  }))
);

ipcMain.handle('tf:checkUpdate', guard(() => checkUpdate()));

// 渲染层里点链接一律经这里开：只放行 https，别把任意协议的执行权交出去
ipcMain.handle(
  'tf:openExternal',
  guard(async (_e: unknown, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('只允许打开 https 链接');
    await shell.openExternal(url);
    return true;
  })
);

ipcMain.handle('tf:state', guard(() => forge!.state()));
ipcMain.handle('tf:chat', guard((_e: unknown, payload: Parameters<Forge['chat']>[0]) => forge!.chat(payload)));
ipcMain.handle('tf:stop', guard(() => forge!.stop()));
ipcMain.handle('tf:approve', guard((_e: unknown, id: string) => forge!.approve(id)));
ipcMain.handle('tf:reject', guard((_e: unknown, id: string) => forge!.reject(id)));
ipcMain.handle('tf:remove', guard((_e: unknown, id: string) => forge!.removeTool(id)));
ipcMain.handle('tf:setEnabled', guard((_e: unknown, id: string, enabled: boolean) => forge!.setEnabled(id, enabled)));
// 联网装依赖的总开关：这是一次显式授权，单独走一条 IPC，别混进「保存配置」
ipcMain.handle('tf:setDepPolicy', guard((_e: unknown, allow: boolean) => forge!.setAllowUnvettedDeps(Boolean(allow))));
ipcMain.handle('tf:saveProvider', guard((_e: unknown, p: unknown) => forge!.saveProvider(p as never)));
ipcMain.handle('tf:removeProvider', guard((_e: unknown, id: string) => forge!.removeProvider(id)));
ipcMain.handle('tf:setActiveProvider', guard((_e: unknown, id: string | null) => forge!.setActiveProvider(id)));
ipcMain.handle('tf:listProviderModels', guard((_e: unknown, p: unknown) => forge!.listProviderModels(p as never)));
ipcMain.handle('tf:openHome', guard(() => shell.openPath(forge!.state().home)));

// 选工作目录。渲染层拿不到 dialog，必须经主进程。
// 只返回路径、不改全局状态：每个任务各存各的工作区，由渲染层决定用在哪条任务上。
ipcMain.handle(
  'tf:pickFolder',
  guard(async () => {
    const pick = await dialog.showOpenDialog(win!, {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
    return { canceled: false, path: pick.filePaths[0] };
  })
);
ipcMain.handle('tf:openWorkspace', guard((_e: unknown, dir: string) => (dir ? shell.openPath(dir) : '')));

ipcMain.handle(
  'tf:exportPack',
  guard(async (_e: unknown, { name, ids }: { name: string; ids: string[] }) => {
    const { file, pack } = forge!.exportPack({ name, ids });
    const pick = await dialog.showSaveDialog(win!, {
      title: '导出工具包',
      defaultPath: `${pack.name}.json`,
      filters: [{ name: 'Tool Pack', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePath) return { canceled: true, file };
    fs.copyFileSync(file, pick.filePath);
    return { canceled: false, path: pick.filePath, count: pack.tools.length };
  })
);

ipcMain.handle(
  'tf:importPack',
  guard(async () => {
    const pick = await dialog.showOpenDialog(win!, {
      title: '导入工具包',
      properties: ['openFile'],
      filters: [{ name: 'Tool Pack', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
    const results = forge!.importPackFromFile(pick.filePaths[0]);
    return { canceled: false, results };
  })
);

app.whenReady().then(async () => {
  await boot();
  // 打包自检：验证「双击图标启动」这条路上，随包 npm 与随包依赖是否真的可用。
  // 必须跑在 createWindow 之前：自检不弹窗口，也不该被界面加载的任何异常干扰。
  // 输出走 console.log 是可行的——被父进程 spawn 并接管管道时，GUI 子系统同样能写到
  // stdout（项目里 [smoke] 那套已经在用这条路）。
  if (process.env.TF_PACK_SELFTEST) {
    try {
      const { runPackSelfTest } = await import('../src/core/packSelfTest.js');
      const report = await runPackSelfTest({
        depName: process.env.TF_SELFTEST_DEP,
        depVersion: process.env.TF_SELFTEST_VERSION,
        keepDir: Boolean(process.env.TF_SELFTEST_KEEP),
      });
      console.log(`[pack-selftest] ${JSON.stringify(report)}`);
      if (report.error) process.exitCode = 1;
    } catch (err) {
      console.log(`[pack-selftest] ${JSON.stringify({ error: (err as Error).message })}`);
      process.exitCode = 1;
    }
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (forge) await forge.close();
  if (process.platform !== 'darwin') app.quit();
});
