const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

// 只开这几个口子，渲染进程碰不到 Node
contextBridge.exposeInMainWorld('tf', {
  state: () => ipcRenderer.invoke('tf:state'),
  chat: (payload: unknown) => ipcRenderer.invoke('tf:chat', payload),
  stop: () => ipcRenderer.invoke('tf:stop'),
  approve: (id: string) => ipcRenderer.invoke('tf:approve', id),
  reject: (id: string) => ipcRenderer.invoke('tf:reject', id),
  remove: (id: string) => ipcRenderer.invoke('tf:remove', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('tf:setEnabled', id, enabled),
  saveProvider: (p: unknown) => ipcRenderer.invoke('tf:saveProvider', p),
  removeProvider: (id: string) => ipcRenderer.invoke('tf:removeProvider', id),
  setActiveProvider: (id: string | null) => ipcRenderer.invoke('tf:setActiveProvider', id),
  listProviderModels: (p: unknown) => ipcRenderer.invoke('tf:listProviderModels', p),
  openHome: () => ipcRenderer.invoke('tf:openHome'),
  pickFolder: () => ipcRenderer.invoke('tf:pickFolder'),
  openWorkspace: (dir: string) => ipcRenderer.invoke('tf:openWorkspace', dir),
  exportPack: (payload: unknown) => ipcRenderer.invoke('tf:exportPack', payload),
  importPack: () => ipcRenderer.invoke('tf:importPack'),
  // 关于页：版本/简介/仓库地址 + 检查更新 + 开外链（都走主进程，渲染层不碰网络与 shell）
  about: () => ipcRenderer.invoke('tf:about'),
  checkUpdate: () => ipcRenderer.invoke('tf:checkUpdate'),
  openExternal: (url: string) => ipcRenderer.invoke('tf:openExternal', url),
  onEvent: (cb: (event: unknown) => void) => {
    ipcRenderer.on('tf:event', (_e, data) => cb(data));
  },
});
