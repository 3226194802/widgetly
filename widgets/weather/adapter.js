// 天气组件 —— Widgetly 主进程适配层
// 数据源：Open-Meteo 免费接口（无需密钥）；地理编码 + 实况预报
// 每 30 分钟自动刷新；右键菜单可手动刷新 / 切换城市 / 外观 / 透明度 / 置顶 / 锁定 / 退出
const { ipcMain, Menu, BrowserWindow, screen } = require('electron');
const path = require('path');
const https = require('https');

const DEFAULTS = {
  city: '北京', pinned: false, locked: false,
  customized: false,
  bgOpacity: 0.4,
  bgColor: '#1e212a',
  fontColor: '#f2eee6',
};

// 城市预设（切换城市窗口快捷选项）
const PRESETS = ['北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '武汉', '西安', '南京'];

function httpGetJson(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { if (!done) { done = true; req.destroy(); resolve(null); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

// ---------- 拉取天气（异步网络，绝不阻塞主进程） ----------
async function fetchWeather(city) {
  const geo = await httpGetJson(
    'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json'
  );
  const loc = geo && Array.isArray(geo.results) && geo.results[0];
  if (!loc) return { ok: false, msg: '找不到城市「' + city + '」' };
  const lat = loc.latitude, lon = loc.longitude;
  const fc = await httpGetJson(
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1'
  );
  if (!fc || !fc.current || typeof fc.current.temperature_2m !== 'number') {
    return { ok: false, msg: '天气数据不可用' };
  }
  return {
    ok: true,
    city: String(loc.name || city),
    temp: Math.round(fc.current.temperature_2m),
    feels: Math.round(fc.current.apparent_temperature),
    humidity: Math.round(fc.current.relative_humidity_2m),
    wind: Math.round(fc.current.wind_speed_10m),
    code: fc.current.weather_code,
    tmax: Math.round(fc.daily.temperature_2m_max[0]),
    tmin: Math.round(fc.daily.temperature_2m_min[0]),
    updatedAt: Date.now(),
  };
}

function setup({ instance, win, save }) {
  const instId = instance.id;
  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let city = typeof saved.city === 'string' && saved.city ? saved.city : '北京';
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  let customized = !!saved.customized;
  let bgOpacity = (typeof saved.bgOpacity === 'number' && saved.bgOpacity >= 0 && saved.bgOpacity <= 1) ? saved.bgOpacity : DEFAULTS.bgOpacity;
  let bgColor = typeof saved.bgColor === 'string' ? saved.bgColor : '#1e212a';
  let fontColor = typeof saved.fontColor === 'string' ? saved.fontColor : '#f2eee6';
  let settingsWin = null;
  let appearanceWin = null;
  let timer = null;
  let fetching = false;

  function persist() {
    instance.config = { city, pinned, locked, customized, bgOpacity, bgColor, fontColor };
    save();
  }
  function pushStyle() {
    if (win && !win.isDestroyed()) win.webContents.send('weather:style:' + instId, { bgColor, bgOpacity, fontColor, customized });
  }
  function push(d) {
    if (win && !win.isDestroyed()) win.webContents.send('weather:data:' + instId, d);
  }

  // ---------- 刷新（并发防重入；结果直接推给渲染进程） ----------
  async function refresh() {
    if (fetching || !win || win.isDestroyed()) return;
    fetching = true;
    win.webContents.send('weather:loading:' + instId);
    const d = await fetchWeather(city);
    fetching = false;
    push(d);
  }

  function togglePin() { pinned = !pinned; win.setAlwaysOnTop(pinned, 'floating'); persist(); }
  function toggleLock() {
    locked = !locked; persist();
    if (win && !win.isDestroyed()) win.webContents.send('weather:lock:' + instId, locked);
  }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
    save();
    win.close();
  }

  // ---------- 切换城市窗口 ----------
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    settingsWin = new BrowserWindow({
      width: 300, height: 320,
      x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 320) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  // ---------- 外观调节窗口 ----------
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

  // ---------- IPC ----------
  ipcMain.on('weather:refresh:' + instId, refresh);
  ipcMain.on('weather:settings-open:' + instId, openSettings);
  ipcMain.on('weather:settings-close:' + instId, () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
  ipcMain.handle('weather:settings-init:' + instId, () => ({ city, presets: PRESETS }));
  ipcMain.on('weather:settings-save:' + instId, (_e, v) => {
    const c = typeof v === 'string' ? v.trim() : '';
    if (!c) return;
    city = c;
    persist();
    refresh();
  });
  ipcMain.on('weather:appearance-open:' + instId, openAppearance);
  ipcMain.on('weather:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });
  ipcMain.handle('weather:appearance-init:' + instId, () => ({ bgColor, fontColor }));
  ipcMain.on('weather:appearance:' + instId, (_e, c) => {
    if (!c) return;
    if (typeof c.bgColor === 'string') { bgColor = c.bgColor; customized = true; }
    if (typeof c.fontColor === 'string') { fontColor = c.fontColor; customized = true; }
    persist();
    pushStyle();
  });
  ipcMain.on('weather:bg-opacity:' + instId, (_e, v) => {
    if (typeof v === 'number') {
      bgOpacity = Math.max(0, Math.min(1, v));
      customized = true;
      persist();
      pushStyle();
    }
  });
  ipcMain.on('weather:quit:' + instId, quitWidget);

  // ---------- 右键菜单 ----------
  function openMenu() {
    if (!win.isFocused()) win.focus();
    try {
      Menu.buildFromTemplate([
        { label: '立即刷新', click: refresh },
        { label: '切换城市…', click: openSettings },
        { type: 'separator' },
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

  // ---------- 轮询（30 分钟自动刷新） ----------
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('weather:lock:' + instId, locked);
    pushStyle();
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, 30 * 60 * 1000);
  });
  win.on('closed', () => {
    if (timer) clearInterval(timer);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
  });

  if (pinned) win.setAlwaysOnTop(true, 'floating');
}

module.exports = { setup };
