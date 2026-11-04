const electron = require('electron') as typeof import('electron');
const path = require('node:path') as typeof import('node:path');
const fs = require('node:fs') as typeof import('node:fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = electron;

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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (forge) await forge.close();
  if (process.platform !== 'darwin') app.quit();
});
