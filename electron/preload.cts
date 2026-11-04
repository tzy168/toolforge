const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

// 只开这几个口子，渲染进程碰不到 Node
contextBridge.exposeInMainWorld('tf', {
  state: () => ipcRenderer.invoke('tf:state'),
  chat: (payload: unknown) => ipcRenderer.invoke('tf:chat', payload),
  approve: (id: string) => ipcRenderer.invoke('tf:approve', id),
  reject: (id: string) => ipcRenderer.invoke('tf:reject', id),
  remove: (id: string) => ipcRenderer.invoke('tf:remove', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('tf:setEnabled', id, enabled),
  saveProvider: (p: unknown) => ipcRenderer.invoke('tf:saveProvider', p),
  removeProvider: (id: string) => ipcRenderer.invoke('tf:removeProvider', id),
  setActiveProvider: (id: string | null) => ipcRenderer.invoke('tf:setActiveProvider', id),
  listProviderModels: (p: unknown) => ipcRenderer.invoke('tf:listProviderModels', p),
  openHome: () => ipcRenderer.invoke('tf:openHome'),
  pickWorkspace: () => ipcRenderer.invoke('tf:pickWorkspace'),
  clearWorkspace: () => ipcRenderer.invoke('tf:clearWorkspace'),
  openWorkspace: () => ipcRenderer.invoke('tf:openWorkspace'),
  exportPack: (payload: unknown) => ipcRenderer.invoke('tf:exportPack', payload),
  importPack: () => ipcRenderer.invoke('tf:importPack'),
  onEvent: (cb: (event: unknown) => void) => {
    ipcRenderer.on('tf:event', (_e, data) => cb(data));
  },
});
