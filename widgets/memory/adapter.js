// 内存监控组件 —— Widgetly 主进程适配层
// 数据：RAM（os 模块，1s 轮询）+ 磁盘（fs.statfsSync，30s 轮询）；外观（曲线色/进度条色/字体色/背景模式）+ 菜单；IPC 按实例隔离
const { ipcMain, Menu, BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULTS = {
  appearance: {
    curveColor: '#ffd24a',   // 心电图曲线颜色
    barColor: '#a07fff',     // 进度条颜色
    fontColor: '#f2eee6',    // 字体颜色
    bgMode: 'frosted',       // 背景：transparent | frosted | solid
    bgColor: '#191722',      // 纯色背景色（solid 模式 / frosted 罩层基色）
  },
  pinned: false,
  locked: false,
};

function setup({ instance, win, save }) {
  const instId = instance.id;
  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let appearance = { ...DEFAULTS.appearance, ...(saved.appearance || {}) };
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  let appearanceWin = null;
  let ramTimer = null, diskTimer = null;

  function persist() {
    instance.config = { appearance, pinned, locked };
    save();
  }
  function pushAppearance() {
    if (win && !win.isDestroyed()) win.webContents.send('memory:appearance:' + instId, appearance);
  }

  // ---------- 数据采集 ----------
  function getDisks() {
    const disks = [];
    for (let c = 67; c <= 90; c++) {   // A-Z
      const letter = String.fromCharCode(c);
      try {
        const s = fs.statfsSync(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bavail) * Number(s.bsize);
        if (total > 0) disks.push({ letter, label: letter + '盘', total, free });
      } catch (_) {}
    }
    disks.sort((a, b) => (a.letter === 'C' ? -1 : b.letter === 'C' ? 1 : a.letter.localeCompare(b.letter)));
    return disks.slice(0, 2);   // 最多显示两个盘符
  }
  function pushRam() {
    if (!win || win.isDestroyed()) return;
    const total = os.totalmem(), free = os.freemem();
    win.webContents.send('memory:ram:' + instId, { total, used: total - free });
  }
  function pushDisks() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('memory:disks:' + instId, getDisks());
  }

  // ---------- 外观设置窗口 ----------
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const p = { x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 360) / 2)) };
    appearanceWin = new BrowserWindow({
      width: 300, height: 360, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }

  // ---------- 置顶/锁定/退出 ----------
  function togglePin() { pinned = !pinned; win.setAlwaysOnTop(pinned, 'floating'); persist(); }
  function toggleLock() { locked = !locked; persist(); if (win && !win.isDestroyed()) win.webContents.send('memory:lock:' + instId, locked); }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter(i => i.id !== instId);
    save();
    win.close();
  }

  // ---------- 右键菜单 ----------
  function openMenu() {
    if (!win.isFocused()) win.focus();
    try {
      Menu.buildFromTemplate([
        { label: '外观调节…', click: openAppearance },
        { type: 'separator' },
        { label: '置顶显示', type: 'checkbox', checked: pinned, click: togglePin },
        { label: '锁定位置', type: 'checkbox', checked: locked, click: toggleLock },
        { type: 'separator' },
        { label: '退出此组件', click: quitWidget },
      ]).popup({ window: win });
    } catch (_) {}
  }

  // ---------- IPC ----------
  ipcMain.on('memory:appearance:' + instId, (_e, a) => {
    if (a && typeof a === 'object') {
      appearance = { ...appearance, ...a };
      persist();
      pushAppearance();
    }
  });
  ipcMain.on('memory:appearance-open:' + instId, openAppearance);
  ipcMain.on('memory:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });
  ipcMain.handle('memory:appearance-init:' + instId, () => appearance);
  ipcMain.on('memory:menu:' + instId, openMenu);
  ipcMain.on('memory:quit:' + instId, quitWidget);

  win.webContents.on('context-menu', openMenu);
  win.webContents.on('did-finish-load', () => {
    pushAppearance();
    pushRam();
    pushDisks();
    win.webContents.send('memory:lock:' + instId, locked);
    if (ramTimer) clearInterval(ramTimer);
    if (diskTimer) clearInterval(diskTimer);
    ramTimer = setInterval(pushRam, 2000);       // RAM 实时（2s 一次，降低 canvas 重绘/合成开销）
    diskTimer = setInterval(pushDisks, 30000);   // 磁盘较慢变化（避免 statfsSync 频繁扫盘）
  });
  win.on('closed', () => {
    if (ramTimer) clearInterval(ramTimer);
    if (diskTimer) clearInterval(diskTimer);
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
  });

  if (pinned) win.setAlwaysOnTop(true, 'floating');
}

module.exports = { setup };
