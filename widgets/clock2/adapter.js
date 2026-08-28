// 数字时钟（长条/小方/带秒）—— 主进程适配器
const { Menu, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const DEFAULTS = {
  hour12: false,
  theme: 'auto',      // auto | light | dark
  showSeconds: false, // clock2Sec 默认 true
  locked: false,
  customized: false,  // 是否手动调过外观（外观/透明度）
  bgOpacity: 0.4,     // 卡片底色不透明度（默认背景透明度 60%）
  bgColor: '#1e212a', // 卡片底色（深色主题基底）
  fontColor: '#f2eee6',
};

function setup({ instance, win, save }) {
  // 带秒型号默认显示秒钟；用户手动设置后以 instance.config 为准
  const isSec = instance.widgetId === 'clock2Sec';
  const cfg = { ...DEFAULTS, ...(isSec ? { showSeconds: true } : {}), ...(instance.config || {}) };
  if (!instance.config) instance.config = {};
  let appearanceWin = null;
  const instId = instance.id;

  const persist = () => { instance.config = { ...cfg }; save(); };

  const pushCfg = () => {
    if (!win.isDestroyed()) win.webContents.send('clock2:cfg:' + instId, cfg);
  };
  const pushStyle = () => {
    if (!win.isDestroyed()) win.webContents.send('clock2:style:' + instId, { bgColor: cfg.bgColor, bgOpacity: cfg.bgOpacity, fontColor: cfg.fontColor, customized: !!cfg.customized });
  };
  win.webContents.on('did-finish-load', () => { pushCfg(); pushStyle(); });

  // ---------- 外观调节窗口（背景颜色 / 字体颜色） ----------
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    appearanceWin = new BrowserWindow({
      width: 300, height: 280,
      x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 280) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }

  ipcMain.on('clock2:appearance-open:' + instId, openAppearance);
  ipcMain.on('clock2:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });
  ipcMain.handle('clock2:appearance-init:' + instId, () => ({ bgColor: cfg.bgColor, fontColor: cfg.fontColor }));
  ipcMain.on('clock2:appearance:' + instId, (_e, c) => {
    if (!c) return;
    if (typeof c.bgColor === 'string') { cfg.bgColor = c.bgColor; cfg.customized = true; }
    if (typeof c.fontColor === 'string') { cfg.fontColor = c.fontColor; cfg.customized = true; }
    persist();
    pushStyle();
  });
  ipcMain.on('clock2:bg-opacity:' + instId, (_e, v) => {
    if (typeof v === 'number') {
      cfg.bgOpacity = Math.max(0, Math.min(1, v));
      persist();
      pushStyle();
    }
  });
  ipcMain.on('clock2:options:' + instId, (_e, options) => {
    if (!options || typeof options !== 'object') return;
    if (typeof options.hour12 === 'boolean') cfg.hour12 = options.hour12;
    if (typeof options.showSeconds === 'boolean') cfg.showSeconds = options.showSeconds;
    if (options.theme === 'auto' || options.theme === 'light' || options.theme === 'dark') cfg.theme = options.theme;
    persist();
    pushCfg();
  });

  win.on('closed', () => {
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
  });
}

module.exports = { setup };
