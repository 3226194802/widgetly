// 图库组件 —— Widgetly 主进程适配层
// 小/中/大三种尺寸共用；右键菜单（设置/退出）；设置弹出独立大窗口
// 图库文件夹读取 + 轮播配置持久化
const { ipcMain, Menu, dialog, screen, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 支持的图片格式（尽量多）
const IMAGE_EXTS = ['.jpg', '.jpeg', '.jfif', '.pjpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff', '.avif'];
const DEFAULTS = { folder: null, duration: 5, order: 'random', locked: false };

function setup({ instance, win, save }) {
  const instId = instance.id;

  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let folder = typeof saved.folder === 'string' && saved.folder ? saved.folder : null;
  let duration = (typeof saved.duration === 'number' && saved.duration > 0) ? saved.duration : 5;
  let order = saved.order === 'sequence' ? 'sequence' : 'random';
  let locked = !!saved.locked;
  let images = [];
  let settingsWin = null;

  function persist() {
    instance.config = { folder, duration, order, locked };
    save();
  }
  function toggleLock() {
    locked = !locked;
    persist();
    if (win && !win.isDestroyed()) win.webContents.send('lock:' + instId, locked);
  }

  // 读取图库文件夹下的图片（按名称排序，稳定顺序）
  function readImages() {
    images = [];
    if (!folder) return;
    try {
      images = fs.readdirSync(folder)
        .filter((f) => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
        .map((f) => path.join(folder, f))
        .sort();
    } catch (_) {}
  }

  function pushImages() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('gallery:images:' + instId, images);
  }
  function pushConfig() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('gallery:config:' + instId, { folder, duration, order });
  }
  function pushSettingsConfig() {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('gallery:settings-config:' + instId, { folder, duration, order });
    }
  }

  async function pickFolder() {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图库文件夹',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return;
    folder = r.filePaths[0];
    persist();
    readImages();
    pushImages();
    pushConfig();
    pushSettingsConfig();
  }

  // 独立设置窗口：比组件窗口大得多，内容完整显示
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const sw = 360, sh = 330;
    let sx = wx + ww + 12;
    let sy = wy;
    const wa = screen.getPrimaryDisplay().workArea;
    if (sx + sw > wa.x + wa.width) sx = Math.max(wa.x + 8, wx - sw - 12);
    if (sy + sh > wa.y + wa.height) sy = wa.y + wa.height - sh - 10;
    settingsWin = new BrowserWindow({
      width: sw,
      height: sh,
      x: sx,
      y: sy,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
    save();
    win.close();
  }

  // 组件窗口 IPC
  ipcMain.on('gallery:pick-folder:' + instId, pickFolder);
  ipcMain.on('gallery:set-config:' + instId, (_e, cfg) => {
    if (!cfg) return;
    if (typeof cfg.duration === 'number' && cfg.duration > 0) duration = cfg.duration;
    if (cfg.order === 'sequence' || cfg.order === 'random') order = cfg.order;
    persist();
    pushConfig();
  });
  ipcMain.handle('gallery:init:' + instId, () => {
    readImages();
    return { folder, duration, order, images, locked };
  });

  // 设置窗口 IPC
  ipcMain.handle('gallery:settings-init:' + instId, () => ({ folder, duration, order }));
  ipcMain.on('gallery:settings-pick:' + instId, pickFolder);
  ipcMain.on('gallery:settings-set:' + instId, (_e, cfg) => {
    if (!cfg) return;
    if (typeof cfg.duration === 'number' && cfg.duration > 0) duration = cfg.duration;
    if (cfg.order === 'sequence' || cfg.order === 'random') order = cfg.order;
    persist();
    pushConfig();
    pushSettingsConfig();
  });
  ipcMain.on('gallery:settings-close:' + instId, () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });

  // 右键菜单：设置（独立大窗口）/ 锁定位置 / 退出
  win.webContents.on('context-menu', () => {
    if (!win.isFocused()) win.focus();
    try {
      Menu.buildFromTemplate([
        { label: '设置…', click: openSettings },
        { type: 'separator' },
        { label: '锁定位置', type: 'checkbox', checked: locked, click: toggleLock },
        { type: 'separator' },
        { label: '退出此组件', click: quitWidget },
      ]).popup({ window: win });
    } catch (_) {}
  });

  win.webContents.on('did-finish-load', () => {
    readImages();
    pushConfig();
    pushImages();
  });
}

module.exports = { setup };
