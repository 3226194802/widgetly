const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

function setup({ instance, win, getModel, command, openChildSettings }) {
  const id = instance.id;
  let settingsWin = null;
  const listeners = [];
  const handles = [];
  const on = (channel, handler) => { ipcMain.on(channel, handler); listeners.push([channel, handler]); };
  const handle = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); handles.push(channel); };

  const notify = (message = '', { render = true, layout = false } = {}) => {
    if (!win.isDestroyed() && render) {
      win.webContents.send('componentDock:changed:' + id);
    }
    if (!win.isDestroyed() && layout) win.webContents.send('componentDock:layout:' + id, getModel());
    if (!win.isDestroyed() && message) win.webContents.send('dockgroup:toast:' + id, message);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('componentDock:changed:' + id);
  };
  const openSettings = () => {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    const workArea = screen.getDisplayNearestPoint(win.getBounds()).workArea;
    settingsWin = new BrowserWindow({
      width: 820, height: 660, minWidth: 620, minHeight: 500,
      x: workArea.x + Math.max(0, Math.round((workArea.width - 820) / 2)),
      y: workArea.y + Math.max(0, Math.round((workArea.height - 660) / 2)),
      frame: false, transparent: true, resizable: true, maximizable: true, minimizable: true,
      fullscreenable: false, show: false, skipTaskbar: false, hasShadow: true,
      backgroundColor: '#00000000', title: 'Widgetly 组件坞编辑器',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const current = settingsWin;
    current.on('closed', () => { if (settingsWin === current) settingsWin = null; });
    current.once('ready-to-show', () => { if (!current.isDestroyed()) { current.show(); current.focus(); } });
    current.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: id } });
  };
  const run = async (_event, payload) => {
    const result = await command(payload || {});
    // 拖拽缩放会在每一帧发送轻量预览。主进程已通过 layout 消息更新坐标；
    // 这里若再发 changed 会重建全部 iframe，正是此前松手后闪现的原因。
    if (payload && (payload.action === 'child-rect' || payload.action === 'child-rect-preview')) return result || { ok: true };
    if (result && result.message) notify(result.message);
    else notify();
    return result || { ok: true };
  };

  handle('componentDock:get:' + id, () => getModel());
  handle('componentDock:command:' + id, run);
  on('componentDock:command:' + id, run);
  on('dockgroup:settings-open:' + id, openSettings);
  on('dockgroup:child-settings:' + id, (_event, childId) => openChildSettings(String(childId || '')));
  on('dockgroup:child-detach:' + id, (_event, childId) => run(null, { action: 'detach', childId }));
  on('dockgroup:child-remove:' + id, (_event, childId) => run(null, { action: 'remove', childId }));
  on('dockgroup:reflow:' + id, () => run(null, { action: 'reflow' }));
  on('dockgroup:dissolve:' + id, () => run(null, { action: 'dissolve' }));
  on('dockgroup:delete:' + id, () => run(null, { action: 'delete' }));
  on('dockgroup:child-transparency:' + id, (_event, data) => run(null, { action: 'childTransparency', ...(data || {}) }));
  const preview = (_event, data) => {
    if (!win.isDestroyed()) win.webContents.send('componentDock:drop-preview:' + id, data || { active: false });
  };
  on('componentDock:drop-preview:' + id, preview);

  win.on('closed', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    settingsWin = null;
    handles.forEach((channel) => ipcMain.removeHandler(channel));
    listeners.forEach(([channel, handler]) => ipcMain.removeListener(channel, handler));
  });
  return { notify, openSettings };
}

module.exports = { setup };
