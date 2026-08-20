// DeepSeek Harness 一键启动器 —— Widgetly 主进程适配层
// 启动/停止后台服务 + 浏览器打开本地网址 + 尺寸切换 + 设置（路径/端口/浏览器/API key）+ 浮动菜单
const { ipcMain, screen, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  dshPath: '', port: 3080, browser: 'default', apiKey: '', size: 'medium', veilOpacity: 60, theme: 'light', locked: false,
};
const SIZES = {
  small: { w: 65, h: 70, label: '小号' },
  medium: { w: 140, h: 148, label: '中号' },
  large: { w: 285, h: 285, label: '大号' },
};
const BROWSER_PATHS = {
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ instance, win, save }) {
  const instId = instance.id;
  const cfg = { ...DEFAULTS, ...(instance.config || {}) };
  let state = 'idle';     // idle | starting | running | failed
  let childPid = null;
  let menuWin = null, menuGen = 0, settingsWin = null, failedWin = null;

  function persist() {
    instance.config = { ...cfg };
    save();
  }
  function setState(s) {
    state = s;
    if (win && !win.isDestroyed()) win.webContents.send('launcher:status:' + instId, { state, port: cfg.port });
  }
  function portOpen(port) {
    return new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      const done = (v) => { s.destroy(); resolve(v); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      setTimeout(() => done(false), 1500);
    });
  }
  function dshBinPath() {
    return path.join(cfg.dshPath, 'apps', 'cli', 'src', 'bin.ts');
  }
  function openBrowser() {
    const url = `http://127.0.0.1:${cfg.port}`;
    try {
      if (cfg.browser && BROWSER_PATHS[cfg.browser]) {
        const exe = BROWSER_PATHS[cfg.browser].find((p) => fs.existsSync(p));
        if (exe) { spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref(); return; }
      }
      shell.openExternal(url);
    } catch (_) { shell.openExternal(url); }
  }
  function showFailed(reasons) {
    if (failedWin && !failedWin.isDestroyed()) failedWin.close();
    const wa = screen.getPrimaryDisplay().workArea;
    failedWin = new BrowserWindow({
      width: 360, height: 300,
      x: wa.x + Math.max(0, Math.round((wa.width - 360) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 300) / 2)),
      frame: false, transparent: true, resizable: false, skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    failedWin.loadFile(path.join(__dirname, 'failed.html'), { query: { inst: instId } });
    failedWin.webContents.on('did-finish-load', () => {
      failedWin.webContents.send('launcher:failed:' + instId, reasons);
    });
    failedWin.on('closed', () => { failedWin = null; });
  }

  // ---------- 启动 ----------
  async function start() {
    if (state === 'starting' || state === 'running') return;
    if (!cfg.dshPath || !fs.existsSync(dshBinPath())) {
      setState('failed');
      showFailed(['DSH 安装路径未设置或无效。', '请在右键菜单 → 设置 中填写正确的安装路径。', '提示：该路径下应能找到 apps/cli/src/bin.ts 文件。']);
      return;
    }
    if (await portOpen(cfg.port)) { setState('running'); openBrowser(); return; }
    setState('starting');
    const child = spawn('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'], {
      cwd: cfg.dshPath, detached: true, stdio: 'ignore', windowsHide: true,
    });
    childPid = child.pid;
    let errMsg = null;
    child.on('error', (e) => { errMsg = e.message; });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (await portOpen(cfg.port)) { setState('running'); openBrowser(); return; }
    }
    setState('failed');
    showFailed([
      '启动失败，可能的原因：',
      '1. Node.js 未安装或版本过低（需 ≥ 22）。',
      '2. DSH 依赖未安装：请在该路径下执行 npm install。',
      errMsg ? ('3. ' + errMsg) : '3. 服务未在 30 秒内就绪（端口 ' + cfg.port + '）。',
      '4. 端口 ' + cfg.port + ' 可能被其他程序占用。',
    ]);
  }
  // ---------- 停止 ----------
  function stop() {
    if (childPid) { try { process.kill(childPid); } catch (_) {} childPid = null; }
    // 兜底：杀掉监听端口的进程（异步执行，绝不用 spawnSync 阻塞主进程——曾导致点击停止后界面卡死）
    try {
      spawn('powershell', ['-NoProfile', '-Command', `$c=Get-NetTCPConnection -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1; if($c){taskkill /F /PID $c.OwningProcess 2>&1 | Out-Null}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (_) {}
    setState('idle');
  }

  // ---------- 尺寸（先通知 renderer 切 CSS，再延时改窗口尺寸，避免中间态溢出/卡顿） ----------
  let sizeTimer = null;
  function applySize() {
    win.webContents.send('launcher:size:' + instId, cfg.size);
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const s = SIZES[cfg.size] || SIZES.medium;
      const [x, y] = win.getPosition();
      win.setBounds({ x, y, width: s.w, height: s.h });
      win.setContentSize(s.w, s.h);   // 强制内容区尺寸，同步渲染视口（透明窗口 setBounds 视口不更新）
      try { win.webContents.invalidate(); } catch (_) {}
    }, 120);
  }
  function setSize(s) {
    if (!SIZES[s] || s === cfg.size) return;
    cfg.size = s;
    persist();
    applySize();
  }
  function setTheme(t) {
    if (t !== 'light' && t !== 'dark') return;
    cfg.theme = t;
    persist();
    if (win && !win.isDestroyed()) win.webContents.send('launcher:theme:' + instId, t);
  }

  // ---------- 浮动菜单 ----------
  function closeMenu() { if (menuWin && !menuWin.isDestroyed()) menuWin.close(); menuWin = null; }
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
      mwin.webContents.send('launcher:menu-items:' + instId, { gen, items });
    });
    mwin.loadFile(path.join(__dirname, 'menu.html'), { query: { inst: instId } });
  }
  ipcMain.on('launcher:menu:' + instId, (_e, st) => {
    const items = [];
    if (st && st.state === 'running') items.push({ label: '停止服务', action: 'stop' });
    else if (st && st.state === 'starting') items.push({ label: '正在启动…', action: 'none' });
    else items.push({ label: '一键启动', action: 'start' });
    items.push({ kind: 'sep' });
    items.push({ kind: 'head', label: '组件尺寸' });
    Object.keys(SIZES).forEach((s) => {
      items.push({ label: SIZES[s].label + (cfg.size === s ? '（当前）' : ''), action: 'size', payload: s });
    });
    items.push({ kind: 'sep' });
    items.push({ kind: 'head', label: '外观主题' });
    items.push({ label: '玻璃拟态' + (cfg.theme === 'light' ? '（当前）' : ''), action: 'theme', payload: 'light' });
    items.push({ label: '深色极光' + (cfg.theme === 'dark' ? '（当前）' : ''), action: 'theme', payload: 'dark' });
    items.push({ kind: 'sep' });
    items.push({ label: '设置…', action: 'settings' });
    items.push({ kind: 'slider', label: '背景透明度', value: (st && typeof st.veil === 'number') ? st.veil : 0, action: 'veil' });
    items.push({ kind: 'sep' });
    items.push({ label: '锁定位置' + (cfg.locked ? '（已锁定）' : ''), action: 'lock' });
    items.push({ kind: 'sep' });
    items.push({ label: '退出此组件', action: 'quit', danger: true });
    openMenu(items);
  });
  ipcMain.on('launcher:menu-ready:' + instId, (_e, { gen, w, h }) => {
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
  ipcMain.on('launcher:menu-click:' + instId, (_e, cmd) => {
    closeMenu();
    if (!cmd || !cmd.action) return;
    if (cmd.action === 'start') start();
    else if (cmd.action === 'stop') stop();
    else if (cmd.action === 'size') setSize(cmd.payload);
    else if (cmd.action === 'theme') setTheme(cmd.payload);
    else if (cmd.action === 'settings') openSettings();
    else if (cmd.action === 'lock') { cfg.locked = !cfg.locked; persist(); }
    else if (cmd.action === 'quit') { global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId); save(); win.close(); }
  });
  ipcMain.on('launcher:menu-slide:' + instId, (_e, data) => {
    if (!data || data.gen !== menuGen) return;
    if (win && !win.isDestroyed()) win.webContents.send('launcher:veil:' + instId, { v: data.v, save: !!data.done });
  });
  ipcMain.on('launcher:menu-close:' + instId, closeMenu);

  // ---------- 设置窗口 ----------
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    settingsWin = new BrowserWindow({
      width: 400, height: 420,
      x: wa.x + Math.max(0, Math.round((wa.width - 400) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 420) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }
  ipcMain.handle('launcher:settings-init:' + instId, () => ({
    dshPath: cfg.dshPath, port: cfg.port, browser: cfg.browser, apiKey: cfg.apiKey,
  }));
  ipcMain.on('launcher:settings-save:' + instId, (_e, v) => {
    if (v && typeof v === 'object') {
      if (v.dshPath !== undefined) cfg.dshPath = String(v.dshPath || '').trim();
      if (v.port !== undefined) cfg.port = Math.max(1, Math.min(65535, parseInt(v.port, 10) || 3080));
      if (v.browser !== undefined) cfg.browser = ['default', 'edge', 'chrome'].includes(v.browser) ? v.browser : 'default';
      if (v.apiKey !== undefined) cfg.apiKey = String(v.apiKey || '');
    }
    persist();
  });
  ipcMain.on('launcher:settings-close:' + instId, () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

  // ---------- 按钮点击（renderer） ----------
  ipcMain.on('launcher:action:' + instId, (_e, act) => {
    if (act === 'start') start();
    else if (act === 'stop') stop();
  });
  ipcMain.handle('launcher:init:' + instId, async () => ({
    state: await portOpen(cfg.port) ? 'running' : state,
    size: cfg.size,
    veil: cfg.veilOpacity,
    port: cfg.port,
    dshPath: cfg.dshPath,
    theme: cfg.theme,
  }));

  // ---------- 初始化 ----------
  win.webContents.on('did-finish-load', () => {
    applySize();
    win.webContents.send('launcher:size:' + instId, cfg.size);
    win.webContents.send('launcher:theme:' + instId, cfg.theme);
    win.webContents.send('launcher:veil:' + instId, { v: cfg.veilOpacity, save: false });
    (async () => {
      setState(await portOpen(cfg.port) ? 'running' : 'idle');
    })();
  });
}

module.exports = { setup, SIZES };
