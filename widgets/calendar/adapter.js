// 日历组件族 —— Widgetly 主进程适配层
// 浮动右键菜单（外观调节…/背景透明度滑块/退出）+ 外观窗口（三色）+ 透明度实时转发
const { ipcMain, screen, BrowserWindow } = require('electron');
const path = require('path');

function setup({ instance, win, save }) {
  const instId = instance.id;
  let menuWin = null;
  let menuGen = 0;
  let appearanceWin = null;

  function toggleLock() {
    instance.config = instance.config || {};
    instance.config.locked = !instance.config.locked;
    save();
  }

  function closeMenu() {
    if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    menuWin = null;
  }
  function openMenu(items) {
    if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    const gen = ++menuGen;
    const cur = screen.getCursorScreenPoint();
    const mwin = new BrowserWindow({
      width: 220, height: 80, x: cur.x, y: cur.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    menuWin = mwin;
    mwin.on('closed', () => { if (menuGen === gen) menuWin = null; });
    mwin.on('blur', () => { if (menuGen === gen) closeMenu(); });
    mwin.webContents.on('did-finish-load', () => {
      if (menuGen !== gen || mwin.isDestroyed()) return;
      mwin.webContents.send('cal:menu-items:' + instId, { gen, items });
    });
    mwin.loadFile(path.join(__dirname, 'menu.html'), { query: { inst: instId } });
  }

  ipcMain.on('cal:menu:' + instId, (_e, state) => {
    openMenu([
      { label: '外观调节…', action: 'appearance' },
      { kind: 'slider', label: '背景透明度', value: (state && typeof state.veil === 'number') ? state.veil : 80, action: 'veil' },
      { kind: 'sep' },
      { label: '锁定位置' + ((instance.config && instance.config.locked) ? '（已锁定）' : ''), action: 'lock' },
      { kind: 'sep' },
      { label: '退出此组件', action: 'quit', danger: true },
    ]);
  });

  ipcMain.on('cal:menu-ready:' + instId, (_e, { gen, w, h }) => {
    if (gen !== menuGen) return;
    const mwin = menuWin;
    if (!mwin || mwin.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cur).workArea;
    const mw = Math.max(120, Math.min(340, w || 190));
    const mh = Math.max(40, Math.min(560, h || 80));
    let x = cur.x, y = cur.y;
    if (x + mw > wa.x + wa.width) x = wa.x + wa.width - mw - 6;
    if (y + mh > wa.y + wa.height) y = wa.y + wa.height - mh - 6;
    x = Math.max(wa.x + 2, x); y = Math.max(wa.y + 2, y);
    mwin.setBounds({ x, y, width: mw, height: mh });
    mwin.show();
    mwin.focus();
  });

  ipcMain.on('cal:menu-click:' + instId, (_e, cmd) => {
    closeMenu();
    if (!cmd || !cmd.action) return;
    if (cmd.action === 'quit') {
      global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
      save();
      win.close();
      return;
    }
    if (cmd.action === 'appearance') openAppearance();
    else if (cmd.action === 'lock') toggleLock();
  });

  ipcMain.on('cal:menu-slide:' + instId, (_e, data) => {
    if (!data || data.gen !== menuGen) return;
    if (win && !win.isDestroyed()) win.webContents.send('cal:veil:' + instId, { v: data.v, save: !!data.done });
  });
  ipcMain.on('cal:menu-close:' + instId, closeMenu);

  // ---------- 外观窗口（背景基色/文字色/高亮色） ----------
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + Math.max(0, Math.round((wa.width - 300) / 2));
    const y = wa.y + Math.max(0, Math.round((wa.height - 380) / 2));
    appearanceWin = new BrowserWindow({
      width: 300, height: 380, x, y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }
  ipcMain.handle('cal:appearance-init:' + instId, () => {
    const cfg = instance.config || {};
    return { bgColor: cfg.bgColor || null, textColor: cfg.textColor || null, accentColor: cfg.accentColor || null };
  });
  ipcMain.on('cal:appearance:' + instId, (_e, c) => {
    if (c && win && !win.isDestroyed()) win.webContents.send('cal:appearance-color:' + instId, c);
  });
  ipcMain.on('cal:appearance-close:' + instId, () => {
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
  });
}

module.exports = { setup };
