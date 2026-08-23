const { contextBridge, ipcRenderer, clipboard } = require('electron');

const instId = new URLSearchParams(globalThis.location?.search || '').get('inst')
  || 'prompt-optimizer-1';

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('widgetlyPrompt', {
  instanceId: instId,
  init: () => ipcRenderer.invoke(`prompt:init:${instId}`),
  saveDraft: (draft) => ipcRenderer.send(`prompt:draft:${instId}`, String(draft || '')),
  saveResult: (result) => ipcRenderer.send(`prompt:result:${instId}`, String(result || '')),
  setStrength: (strength) => ipcRenderer.send(`prompt:strength:${instId}`, Number(strength)),
  setResultExpanded: (expanded) => ipcRenderer.send(`prompt:result-expanded:${instId}`, !!expanded),
  openWorkspace: (kind) => ipcRenderer.send(`prompt:workspace-open:${instId}`, kind === 'quick' ? 'quick' : 'visible'),
  closeWorkspace: () => ipcRenderer.send(`prompt:workspace-close:${instId}`),
  minimizeWorkspace: () => ipcRenderer.send(`prompt:workspace-minimize:${instId}`),
  toggleMaximizeWorkspace: () => ipcRenderer.send(`prompt:workspace-maximize:${instId}`),
  openModelSettings: () => ipcRenderer.send(`prompt:model-settings:${instId}`),
  openMenu: () => ipcRenderer.send(`prompt:menu:${instId}`),
  showOpacity: () => ipcRenderer.send(`prompt:opacity-panel:${instId}`),
  setOpacity: (opacity) => ipcRenderer.send(`prompt:bg-opacity:${instId}`, Number(opacity)),
  activate: () => ipcRenderer.send('activate'),
  startDrag: () => ipcRenderer.send('drag-start'),
  endDrag: () => ipcRenderer.send('drag-end'),
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(String(text || '')),
  onState: (callback) => on(`prompt:state:${instId}`, callback),
  onForceMini: (callback) => on(`prompt:force-mini:${instId}`, callback),
  onShowOpacity: (callback) => on(`prompt:show-opacity:${instId}`, callback),
  onOpenModelSettings: (callback) => on(`prompt:open-model-settings:${instId}`, callback),
});
