// AI 用量监控组件 —— Widgetly 主进程适配层
// 多 Agent 平台（Hermes/Claude Code/Codex/…）检测与数据轮询 + 置顶/锁定/透明度 + 右键菜单；IPC 按实例隔离
const { ipcMain, Menu, BrowserWindow, screen } = require('electron');
const path = require('path');
const { AGENTS, hasPendingDsh } = require('./agents.js');

const DEFAULTS = {
  bgOpacity: 1, pinned: false, locked: false, glass: false,
  platform: 'hermes',
  appearance: { fontColor: '#f1e8d8', accentColor: '#f0a83a', bgColor: '#3e3128' },
};

function setup({ instance, win, save }) {
  const instId = instance.id;

  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  let glass = !!saved.glass;
  let appearance = { ...DEFAULTS.appearance, ...(saved.appearance || {}) };
  let appearanceWin = null;
  let platformWin = null;
  let bgOpacity = (typeof saved.bgOpacity === 'number' && saved.bgOpacity > 0 && saved.bgOpacity <= 1)
    ? saved.bgOpacity : 0.66;
  let platform = AGENTS.find((a) => a.id === saved.platform) || AGENTS[0];
  let pollTimer = null;
  let fetchBusy = false;
  let resumeTimer = null;

  function persist() {
    instance.config = { bgOpacity, pinned, locked, glass, appearance, platform: platform.id };
    save();
  }

  // ---------- 外观（字体色/柱状图色/背景色；柱状图与进度条共用一色） ----------
  function setAppearance(a) {
    if (!a) return;
    appearance = { ...appearance, ...a };
    persist();
    if (win && !win.isDestroyed()) win.webContents.send('monitor:colors:' + instId, appearance);
  }
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const p = {
      x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)),
      y: wa.y + Math.max(0, Math.round((wa.height - 320) / 2)),
    };
    appearanceWin = new BrowserWindow({
      width: 300, height: 320, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }

  function fetchUsage() {
    if (fetchBusy) return;   // 防重入：上一轮解码未完时不叠加新轮
    fetchBusy = true;
    const agent = platform;
    const det = agent.detect();
    const pInfo = { id: agent.id, name: agent.name, short: agent.short, icon: agent.icon, pricing: agent.pricing };
    if (!det.found) {
      fetchBusy = false;
      if (win && !win.isDestroyed()) {
        win.webContents.send('usage:' + instId, { ok: false, error: 'not_found', platform: { ...pInfo, found: false, hint: det.hint } });
      }
      return;
    }
    agent.fetch((data) => {
      fetchBusy = false;
      if (!win || win.isDestroyed()) return;
      const base = { platform: { ...pInfo, found: true, detail: det.detail } };
      if (data && data.ok) {
        win.webContents.send('usage:' + instId, { ...data, ...base });
      } else {
        win.webContents.send('usage:' + instId, { ok: false, error: (data && data.error) || 'fetch_error', hint: (data && data.hint), ...base });
      }
      // 有未解完的会话数据（超时间预算暂停）→ 2 秒后快速续解，不等下一轮 30s 轮询
      if (platform.id === 'dsh' && hasPendingDsh() && !fetchBusy) {
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => { if (win && !win.isDestroyed()) fetchUsage(); }, 2000);
      }
    });
  }

  function selectPlatform(id) {
    const a = AGENTS.find((x) => x.id === id);
    if (!a || a.id === platform.id) return;
    platform = a;
    persist();
    fetchUsage();
    resetPollTimer();
  }

  function resetPollTimer() {
    if (pollTimer) clearInterval(pollTimer);
    // 全部平台均为本地文件/数据库型（读取开销集中，且数据变化不频繁），
    // 统一 30s 轮询减少 IO 与窗口重绘；「立即刷新」可随时手动触发
    pollTimer = setInterval(fetchUsage, 30000);
  }

  function openPlatform() {
    if (platformWin && !platformWin.isDestroyed()) { platformWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const p = { x: wa.x + Math.max(0, Math.round((wa.width - 320) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 480) / 2)) };
    platformWin = new BrowserWindow({
      width: 320, height: 580, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    platformWin.loadFile(path.join(__dirname, 'platform.html'), { query: { inst: instId } });
    platformWin.on('closed', () => { platformWin = null; });
  }

  function togglePin() {
    pinned = !pinned;
    win.setAlwaysOnTop(pinned, 'floating');
    win.webContents.send('pin:' + instId, pinned);
    persist();
  }
  function toggleLock() {
    locked = !locked;
    win.webContents.send('lock:' + instId, locked);
    persist();
  }
  // 毛玻璃效果开关（壁纸模糊层 + 白罩，与文件夹组件同款；背景透明度滑块语义一致）
  function toggleGlass() {
    glass = !glass;
    win.webContents.send('glass:' + instId, glass);
    persist();
  }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
    save();
    win.close();
  }

  // 右键菜单（与标题栏「设置」图标共用）
  function openMenu() {
    if (!win.isFocused()) win.focus();
    try {
      Menu.buildFromTemplate([
        { label: '置顶显示', type: 'checkbox', checked: pinned, click: () => togglePin() },
        { label: '锁定位置', type: 'checkbox', checked: locked, click: () => toggleLock() },
        { type: 'separator' },
        { label: '毛玻璃效果', type: 'checkbox', checked: glass, click: () => toggleGlass() },
        { label: '背景透明度…', click: () => win.webContents.send('show-opacity-panel:' + instId) },
        { label: '外观调节…', click: openAppearance },
        { type: 'separator' },
        { label: '立即刷新', click: fetchUsage },
        { type: 'separator' },
        { label: '退出此组件', click: quitWidget },
      ]).popup({ window: win });
    } catch (_) {}
  }

  // 恢复置顶状态（重启记忆）
  if (pinned) win.setAlwaysOnTop(true, 'floating');

  ipcMain.on('monitor:refresh:' + instId, fetchUsage);
  ipcMain.on('monitor:menu:' + instId, openMenu);
  ipcMain.on('monitor:quit:' + instId, quitWidget);
  ipcMain.on('monitor:appearance:' + instId, (_e, a) => setAppearance(a));
  ipcMain.on('monitor:appearance-open:' + instId, openAppearance);
  ipcMain.on('monitor:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });
  ipcMain.handle('monitor:appearance-init:' + instId, () => appearance);
  ipcMain.on('monitor:platform:' + instId, (_e, id) => selectPlatform(id));
  ipcMain.on('monitor:platform-open:' + instId, openPlatform);
  ipcMain.on('monitor:platform-close:' + instId, () => { if (platformWin && !platformWin.isDestroyed()) platformWin.close(); });
  ipcMain.handle('monitor:platform-list:' + instId, () => ({
    active: platform.id,
    agents: AGENTS.map((a) => ({ id: a.id, name: a.name, short: a.short, icon: a.icon, pricing: a.pricing, detect: a.detect() })),
  }));

  ipcMain.on('save-bg-opacity:' + instId, (_e, v) => {
    bgOpacity = Math.max(0, Math.min(1, v));
    persist();
  });

  win.webContents.on('context-menu', openMenu);

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('pin:' + instId, pinned);
    win.webContents.send('lock:' + instId, locked);
    win.webContents.send('glass:' + instId, glass);
    win.webContents.send('bg-opacity:' + instId, bgOpacity);
    win.webContents.send('monitor:colors:' + instId, appearance);
    win.webContents.send('monitor:platform:' + instId, { id: platform.id, name: platform.name, short: platform.short, icon: platform.icon });
    fetchUsage();
    resetPollTimer();
  });

  win.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (resumeTimer) clearTimeout(resumeTimer);
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
    if (platformWin && !platformWin.isDestroyed()) platformWin.close();
  });
}

module.exports = { setup };
