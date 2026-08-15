// 灵动时钟（含小/中号）—— Widgetly 主进程适配层
// 右键菜单 = 独立浮动菜单窗口（小号窗口装不下窗口内菜单）；透明度滑杆在菜单窗口内拖动，实时转发给组件
const { ipcMain, screen, BrowserWindow } = require('electron');
const path = require('path');

function setup({ instance, win, save }) {
  const instId = instance.id;
  const isClockM = instance.widgetId === 'clockM';   // 中号时钟专属功能
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
      width: 220, height: 80,
      x: cur.x, y: cur.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    menuWin = mwin;
    mwin.on('closed', () => { if (menuGen === gen) menuWin = null; });
    mwin.on('blur', () => { if (menuGen === gen) closeMenu(); });
    mwin.webContents.on('did-finish-load', () => {
      if (menuGen !== gen || mwin.isDestroyed()) return;
      mwin.webContents.send('clock:menu-items:' + instId, { gen, items });
    });
    mwin.loadFile(path.join(__dirname, 'menu.html'), { query: { inst: instId } });
  }

  // 右键菜单请求（renderer 附带当前状态用于菜单显示）
  ipcMain.on('clock:menu:' + instId, (_e, state) => {
    const items = [
      { label: '12/24 小时制', state: (state && state.hour12) ? '12 小时' : '24 小时', action: 'hour12' },
      { label: '深色/浅色模式', state: (state && state.theme === 'dark') ? '深色' : '浅色', action: 'theme' },
      { label: '外观调节…', action: 'appearance' },
      { kind: 'slider', label: '背景透明度', value: (state && typeof state.veil === 'number') ? state.veil : 32, action: 'veil' },
      { kind: 'sep' },
      { label: '锁定位置' + ((instance.config && instance.config.locked) ? '（已锁定）' : ''), action: 'lock' },
      { label: '复制当前时间', action: 'copy' },
      { kind: 'sep' },
      { label: '退出此组件', action: 'quit', danger: true },
    ];
    openMenu(items);
  });

  // 菜单内容渲染完成 → 按内容尺寸定位（避开屏幕边缘）后显示
  ipcMain.on('clock:menu-ready:' + instId, (_e, { gen, w, h }) => {
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

  // 菜单项点击 → 分发给组件 renderer 执行（hour12/theme/copy/appearance）；quit 由主进程处理
  ipcMain.on('clock:menu-click:' + instId, (_e, cmd) => {
    closeMenu();
    if (!cmd || !cmd.action) return;
    if (cmd.action === 'quit') {
      global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
      save();
      win.close();
      return;
    }
    if (cmd.action === 'appearance') { openAppearance(); return; }
    if (cmd.action === 'lock') { toggleLock(); return; }
    if (win && !win.isDestroyed()) {
      win.webContents.send('clock:menu:' + instId, { action: cmd.action });
    }
  });

  // ---------- 外观调节窗口（标准/小号：背景底色 + 4 数字色；中号：背景底色 + 左边填充/右边描边） ----------
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + Math.max(0, Math.round((wa.width - 320) / 2));
    const y = wa.y + Math.max(0, Math.round((wa.height - 420) / 2));
    appearanceWin = new BrowserWindow({
      width: 320, height: 420, x, y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }
  ipcMain.handle('clock:appearance-init:' + instId, () => {
    const cfg = instance.config || {};
    return {
      kind: isClockM ? 'medium' : 'gradient',
      bgColor: cfg.bgColor || null,
      digitColors: cfg.digitColors || {},
      hourColor: cfg.hourColor || '#ffffff',
      minuteColor: cfg.minuteColor || '#ffffff',
    };
  });
  ipcMain.on('clock:appearance:' + instId, (_e, c) => {
    if (c && win && !win.isDestroyed()) win.webContents.send('clock:appearance-color:' + instId, c);
  });
  ipcMain.on('clock:appearance-reset:' + instId, () => {
    if (win && !win.isDestroyed()) win.webContents.send('clock:appearance-reset:' + instId);
  });
  ipcMain.on('clock:appearance-close:' + instId, () => {
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
  });

  // 透明度滑杆：菜单窗口拖动中实时转发（save=false），松手保存（save=true）
  ipcMain.on('clock:menu-slide:' + instId, (_e, data) => {
    if (!data || data.gen !== menuGen) return;
    const v = data.v;
    if (win && !win.isDestroyed()) {
      win.webContents.send('clock:veil:' + instId, { v, save: !!data.done });
    }
  });

  ipcMain.on('clock:menu-close:' + instId, closeMenu);
}

module.exports = { setup };
