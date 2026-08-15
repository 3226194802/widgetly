// 系统监测组件 —— Widgetly 主进程适配层
// 3 个指标槽位可在设置中替换（CPU/内存/GPU/各磁盘/下载/上传/电池/运行时长）
// 快速指标在主进程直算（零开销）；慢指标（GPU/网络/电池）用异步 PowerShell，绝不阻塞主进程
const { ipcMain, Menu, BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULTS = {
  slots: ['cpu', 'ram', 'gpu'], pinned: false, locked: false,
  bgOpacity: 1, bgColor: '#181a20', fontColor: '#f2eee6', barColor: null,
};

const BASE_METRICS = [
  { id: 'cpu', name: 'CPU', icon: '⚙', fast: true, color: '#5b9dff' },
  { id: 'ram', name: '内存', icon: '🧠', fast: true, color: '#ffd24a' },
  { id: 'gpu', name: 'GPU', icon: '🎮', fast: false, color: '#41cfc4' },
  { id: 'battery', name: '电池', icon: '🔋', fast: false, color: '#ffd24a' },
  { id: 'netdown', name: '下载', icon: '⬇', fast: false, color: '#41cf7f' },
  { id: 'netup', name: '上传', icon: '⬆', fast: false, color: '#ff9a5c' },
  { id: 'uptime', name: '运行时长', icon: '⏱', fast: true, color: '#9ec3d9' },
];

// 磁盘指标动态枚举（每个存在的盘一个选项）
function diskMetrics() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    try {
      const s = fs.statfsSync(letter + ':\\');
      if (Number(s.blocks) * Number(s.bsize) > 0) {
        out.push({ id: 'disk-' + letter.toLowerCase(), name: letter + ' 盘', icon: '💽', fast: true, color: '#a07fff', letter });
      }
    } catch (_) {}
  }
  out.sort((a, b) => (a.letter === 'C' ? -1 : b.letter === 'C' ? 1 : a.letter.localeCompare(b.letter)));
  return out;
}

let lastCpu = null;
function cpuUsage() {
  const cpus = os.cpus();
  let total = 0, idle = 0;
  for (const c of cpus) {
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    idle += c.times.idle;
  }
  if (!lastCpu) { lastCpu = { total, idle }; return 0; }
  const dT = total - lastCpu.total, dI = idle - lastCpu.idle;
  lastCpu = { total, idle };
  return dT > 0 ? Math.round((1 - dI / dT) * 100) : 0;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + '天' + h + '时';
  if (h > 0) return h + '时' + m + '分';
  return m + '分';
}
function fmtSpeed(bps) {
  if (bps < 0) return '—';
  if (bps < 1024) return bps + 'B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(0) + 'K/s';
  return (bps / 1048576).toFixed(1) + 'M/s';
}

function setup({ instance, win, save }) {
  const instId = instance.id;
  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  // 大号 sysmonL：6 槽位（2 行 × 3 列）；标准 sysmon：3 槽位
  const isLarge = instance.widgetId === 'sysmonL';
  const slotCount = isLarge ? 6 : 3;
  const DEF_SLOTS = isLarge
    ? ['cpu', 'ram', 'gpu', 'battery', 'netdown', 'netup']
    : ['cpu', 'ram', 'gpu'];
  let slots = (Array.isArray(saved.slots) && saved.slots.length >= slotCount) ? saved.slots.slice(0, slotCount) : [...DEF_SLOTS];
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  let bgOpacity = (typeof saved.bgOpacity === 'number' && saved.bgOpacity >= 0 && saved.bgOpacity <= 1) ? saved.bgOpacity : 1;
  let bgColor = typeof saved.bgColor === 'string' ? saved.bgColor : '#181a20';
  let fontColor = typeof saved.fontColor === 'string' ? saved.fontColor : '#f2eee6';
  let barColor = (typeof saved.barColor === 'string' && saved.barColor) ? saved.barColor : null;
  let settingsWin = null;
  let appearanceWin = null;
  let timer = null;
  const slowCache = { gpu: -1, down: -1, up: -1, battery: -1 };
  let slowBusy = false;
  let lastSlowPoll = 0;

  const METRICS = [...BASE_METRICS, ...diskMetrics()];
  function metricById(id) { return METRICS.find((m) => m.id === id) || null; }
  function needSlow() { return slots.some((id) => { const m = metricById(id); return m && !m.fast; }); }

  function persist() {
    instance.config = { slots, pinned, locked, bgOpacity, bgColor, fontColor, barColor };
    save();
  }
  function pushStyle() {
    if (win && !win.isDestroyed()) win.webContents.send('sysmon:style:' + instId, { bgColor, bgOpacity, fontColor, barColor });
  }

  // ---------- 慢指标：一次异步 PowerShell 拿 GPU/网络/电池（内部采样 1 秒，不阻塞主进程） ----------
  function pollSlow() {
    if (slowBusy) return;
    slowBusy = true;
    const ps = `
$o = @{ gpu = -1; down = -1; up = -1; battery = -1 }
try { $c = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue; if ($c) { $o.gpu = [math]::Round(($c.CounterSamples | Measure-Object CookedValue -Maximum).Maximum) } } catch {}
try {
  $a1 = Get-NetAdapterStatistics -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
  $a2 = Get-NetAdapterStatistics -ErrorAction SilentlyContinue
  if ($a1 -and $a2) {
    $o.down = (($a2 | Measure-Object ReceivedBytes -Sum).Sum - ($a1 | Measure-Object ReceivedBytes -Sum).Sum)
    $o.up = (($a2 | Measure-Object SentBytes -Sum).Sum - ($a1 | Measure-Object SentBytes -Sum).Sum)
  }
} catch {}
try { $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { $o.battery = [math]::Round($b.EstimatedChargeRemaining) } } catch {}
$o | ConvertTo-Json -Compress`;
    const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      slowBusy = false;
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        if (j && typeof j === 'object') Object.assign(slowCache, j);
      } catch (_) {}
    });
    child.on('error', () => { slowBusy = false; });
  }

  // ---------- 采集单个指标 ----------
  function collectValue(id) {
    const m = metricById(id);
    if (!m) return { name: '—', icon: '❔', color: '#888', pct: -1, text: '—' };
    if (id === 'cpu') return { name: m.name, icon: m.icon, color: m.color, pct: cpuUsage(), text: '' };
    if (id === 'ram') return { name: m.name, icon: m.icon, color: m.color, pct: Math.round((1 - os.freemem() / os.totalmem()) * 100), text: '' };
    if (id === 'uptime') return { name: m.name, icon: m.icon, color: m.color, pct: -1, text: fmtUptime(os.uptime()) };
    if (id.startsWith('disk-')) {
      const letter = id.slice(5).toUpperCase();
      try {
        const s = fs.statfsSync(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
        return { name: m.name, icon: m.icon, color: m.color, pct: total > 0 ? Math.round((1 - free / total) * 100) : 0, text: '' };
      } catch (_) { return { name: m.name, icon: m.icon, color: m.color, pct: -1, text: '—' }; }
    }
    if (id === 'gpu') return { name: m.name, icon: m.icon, color: m.color, pct: slowCache.gpu >= 0 ? slowCache.gpu : -1, text: slowCache.gpu >= 0 ? '' : '—' };
    if (id === 'netdown') return { name: m.name, icon: m.icon, color: m.color, pct: -1, text: fmtSpeed(slowCache.down) };
    if (id === 'netup') return { name: m.name, icon: m.icon, color: m.color, pct: -1, text: fmtSpeed(slowCache.up) };
    if (id === 'battery') return { name: m.name, icon: m.icon, color: m.color, pct: slowCache.battery >= 0 ? slowCache.battery : -1, text: slowCache.battery >= 0 ? '' : '—' };
    return { name: m.name, icon: m.icon, color: m.color, pct: -1, text: '—' };
  }

  function push() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('sysmon:data:' + instId, slots.map((id) => collectValue(id)));
  }

  // ---------- 设置窗口 ----------
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const H = isLarge ? 460 : 330;
    settingsWin = new BrowserWindow({
      width: 300, height: H,
      x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - H) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  function togglePin() { pinned = !pinned; win.setAlwaysOnTop(pinned, 'floating'); persist(); }
  function toggleLock() { locked = !locked; persist(); if (win && !win.isDestroyed()) win.webContents.send('lock:' + instId, locked); }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
    save();
    win.close();
  }

  // ---------- 外观调节窗口（背景颜色 / 字体颜色 / 进度条颜色） ----------
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    appearanceWin = new BrowserWindow({
      width: 300, height: 340,
      x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 340) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }

  // ---------- IPC ----------
  ipcMain.on('sysmon:settings-open:' + instId, openSettings);
  ipcMain.on('sysmon:settings-close:' + instId, () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
  ipcMain.handle('sysmon:settings-init:' + instId, () => ({ slots, slotCount, metrics: METRICS.map((m) => ({ id: m.id, name: m.name, icon: m.icon })) }));
  ipcMain.on('sysmon:settings-save:' + instId, (_e, s) => {
    if (Array.isArray(s) && s.length === slotCount) { slots = s.slice(0, slotCount); persist(); push(); }
  });
  ipcMain.on('sysmon:appearance-open:' + instId, openAppearance);
  ipcMain.on('sysmon:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });
  ipcMain.handle('sysmon:appearance-init:' + instId, () => ({ bgColor, fontColor, barColor }));
  ipcMain.on('sysmon:appearance:' + instId, (_e, c) => {
    if (!c) return;
    if (typeof c.bgColor === 'string') bgColor = c.bgColor;
    if (typeof c.fontColor === 'string') fontColor = c.fontColor;
    if (c.barColor === null || typeof c.barColor === 'string') barColor = c.barColor;
    persist();
    pushStyle();
  });
  ipcMain.on('save-bg-opacity:' + instId, (_e, v) => {
    bgOpacity = Math.max(0, Math.min(1, typeof v === 'number' ? v : 0.35));
    persist();
    pushStyle();
  });
  ipcMain.on('sysmon:quit:' + instId, quitWidget);

  // ---------- 右键菜单 ----------
  function openMenu() {
    if (!win.isFocused()) win.focus();
    try {
      Menu.buildFromTemplate([
        { label: '选择对象…', click: openSettings },
        { label: '外观调节…', click: openAppearance },
        { label: '背景透明度…', click: () => win.webContents.send('show-opacity-panel:' + instId) },
        { type: 'separator' },
        { label: '置顶显示', type: 'checkbox', checked: pinned, click: togglePin },
        { label: '锁定位置', type: 'checkbox', checked: locked, click: toggleLock },
        { type: 'separator' },
        { label: '退出此组件', click: quitWidget },
      ]).popup({ window: win });
    } catch (_) {}
  }
  win.webContents.on('context-menu', openMenu);

  // ---------- 轮询 ----------
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('lock:' + instId, locked);
    pushStyle();
    push();
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      push();
      // 慢指标每 6 秒轮询一次（PowerShell 启动开销较大，不必每次）
      if (needSlow() && Date.now() - lastSlowPoll > 6000) { lastSlowPoll = Date.now(); pollSlow(); }
    }, 2500);
  });
  win.on('closed', () => {
    if (timer) clearInterval(timer);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
  });

  if (pinned) win.setAlwaysOnTop(true, 'floating');
}

module.exports = { setup };
