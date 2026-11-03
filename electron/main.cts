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
  win.loadFile(path.resolve(__dirname, '..', '..', 'src', 'ui', 'index.html'));
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

ipcMain.handle('tf:state', guard(() => forge!.state()));
ipcMain.handle('tf:chat', guard((_e: unknown, payload: Parameters<Forge['chat']>[0]) => forge!.chat(payload)));
ipcMain.handle('tf:approve', guard((_e: unknown, id: string) => forge!.approve(id)));
ipcMain.handle('tf:reject', guard((_e: unknown, id: string) => forge!.reject(id)));
ipcMain.handle('tf:remove', guard((_e: unknown, id: string) => forge!.removeTool(id)));
ipcMain.handle('tf:setEnabled', guard((_e: unknown, id: string, enabled: boolean) => forge!.setEnabled(id, enabled)));
ipcMain.handle('tf:saveProvider', guard((_e: unknown, p: unknown) => forge!.saveProvider(p as never)));
ipcMain.handle('tf:removeProvider', guard((_e: unknown, id: string) => forge!.removeProvider(id)));
ipcMain.handle('tf:setActiveProvider', guard((_e: unknown, id: string | null) => forge!.setActiveProvider(id)));
ipcMain.handle('tf:listProviderModels', guard((_e: unknown, p: unknown) => forge!.listProviderModels(p as never)));
ipcMain.handle('tf:openHome', guard(() => shell.openPath(forge!.state().home)));

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
