// Widgetly 组件坞 —— 主进程
// 单进程管理：管理器窗口 + 组件窗口（多实例）+ 系统托盘 + 共享引擎（壁纸/拖动/配置）
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 组件专属适配层（主进程侧）：dock 图标提取/items 管理、monitor 数据轮询、gallery 图库
const dockAdapter = require('./widgets/dock/adapter.js');
const monitorAdapter = require('./widgets/monitor/adapter.js');
const galleryAdapter = require('./widgets/gallery/adapter.js');
const todoAdapter = require('./widgets/todo/adapter.js');
const clockAdapter = require('./widgets/clock/adapter.js');
const calendarAdapter = require('./widgets/calendar/adapter.js');
const launcherAdapter = require('./widgets/launcher/adapter.js');
const pomodoroAdapter = require('./widgets/pomodoro/adapter.js');
const memoryAdapter = require('./widgets/memory/adapter.js');
const sysmonAdapter = require('./widgets/sysmon/adapter.js');
const clock2Adapter = require('./widgets/clock2/adapter.js');
const weatherAdapter = require('./widgets/weather/adapter.js');

const APP_DIR = __dirname;
const USER_DATA = app.getPath('userData');                 // 可写目录（%APPDATA%\Widgetly）
const CONFIG_FILE = path.join(USER_DATA, 'config.json');   // 主配置（打包后可写）
const LEGACY_CONFIG = path.join(APP_DIR, 'config.json');   // 旧位置（开发期，首次启动自动迁移）
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.png');   // 应用图标（窗口/托盘/打包共用）

app.disableHardwareAcceleration();

// ============ 单实例锁 ============
// 防止双击任务栏/再次启动导致第二实例读取同一配置、在相同位置重复创建组件（用户反馈"组件重叠"）。
// 第二个实例启动时，直接聚焦已存在的管理器窗口。
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户关闭「启动时打开组件坞」时：再次启动只保持托盘驻留，不弹主界面
    if (global.__cfg && global.__cfg.openManagerOnStart === false) {
      try { if (tray) tray.displayBalloon({ title: 'Widgetly 组件坞', content: '已在后台运行，点击托盘图标打开组件坞' }); } catch (_) {}
      return;
    }
    if (managerWin && !managerWin.isDestroyed()) {
      if (managerWin.isMinimized()) managerWin.restore();
      managerWin.show();
      managerWin.focus();
    } else {
      createManagerWindow();
    }
  });
}

// ============ 组件注册表 ============
// 新组件 = 在 widgets/ 下加一个目录 + 在这里登记；dir 字段用于多尺寸共用同一实现目录
// 注册顺序 = 主页排列顺序：按高度分组（行内高度相近、减少空余），超大组件（342×500/551）放到最后
const WIDGETS = {
  // —— 中长条 280×148（两整行）——
  clock: { id: 'clock', name: '灵动时钟', icon: '⏰', w: 280, h: 148, entry: 'index.html', category: 'clock' },
  clockM: { id: 'clockM', name: '灵动时钟·中', icon: '⏰', w: 280, h: 148, entry: 'index.html', dir: 'clock', category: 'clock' },
  clock2: { id: 'clock2', name: '数字时钟', icon: '🕒', w: 280, h: 148, entry: 'index.html', category: 'clock' },
  clock2Sec: { id: 'clock2Sec', name: '数字时钟·带秒', icon: '⏱️', w: 280, h: 148, entry: 'index.html', dir: 'clock2', category: 'clock' },
  weather: { id: 'weather', name: '天气·今日', icon: '🌤️', w: 280, h: 148, entry: 'index.html', category: 'tool' },
  dock: { id: 'dock', name: '弹力文件夹', icon: '🗂️', w: 280, h: 148, entry: 'index.html', category: 'tool' },
  galleryM: { id: 'galleryM', name: '图库·中', icon: '🖼️', w: 280, h: 148, entry: 'index.html', dir: 'gallery', category: 'tool' },
  calendarBar: { id: 'calendarBar', name: '日历·今日脉搏', icon: '📅', w: 280, h: 148, entry: 'bar.html', dir: 'calendar', category: 'calendar' },
  pomodoroBar: { id: 'pomodoroBar', name: '番茄时钟·中长条', icon: '🍅', w: 280, h: 148, entry: 'bar.html', dir: 'pomodoro', category: 'productivity' },
  // —— 280×180 ——
  todo: { id: 'todo', name: '今日待办', icon: '✅', w: 280, h: 180, entry: 'index.html', category: 'productivity' },
  memory: { id: 'memory', name: '内存监控', icon: '📈', w: 280, h: 180, entry: 'index.html', category: 'tool' },
  sysmon: { id: 'sysmon', name: '系统监测', icon: '🖥️', w: 280, h: 148, entry: 'index.html', category: 'tool' },
  // —— 小号 140 宽 ——
  clockS: { id: 'clockS', name: '灵动时钟·小', icon: '⏰', w: 140, h: 74, entry: 'index.html', dir: 'clock', category: 'clock' },
  calendarMini: { id: 'calendarMini', name: '日历·胶囊日期', icon: '💊', w: 140, h: 74, entry: 'mini.html', dir: 'calendar', category: 'calendar' },
  galleryS: { id: 'galleryS', name: '图库·小', icon: '🖼️', w: 140, h: 140, entry: 'index.html', dir: 'gallery', category: 'tool' },
  calendarMint: { id: 'calendarMint', name: '日历·青柠', icon: '🍋', w: 140, h: 148, entry: 'mint.html', dir: 'calendar', category: 'calendar' },
  clock2S: { id: 'clock2S', name: '数字时钟·方', icon: '🕰️', w: 140, h: 148, entry: 'index.html', dir: 'clock2', category: 'clock' },
  weatherS: { id: 'weatherS', name: '天气·方', icon: '☀️', w: 140, h: 148, entry: 'index.html', dir: 'weather', category: 'tool' },
  launcher: { id: 'launcher', name: 'DSH 启动器', icon: '🚀', w: 140, h: 148, entry: 'index.html', category: 'tool' },
  // —— 大正方形 280-285 ——
  galleryL: { id: 'galleryL', name: '图库·大', icon: '🖼️', w: 280, h: 280, entry: 'index.html', dir: 'gallery', category: 'tool' },
  calendarSquare: { id: 'calendarSquare', name: '日历·月相月历', icon: '🌙', w: 270, h: 280, entry: 'square.html', dir: 'calendar', category: 'calendar' },
  calendarRing: { id: 'calendarRing', name: '日历·周环', icon: '💫', w: 270, h: 280, entry: 'ring.html', dir: 'calendar', category: 'calendar' },
  calendarBig: { id: 'calendarBig', name: '日历·墨滴月历', icon: '🖌️', w: 285, h: 285, entry: 'big.html', dir: 'calendar', category: 'calendar' },
  pomodoro: { id: 'pomodoro', name: '番茄时钟', icon: '🍅', w: 285, h: 285, entry: 'index.html', category: 'productivity' },
  sysmonL: { id: 'sysmonL', name: '系统监测·大', icon: '🖥️', w: 285, h: 285, entry: 'index.html', dir: 'sysmon', category: 'tool' },
  // —— 超大（放最后）——
  calendarXL: { id: 'calendarXL', name: '日历·全景', icon: '🗓️', w: 342, h: 500, entry: 'xl.html', dir: 'calendar', category: 'calendar' },
  monitor: { id: 'monitor', name: 'AI 用量监控', icon: '📊', w: 342, h: 551, entry: 'index.html', category: 'tool' },
};
// 左侧导航分类（全部 / 时钟 / 日历 / 效率工具 / 工具）—— icon 为内联 SVG 字符串
const CATEGORIES = [
  { id: 'all', name: '全部', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>' },
  { id: 'clock', name: '时钟', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>' },
  { id: 'calendar', name: '日历', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>' },
  { id: 'productivity', name: '效率工具', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z"/></svg>' },
  { id: 'tool', name: '工具', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 12l-2-2z"/></svg>' },
];
// 组件默认配置：实例配置为空时合并（修复"数字非常小"——cfg.width undefined 导致字号 NaN）
const WIDGET_DEFAULTS = {
  // 新建组件的背景透明度统一为 60%（即背景罩层不透明度为 40%）。已有组件仍保留用户已选的值。
  clock: { width: 284, theme: 'auto', subtitle: 'iScreen', hour12: false, showSubtitle: true, veilOpacity: 60, gradientOrder: 'abab', glass: true },
  clockS: { width: 284, theme: 'auto', subtitle: 'iScreen', hour12: false, showSubtitle: true, veilOpacity: 60, gradientOrder: 'abab', glass: true },
  clockM: { width: 284, theme: 'auto', subtitle: 'iScreen', hour12: false, showSubtitle: true, veilOpacity: 60, gradientOrder: 'abab', glass: true },
  dock: { bgOpacity: 0.4, layout: '4x2', pinned: false, locked: false, items: [] },
  monitor: { bgOpacity: 0.4, pinned: false, locked: false },
  galleryS: { folder: null, duration: 5, order: 'random' },
  galleryM: { folder: null, duration: 5, order: 'random' },
  galleryL: { folder: null, duration: 5, order: 'random' },
  todo: { todos: {}, appearance: { bg: 'white', bgOpacity: 40, fontColor: '#1e2832', fontSize: 12 } },
  calendarMini: { veilOpacity: 60, bgColor: '#ff8a5a', textColor: '#ffffff', accentColor: '#ffd9a0' },
  calendarBar: { veilOpacity: 60, bgColor: '#16305c', textColor: '#ffffff', accentColor: '#57b7ff' },
  calendarSquare: { veilOpacity: 60, bgColor: '#f7f1e3', textColor: '#4a3728', accentColor: '#d95a3a' },
  calendarRing: { veilOpacity: 60, bgColor: '#e5ddf4', textColor: '#3d3560', accentColor: '#8f7bd8' },
  calendarMint: { veilOpacity: 60, bgColor: '#d7efe2', textColor: '#20543f', accentColor: '#4cb882' },
  calendarBig: { veilOpacity: 60, bgColor: '#f5f1e8', textColor: '#2b2b2b', accentColor: '#c83e2a' },
  calendarXL: { veilOpacity: 60, bgColor: '#141a33', textColor: '#f2ede4', accentColor: '#9ec3d9' },
  launcher: { veilOpacity: 60, dshPath: '', port: 3080, browser: 'default', apiKey: '', size: 'medium' },
  pomodoro: {
    tasks: [],
    settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4, autoNext: false, sound: true },
    pinned: false, locked: false, bgOpacity: 0.4,
    state: { phase: 'idle', running: false, endAt: 0, round: 0, taskId: null, remainMs: 0 },
    today: { key: '', count: 0 },
  },
  pomodoroBar: {
    tasks: [],
    settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4, autoNext: false, sound: true },
    pinned: false, locked: false, bgOpacity: 0.4,
    state: { phase: 'idle', running: false, endAt: 0, round: 0, taskId: null, remainMs: 0 },
    today: { key: '', count: 0 },
  },
  memory: {
    appearance: { curveColor: '#ffd24a', barColor: '#a07fff', fontColor: '#f2eee6', bgMode: 'frosted', bgColor: '#191722' },
    pinned: false, locked: false,
  },
  sysmon: { slots: ['cpu', 'ram', 'gpu'], pinned: false, locked: false, bgOpacity: 0.4, bgColor: '#181a20', fontColor: '#f2eee6', barColor: null },
  sysmonL: { slots: ['cpu', 'ram', 'gpu', 'battery', 'netdown', 'netup'], pinned: false, locked: false, bgOpacity: 0.4, bgColor: '#181a20', fontColor: '#f2eee6', barColor: null },
  clock2: { hour12: false, theme: 'auto', showSeconds: false, locked: false, customized: false, bgOpacity: 0.4, bgColor: '#1e212a', fontColor: '#f2eee6' },
  clock2S: { hour12: false, theme: 'auto', showSeconds: false, locked: false, customized: false, bgOpacity: 0.4, bgColor: '#1e212a', fontColor: '#f2eee6' },
  clock2Sec: { hour12: false, theme: 'auto', showSeconds: true, locked: false, customized: false, bgOpacity: 0.4, bgColor: '#1e212a', fontColor: '#f2eee6' },
  weather: { city: '北京', pinned: false, locked: false, customized: false, bgOpacity: 0.4, bgColor: '#1e212a', fontColor: '#f2eee6' },
  weatherS: { city: '北京', pinned: false, locked: false, customized: false, bgOpacity: 0.4, bgColor: '#1e212a', fontColor: '#f2eee6' },
};

// ============ 配置 ============
function defaultConfig() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    theme: 'dark',
    autostart: true,
    autostartMethod: 'registry',   // 开机自启方式：registry(最快) | startup(启动文件夹) | scheduler(计划任务)
    openManagerOnStart: true,  // 启动时是否自动打开组件坞（关闭则仅驻留托盘）
    closeToTray: true,         // 关闭组件坞时隐藏到托盘（关闭后仍可从托盘打开）
    managerOpacity: 0.5,    // 管理器透明度（右上角滑块调节，0=不透明，1=全透明）
    pinToDesktop: false,    // 固定组件层级：开启后组件挂桌面层，免疫 Win+D/三指下滑（代价：无法拖动/右键）
    instances: [
      { id: 'clock-1', widgetId: 'clock', x: workArea.x + workArea.width - 420, y: workArea.y + 60, config: {} },
    ],
  };
}
function loadConfig() {
  let c = null;
  // 主位置：userData 目录（打包后 app.asar 只读，配置必须放可写目录）
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  // 旧位置迁移：开发目录里的旧 config.json 首次启动自动搬过来
  if (!c) {
    try {
      if (fs.existsSync(LEGACY_CONFIG)) {
        c = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
        fs.mkdirSync(USER_DATA, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
      }
    } catch (_) {}
  }
  return { ...defaultConfig(), ...(c || {}) };
}
function saveConfig() {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(global.__cfg, null, 2));
  } catch (_) {}
}
// 开机自启：支持三种方式（按启动速度从快到慢）
//   registry  = 注册表 HKCU Run 键（最快，登录后立即由系统启动）
//   startup   = 启动文件夹快捷方式（标准，Explorer 加载启动项时启动）
//   scheduler = 计划任务（登录时触发）
function startupFolder() {
  return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function removeStartupShortcut() {
  try { const lnk = path.join(startupFolder(), 'Widgetly.lnk'); if (fs.existsSync(lnk)) fs.unlinkSync(lnk); } catch (_) {}
}
function createStartupShortcut(exe, dir) {
  try {
    const lnk = path.join(startupFolder(), 'Widgetly.lnk');
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = `$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut('${q(lnk)}');$sc.TargetPath='${q(exe)}';$sc.Arguments='${q(dir)}';$sc.WorkingDirectory='${q(dir)}';$sc.Save()`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (_) {}
}
function removeScheduledTask() {
  try { spawn('schtasks', ['/Delete', '/TN', 'Widgetly', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {}
}
function createScheduledTask(exe, dir) {
  try { spawn('schtasks', ['/Create', '/TN', 'Widgetly', '/TR', `"${exe}" "${dir}"`, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {}
}
function applyAutostart() {
  try {
    const method = global.__cfg.autostartMethod || 'registry';
    const exe = process.execPath, dir = APP_DIR;
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const run = (cmd, args) => { try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {} };
    if (!global.__cfg.autostart) {
      // 关闭：清除所有方式
      run('reg', ['delete', runKey, '/v', 'Widgetly', '/f']);
      removeStartupShortcut();
      removeScheduledTask();
      return;
    }
    // 开启：应用所选方式，并清除其余两种，避免重复启动
    if (method === 'startup') {
      run('reg', ['delete', runKey, '/v', 'Widgetly', '/f']);
      removeScheduledTask();
      createStartupShortcut(exe, dir);
    } else if (method === 'scheduler') {
      run('reg', ['delete', runKey, '/v', 'Widgetly', '/f']);
      removeStartupShortcut();
      createScheduledTask(exe, dir);
    } else {
      removeStartupShortcut();
      removeScheduledTask();
      run('reg', ['add', runKey, '/v', 'Widgetly', '/t', 'REG_SZ', '/d', `"${exe}" "${dir}"`, '/f']);
    }
  } catch (e) { console.log('autostart err:', e.message); }
}
global.__cfg = null; // app ready 后初始化（screen 模块必须 ready 后才能用）

// ============ 桌面层挂载（WorkerW）：组件像真正的桌面挂件，不受 Win+D/三指"显示桌面"影响 ============
let koffi = null, user32 = null, findWindowExW = null, setParent = null, sendMsgTimeout = null;
let setActiveWindow = null, setFocus = null, setWindowLongW = null, getWindowLongW = null, showWindow = null, setWindowPos = null;
function logD(msg) {
  try { fs.appendFileSync(path.join(APP_DIR, 'widgetly-debug.log'), `[${new Date().toISOString()}] [desktop] ${msg}\n`); } catch (_) {}
}
function loadDesktopApi() {
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    findWindowExW = user32.func('FindWindowExW', 'void *', ['void *', 'void *', 'str16', 'str16']);
    setParent = user32.func('SetParent', 'intptr_t', ['void *', 'void *']);
    sendMsgTimeout = user32.func('SendMessageTimeoutW', 'intptr_t', ['void *', 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', 'void *']);
    setActiveWindow = user32.func('SetActiveWindow', 'void *', ['void *']);
    setFocus = user32.func('SetFocus', 'void *', ['void *']);
    setWindowPos = user32.func('SetWindowPos', 'int32', ['void *', 'intptr_t', 'int32', 'int32', 'int32', 'int32', 'uint32']);
    setWindowLongW = user32.func('SetWindowLongPtrW', 'intptr_t', ['void *', 'int32', 'intptr_t']);
    getWindowLongW = user32.func('GetWindowLongPtrW', 'intptr_t', ['void *', 'int32']);
    showWindow = user32.func('ShowWindow', 'int32', ['void *', 'int32']);
    logD('api ready');
  } catch (e) { logD('api load err: ' + e.message); }
}
// 新添加/重载的组件放到所有窗口之下（不遮挡组件坞、也不遮挡其它软件）；组件坞未打开时同样生效
function pushWidgetToBack(win) {
  if (!koffi || !setWindowPos || !win || win.isDestroyed()) return;
  try {
    const buf = Buffer.from(win.getNativeWindowHandle());
    const hwnd = koffi.decode(buf, 'void *');
    // hWndInsertAfter = 1 (HWND_BOTTOM)：放到所有窗口之下；SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE
    setWindowPos(hwnd, 1, 0, 0, 0, 0, 0x0013);
  } catch (_) {}
}
// 用 SetWindowRgn 把窗口裁成 32px 圆角矩形：彻底消除透明窗口的方形边角，精确匹配 CSS 圆角（平滑无顿点）
function roundWindowCorners(win) {
  try {
    if (!koffi || !user32 || !win || win.isDestroyed()) return;
    const gdi32 = koffi.load('gdi32.dll');
    // HRGN/HWND 用 intptr_t 表示（指针大小整数，koffi 不当作托管指针，避免 GC 误释放 GDI 句柄）
    const createRoundRectRgn = gdi32.func('CreateRoundRectRgn', 'intptr_t', ['int32', 'int32', 'int32', 'int32', 'int32', 'int32']);
    const setWindowRgn = user32.func('SetWindowRgn', 'int32', ['void *', 'intptr_t', 'int32']);
    const buf = Buffer.from(win.getNativeWindowHandle());
    const hwnd = koffi.decode(buf, 'void *');
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    const [w, h] = win.getSize();
    const pw = Math.round(w * scale), ph = Math.round(h * scale);
    const r = Math.round(32 * scale);   // 32px 圆角半径 → 物理像素
    const region = createRoundRectRgn(0, 0, pw, ph, r * 2, r * 2);
    setWindowRgn(hwnd, region, 1);   // 1 = 重绘；成功后系统接管 region，勿 free
    logD(`region applied ${pw}x${ph} r=${r}`);
  } catch (e) { logD('region err: ' + e.message); }
}
function getDesktopWorkerW() {
  if (!findWindowExW) return null;
  try {
    const progman = findWindowExW(null, null, 'Progman', null);
    if (!progman) { logD('no progman'); return null; }
    sendMsgTimeout(progman, 0x052C, 0, 0, 0, 1000, null);   // 让 Progman 生成 WorkerW
    const worker = findWindowExW(progman, null, 'WorkerW', null);   // 桌面挂件层（桌面图标之上）
    logD('progman=' + String(progman) + ' worker=' + String(worker));
    return worker || progman;
  } catch (e) { logD('worker err: ' + e.message); return null; }
}
function attachToDesktop(win) {
  if (!setParent) return false;
  try {
    const worker = getDesktopWorkerW();
    if (!worker) return false;
    const buf = Buffer.from(win.getNativeWindowHandle());
    const hwnd = koffi.decode(buf, 'void *');   // koffi 3.x: decode(value, type)
    setParent(hwnd, worker);
    showWindow(hwnd, 8);   // SW_SHOWNA：显示但不激活（桌面层显示）
    return true;
  } catch (e) { logD('attach err: ' + e.message); return false; }
}
function detachFromDesktop(win) {
  if (!setParent) return;
  try {
    const buf = Buffer.from(win.getNativeWindowHandle());
    const hwnd = koffi.decode(buf, 'void *');
    setParent(hwnd, null);   // 挂回顶层窗口
    showWindow(hwnd, 8);
    logD('已挂回顶层');
  } catch (e) { logD('detach err: ' + e.message); }
}
function detachAllWidgets() {
  logD('应用层级：组件挂载桌面层（pinToDesktop）');
  for (const win of Object.values(widgetWins)) {
    if (win && !win.isDestroyed()) attachToDesktop(win);
  }
}
// 从桌面层挂回普通窗口：原生 SetParent(null) 会导致透明窗口消失（合成状态丢失），
// 这里改为「销毁重建」——按配置重新创建全部组件窗口，最稳。
function reattachAllWidgets() {
  logD('应用层级：组件挂回顶层（重建窗口）');
  const instances = [...global.__cfg.instances];
  const oldWins = widgetWins;
  widgetWins = {};
  for (const win of Object.values(oldWins)) {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  }
  for (const inst of instances) createWidgetWindow(inst);
}
// 当前窗口是否已挂载在桌面层（用于区分「启动初始态」与「开关切换」）
let pinnedToDesktop = false;
// 按 config.pinToDesktop 应用组件层级（设置界面开关 + 启动时）
function applyPinMode() {
  if (global.__cfg.pinToDesktop) {
    if (!pinnedToDesktop) { detachAllWidgets(); pinnedToDesktop = true; }
  } else {
    if (pinnedToDesktop) { reattachAllWidgets(); pinnedToDesktop = false; }
  }
}

// ============ 共享引擎：壁纸（一次截屏，全部组件窗口共享） ============
let latestWallpaper = null;
async function captureWallpaper() {
  try {
    const d = screen.getPrimaryDisplay();
    // 半分辨率截图即可（仅作毛玻璃背景，位置数学按比例换算），启动提速约 3 倍
    const tw = Math.round(d.size.width / 2), th = Math.round(d.size.height / 2);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } });
    const img = sources[0].thumbnail;
    const jpeg = Buffer.from(img.toJPEG(80)).toString('base64');
    latestWallpaper = { dataUrl: 'data:image/jpeg;base64,' + jpeg, w: img.getSize().width, h: img.getSize().height };
  } catch (e) { console.log('wallpaper err:', e.message); }
}
function wallpaperPos(x, y) {
  const d = screen.getPrimaryDisplay();
  const s = (latestWallpaper ? latestWallpaper.w : d.size.width) / d.size.width;
  return { posX: Math.round(-x * s), posY: Math.round(-y * s) };
}
function sendWallpaper(win) {
  if (!win || win.isDestroyed() || !latestWallpaper) return;
  const [wx, wy] = win.getPosition();
  win.webContents.send('wallpaper', { ...latestWallpaper, ...wallpaperPos(wx, wy) });
}
ipcMain.handle('wallpaper', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!latestWallpaper || !win) return null;
  const [wx, wy] = win.getPosition();
  return { ...latestWallpaper, ...wallpaperPos(wx, wy) };
});

// ============ 共享引擎：拖动（透明窗口 setPosition 会污染宽度，必须 setBounds 固定尺寸） ============
// 根本防护（所有组件共用，含未来新增组件）：
//  1) 双击防抖：450ms 内重复 drag-start 直接忽略，杜绝"连续双击导致窗口尺寸逐次漂移变大"；
//  2) drag-end 无条件恢复锚定尺寸。
// 日志：写 widgetly-debug.log，用于排查双击/拖动导致的窗口尺寸变化。
function logDrag(msg) {
  try { fs.appendFileSync(path.join(APP_DIR, 'widgetly-debug.log'), `[${new Date().toISOString()}] [drag] ${msg}\n`); } catch (_) {}
}
// 组件应然尺寸（透明窗口 getSize() 在高 DPI 下会虚报 +1px 且窗口会自行漂移，锚定必须用应然值）：
// 注册尺寸 + 自定义尺寸（todo 的 size / dock 的 layout）
function expectedSize(instance) {
  if (!instance) return null;
  const wdef = WIDGETS[instance.widgetId];
  const base = wdef ? { w: wdef.w, h: wdef.h } : null;
  if (instance.widgetId === 'todo' && todoAdapter.SIZES) {
    const s = (instance.config && instance.config.size) || 'medium';
    if (todoAdapter.SIZES[s]) return { w: todoAdapter.SIZES[s].w, h: todoAdapter.SIZES[s].h };
  }
  if (instance.widgetId === 'dock' && dockAdapter.LAYOUTS) {
    const l = (instance.config && instance.config.layout) || '4x2';
    if (dockAdapter.LAYOUTS[l]) return { w: dockAdapter.LAYOUTS[l].w, h: dockAdapter.LAYOUTS[l].h };
  }
  if (instance.widgetId === 'launcher' && launcherAdapter.SIZES) {
    const s = (instance.config && instance.config.size) || 'medium';
    if (launcherAdapter.SIZES[s]) return { w: launcherAdapter.SIZES[s].w, h: launcherAdapter.SIZES[s].h };
  }
  return base;
}
const dragTimers = new Map();       // webContents.id -> timer
const dragSizes = new Map();        // webContents.id -> { w, h } 拖动锚定尺寸
const lastDragStart = new Map();    // webContents.id -> 时间戳
const dragCss = new Map();          // webContents.id -> {key, active} 拖动期间关闭毛玻璃
const dragCssPending = new Set();   // webContents.id 正在等待 insertCSS 返回
ipcMain.on('drag-start', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  const inst = findInstanceByWin(win);
  // 锁定位置：在共享拖动引擎统一拦截（所有组件通用，渲染进程无需各自判断）
  if (inst && inst.config && inst.config.locked) { logDrag(`start BLOCKED(已锁定) id=${id}`); return; }
  if (dragTimers.has(id)) { logDrag(`start SKIP(id正在拖动) id=${id}`); return; }
  const now = Date.now();
  const since = lastDragStart.has(id) ? (now - lastDragStart.get(id)) : -1;
  if (since >= 0 && since < 450) { logDrag(`start BLOCKED(双击防抖 ${since}ms) id=${id}`); return; }
  lastDragStart.set(id, now);
  // 拖动期间关闭 backdrop-filter：软件渲染下拖动时实时重算模糊是卡死/闪退主因
  if (!dragCss.has(id) && !dragCssPending.has(id)) {
    dragCssPending.add(id);
    win.webContents.insertCSS('*{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;}').then((key) => {
      dragCssPending.delete(id);
      dragCss.set(id, { key, active: dragTimers.has(id) });
      // 若插入完成时拖动已结束，立即移除
      if (!dragTimers.has(id)) {
        dragCss.delete(id);
        try { win.webContents.removeInsertedCSS(key); } catch (_) {}
      }
    }).catch(() => { dragCssPending.delete(id); });
  }
  const exp = expectedSize(inst);
  const [wx, wy] = win.getPosition();
  const [gw, gh] = win.getSize();
  const ww = exp ? exp.w : gw;    // 锚定用应然尺寸，不用 getSize 的虚报值
  const wh = exp ? exp.h : gh;
  if (exp && (gw !== ww || gh !== wh)) {
    win.setBounds({ x: wx, y: wy, width: ww, height: wh });
    logDrag(`start FIX 历史漂移 ${gw}x${gh} -> ${ww}x${wh} id=${id}`);
  }
  dragSizes.set(id, { w: ww, h: wh });
  const c = screen.getCursorScreenPoint();
  const off = { x: c.x - wx, y: c.y - wy };
  logDrag(`start id=${id} pos=${wx},${wy} anchor=${ww}x${wh} cursor=${c.x},${c.y} off=${off.x},${off.y} sinceLast=${since}`);
  let lastX = wx, lastY = wy;   // 上次 setBounds 的位置
  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); dragTimers.delete(id); return; }
    const cur = screen.getCursorScreenPoint();
    const nx = cur.x - off.x, ny = cur.y - off.y;
    // 只在光标实际移动超过 3px 时才 setBounds：双击/原地点击时零 setBounds，杜绝透明窗口尺寸漂移
    if (Math.abs(nx - lastX) > 3 || Math.abs(ny - lastY) > 3) {
      lastX = nx; lastY = ny;
      win.setBounds({ x: nx, y: ny, width: ww, height: wh });
      if (latestWallpaper) win.webContents.send('wallpaper-pos', wallpaperPos(nx, ny));
      // 性能：逐帧 move 日志已移除（16ms 一次磁盘写入会拖慢拖动），仅保留 start/end
    }
  }, 16);
  dragTimers.set(id, timer);
});
ipcMain.on('drag-end', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const id = win.webContents.id;
  if (dragTimers.has(id)) { clearInterval(dragTimers.get(id)); dragTimers.delete(id); }
  // 拖动结束：恢复毛玻璃
  if (dragCss.has(id)) {
    const { key } = dragCss.get(id);
    dragCss.delete(id);
    try { win.webContents.removeInsertedCSS(key); } catch (_) {}
  }
  // 无条件恢复应然尺寸：透明窗口交互中会自行漂移 +1~2px，结束后强制 setBounds 到应然值
  const exp = expectedSize(findInstanceByWin(win));
  const snap = dragSizes.get(id);
  dragSizes.delete(id);
  if (!win.isDestroyed()) {
    const [x, y] = win.getPosition();
    const [cw, ch] = win.getSize();
    const ww = exp ? exp.w : (snap ? snap.w : cw);
    const wh = exp ? exp.h : (snap ? snap.h : ch);
    win.setBounds({ x, y, width: ww, height: wh });
    logDrag(`end id=${id} pos=${x},${y} before=${cw}x${ch} restored=${ww}x${wh} (exp=${!!exp})`);
  } else {
    logDrag(`end id=${id} 窗口已销毁`);
  }
  saveInstancePos(win);
});

// ============ 组件实例 ============
let widgetWins = {}; // instanceId -> BrowserWindow

function findInstanceByWin(win) {
  for (const [id, w] of Object.entries(widgetWins)) {
    if (w === win) return global.__cfg.instances.find(i => i.id === id);
  }
  return null;
}
function saveInstancePos(win) {
  const inst = findInstanceByWin(win);
  if (!inst) return;
  const [x, y] = win.getPosition();
  if (inst.x === x && inst.y === y) return;   // 位置未变（纯点击），跳过写盘
  inst.x = x; inst.y = y;
  saveConfig();
}

function createWidgetWindow(instance) {
  const wdef = WIDGETS[instance.widgetId];
  if (!wdef) return null;
  const [ww, wh] = [wdef.w, wdef.h];   // 尺寸统一取自注册表

  const win = new BrowserWindow({
    width: ww,
    height: wh,
    x: instance.x,
    y: instance.y,
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
  widgetWins[instance.id] = win;
  // 显式 setBounds 精确化尺寸（构造函数在高 DPI 下会多 2px，文件夹组件靠此对齐）
  win.setBounds({ x: instance.x, y: instance.y, width: ww, height: wh });

  win.loadFile(path.join(APP_DIR, 'widgets', wdef.dir || instance.widgetId, wdef.entry), { query: { inst: instance.id } });
  // 创建后立即放到所有窗口之下（不遮挡组件坞/其它软件）。
  // 注意：绝不能用 show:false + showInactive —— 会把透明窗口踢出屏幕合成导致组件不可见（坑）。
  pushWidgetToBack(win);
  if (managerWin && !managerWin.isDestroyed() && managerWin.isVisible()) managerWin.focus();
  win.webContents.on('did-finish-load', () => {
    // 刷新后再次压到最底层（组件重载会重新置顶，需重新压回）
    pushWidgetToBack(win);
    // 新增组件淡入（仅透明度，透明窗口安全；不影响各组件内部动画）
    try { win.webContents.insertCSS('html{animation:widgetlyIn .3s ease}@keyframes widgetlyIn{from{opacity:0}to{opacity:1}}'); } catch (_) {}
    sendWallpaper(win);
  });

  // 组件配置存取：返回「默认配置 + 实例配置」合并（保证 cfg.width 等始终有值）
  ipcMain.handle(`cfg:${instance.id}`, () => ({
    ...(WIDGET_DEFAULTS[instance.widgetId] || {}),
    ...(instance.config || {}),
  }));
  ipcMain.on(`cfg:save:${instance.id}`, (e, cfg) => {
    // 合并而非替换：保留适配层写入的字段（如 locked），避免渲染进程保存时误清空
    instance.config = { ...(instance.config || {}), ...(cfg || {}) };
    saveConfig();
  });

  // 窗口尺寸（组件自定义，如 dock 排列切换）
  ipcMain.on(`resize:${instance.id}`, (e, { width, height }) => {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width, height });
  });

  // 组件专属适配层（按实例隔离的 items 管理、图标提取、数据轮询等）
  if (instance.widgetId === 'dock') dockAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'monitor') monitorAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId.startsWith('gallery')) galleryAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'todo') todoAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'clock' || instance.widgetId === 'clockS' || instance.widgetId === 'clockM') clockAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId.startsWith('calendar')) calendarAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'launcher') launcherAdapter.setup({ instance, win, save: saveConfig });
  if (String(instance.widgetId).startsWith('pomodoro')) pomodoroAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'memory') memoryAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'sysmon' || instance.widgetId === 'sysmonL') sysmonAdapter.setup({ instance, win, save: saveConfig });
  if (String(instance.widgetId).startsWith('clock2')) clock2Adapter.setup({ instance, win, save: saveConfig });
  if (String(instance.widgetId).startsWith('weather')) weatherAdapter.setup({ instance, win, save: saveConfig });

  win.on('closed', () => { if (widgetWins[instance.id] === win) delete widgetWins[instance.id]; });
  return win;
}

function destroyWidgetWindow(id) {
  const win = widgetWins[id];
  if (win && !win.isDestroyed()) win.close();
}

// ============ 管理器 ============
let managerWin = null;
let isQuitting = false;
function hideManagerToTray() {
  if (!managerWin || managerWin.isDestroyed()) return;
  // 右上角 × 的目标行为是“隐藏主窗口”，不是请求销毁窗口。
  // 直接 hide 可避免部分 Windows/Electron 关闭路径把主进程一并结束。
  managerWin.hide();
}
function createManagerWindow() {
  if (managerWin && !managerWin.isDestroyed()) {
    if (managerWin.isMinimized()) managerWin.restore();
    managerWin.show();
    managerWin.focus();
    return;
  }
  managerWin = new BrowserWindow({
    width: 1060,
    height: 680,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,         // 主界面不占任务栏：最小化/关闭都只驻留系统托盘
    hasShadow: false,          // 透明窗口的系统默认阴影是方形，关闭它
    transparent: true,
    backgroundColor: '#00000000',
    icon: ICON_PATH,
    webPreferences: { nodeIntegration: true, contextIsolation: false, nodeIntegrationInSubFrames: true },
  });
  managerWin.loadFile(path.join(APP_DIR, 'manager', 'index.html'));
  roundWindowCorners(managerWin);   // 裁掉窗口矩形直角（SetWindowRgn 精确 32px 圆角，匹配 CSS）
  managerWin.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (global.__cfg && global.__cfg.closeToTray !== false) hideManagerToTray();
      else app.quit();
    }
  });
  managerWin.on('closed', () => { managerWin = null; });
}

// 管理器 IPC
// ---------- 卡片型号分类（智能排序用）：按尺寸归类，不规则组件归到最接近的型号（不改动组件本身） ----------
function widgetType(w) {
  if (w.w >= 330 && w.h >= 400) return 'xl';            // 超大号：342×500 / 342×551
  if (w.w >= 260 && w.h >= 260) return 'large';          // 大号：270~285 × 280~285（正方形）
  if (w.w >= 200) return 'mediumBar';                    // 中号长条形：280 × 148 / 180
  if (w.w >= 130 && w.h >= 145) return 'mediumSquare';   // 中号正方形：140 × 148
  if (w.w >= 130 && w.h >= 100) return 'smallSquare';    // 小号正方形：140 × 140
  return 'smallBar';                                     // 小号长条形：140 × 74
}
const TYPE_RANK = { mediumBar: 0, large: 1, mediumSquare: 2, smallSquare: 3, smallBar: 4, xl: 5 };

ipcMain.handle('widgets-list', () => {
  const all = Object.values(WIDGETS);
  let ordered;
  if (Array.isArray(global.__cfg.widgetOrder) && global.__cfg.widgetOrder.length) {
    // 用户手动拖拽过：按自定义顺序，未在顺序里的新增组件追加到末尾
    ordered = global.__cfg.widgetOrder.map((id) => all.find((w) => w.id === id)).filter(Boolean);
    all.forEach((w) => { if (!ordered.includes(w)) ordered.push(w); });
  } else {
    // 智能排序：中号长条形 → 大号 → 中号正方形 → 小号正方形 → 小号长条形 → 超大号
    // （flex 布局按此顺序从左到右、换行填充，右侧有空间就顺势放入）
    ordered = [...all].sort((a, b) => TYPE_RANK[widgetType(a)] - TYPE_RANK[widgetType(b)]);
  }
  return {
    categories: CATEGORIES,
    widgets: ordered.map(w => ({
      ...w,
      count: global.__cfg.instances.filter(i => i.widgetId === w.id).length,
    })),
  };
});
ipcMain.on('widget-order:save', (_e, order) => {
  if (Array.isArray(order)) { global.__cfg.widgetOrder = order; saveConfig(); }
});
ipcMain.handle('instances-list', () => global.__cfg.instances.map(i => ({ ...i, widgetId: i.widgetId })));
// 管理器毛玻璃不透明度（右上角滑块）
ipcMain.handle('manager-opacity', () => (typeof global.__cfg.managerOpacity === 'number' ? global.__cfg.managerOpacity : 0.5));
ipcMain.on('manager-opacity:save', (e, v) => {
  if (typeof v === 'number') { global.__cfg.managerOpacity = Math.max(0, Math.min(1, v)); saveConfig(); }
});
ipcMain.on('add-widget', (e, widgetId) => {
  if (!WIDGETS[widgetId]) return;
  const { workArea } = screen.getPrimaryDisplay();
  const n = global.__cfg.instances.filter(i => i.widgetId === widgetId).length + 1;
  const inst = {
    id: `${widgetId}-${Date.now()}`,
    widgetId,
    x: workArea.x + 200 + n * 40,
    y: workArea.y + 120 + n * 30,
    config: {},
  };
  global.__cfg.instances.push(inst);
  saveConfig();
  createWidgetWindow(inst);
});
ipcMain.on('remove-widget', (e, id) => {
  global.__cfg.instances = global.__cfg.instances.filter(i => i.id !== id);
  saveConfig();
  destroyWidgetWindow(id);
});
ipcMain.on('toggle-widget', (e, id) => {
  if (widgetWins[id]) destroyWidgetWindow(id);
  else {
    const inst = global.__cfg.instances.find(i => i.id === id);
    if (inst) createWidgetWindow(inst);
  }
});
// 主窗口右上角 ×：开关开启时隐藏到托盘；关闭时真正退出整个应用和全部组件。
ipcMain.on('manager-close', () => {
  if (global.__cfg && global.__cfg.closeToTray !== false) hideManagerToTray();
  else app.quit();
});
// 主窗口最小化按钮：始终隐藏到托盘，不受“关闭软件”开关影响。
ipcMain.on('manager-minimize', hideManagerToTray);
// ---------- 设置：固定组件层级（免疫 Win+D / 三指下滑） ----------
ipcMain.handle('pinToDesktop:get', () => !!global.__cfg.pinToDesktop);
ipcMain.on('pinToDesktop:save', (_e, v) => {
  global.__cfg.pinToDesktop = !!v;
  saveConfig();
  applyPinMode();
});
// ---------- 设置：开机自启 ----------
ipcMain.handle('autostart:get', () => !!global.__cfg.autostart);
ipcMain.on('autostart:save', (_e, v) => {
  global.__cfg.autostart = !!v;
  saveConfig();
  applyAutostart();
});
// ---------- 设置：开机自启方式 ----------
ipcMain.handle('autostartMethod:get', () => global.__cfg.autostartMethod || 'registry');
ipcMain.on('autostartMethod:save', (_e, v) => {
  const m = ['registry', 'startup', 'scheduler'].includes(v) ? v : 'registry';
  global.__cfg.autostartMethod = m;
  saveConfig();
  applyAutostart();
});
// ---------- 设置：启动时打开组件坞 ----------
ipcMain.handle('openManagerOnStart:get', () => global.__cfg.openManagerOnStart !== false);
ipcMain.on('openManagerOnStart:save', (_e, v) => {
  global.__cfg.openManagerOnStart = !!v;
  saveConfig();
});
// ---------- 设置：关闭组件坞时最小化到托盘 ----------
ipcMain.handle('closeToTray:get', () => global.__cfg.closeToTray !== false);
ipcMain.on('closeToTray:save', (_e, v) => {
  global.__cfg.closeToTray = !!v;
  saveConfig();
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('closeToTray:changed', global.__cfg.closeToTray);
});
let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  settingsWin = new BrowserWindow({
    width: 380, height: 620,
    x: wa.x + Math.max(0, Math.round((wa.width - 380) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 620) / 2)),
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', icon: ICON_PATH,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  settingsWin.loadFile(path.join(APP_DIR, 'manager', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}
ipcMain.on('settings-open', openSettingsWindow);
ipcMain.on('settings-close', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
// ---------- 捐助窗口（微信收款二维码） ----------
let donateWin = null;
function openDonateWindow() {
  if (donateWin && !donateWin.isDestroyed()) { donateWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  donateWin = new BrowserWindow({
    width: 340, height: 640,
    x: wa.x + Math.max(0, Math.round((wa.width - 340) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 640) / 2)),
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', icon: ICON_PATH,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  donateWin.loadFile(path.join(APP_DIR, 'manager', 'donate.html'));
  donateWin.on('closed', () => { donateWin = null; });
}
ipcMain.on('donate-open', openDonateWindow);
ipcMain.on('donate-close', () => { if (donateWin && !donateWin.isDestroyed()) donateWin.close(); });
// ---------- 在线更新（electron-updater，走 GitHub Releases；开发模式自动禁用） ----------
let autoUpdater = null;
function initUpdater() {
  if (!app.isPackaged) return;   // 开发模式无 latest.yml，直接禁用
  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    autoUpdater.autoDownload = false;        // 先提示，用户确认后再下载
    autoUpdater.autoInstallOnAppQuit = true;
    const push = (state) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update-status', state);
    };
    autoUpdater.on('update-available', (info) => push({ state: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => push({ state: 'none' }));
    autoUpdater.on('download-progress', (p) => push({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => push({ state: 'downloaded', version: info.version }));
    autoUpdater.on('error', (err) => push({ state: 'error', message: (err && err.message) || '未知错误' }));
  } catch (e) { autoUpdater = null; }
}
ipcMain.on('update-check', () => {
  if (!autoUpdater) {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update-status', { state: 'error', message: '开发模式或更新源未配置，请用正式安装版检查更新' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update-status', { state: 'error', message: (err && err.message) || '检查更新失败' });
  });
});
ipcMain.on('update-download', () => { if (autoUpdater) autoUpdater.downloadUpdate().catch(() => {}); });
ipcMain.on('update-install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });
ipcMain.handle('app-version', () => app.getVersion());
// 打开浏览器下载页（GitHub Releases，用户手动下载兜底通道）
const RELEASE_URL = 'https://github.com/3226194802/widgetly-releases/releases';
ipcMain.on('open-download-page', () => {
  try { shell.openExternal(RELEASE_URL); } catch (_) {}
});
ipcMain.on('quit-app', () => app.quit());

// ============ 托盘 ============
let tray = null;
function createTray() {
  // 用正式图标替代空图标（托盘可见）
  let trayIcon = require('electron').nativeImage.createFromPath(ICON_PATH);
  if (!trayIcon.isEmpty()) trayIcon = trayIcon.resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('Widgetly 组件坞');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开组件坞', click: createManagerWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', createManagerWindow);
}

// ============ 共享引擎：激活与事件日志 ============
// 右键菜单前置：未激活窗口 contextmenu 不触发，组件右键前先 activate → main 聚焦窗口
ipcMain.on('activate', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.focus();
});
// 组件事件日志（排障用）：renderer 的 evt 上报 → 写 widgetly-debug.log
ipcMain.on('evt', (e, msg) => {
  try {
    fs.appendFileSync(path.join(APP_DIR, 'widgetly-debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
});

// ============ 启动 ============
app.whenReady().then(async () => {
  global.__cfg = loadConfig();   // screen 就绪后再读配置
  loadDesktopApi();              // 桌面层挂载 API（WorkerW）
  applyAutostart();              // 按 autostart 配置注册/取消开机自启
  initUpdater();                 // 在线更新（仅打包版生效）
  await captureWallpaper();      // 窗口未建，截干净壁纸（desktopCapturer 会破坏已建透明窗口，必须先截）
  if (global.__cfg.openManagerOnStart !== false) createManagerWindow();
  createTray();
  // 组件窗口错峰创建：同时创建 21 个渲染进程会引发 CPU 风暴（开机 2 分钟卡顿主因），
  // 每个间隔 120ms，既平滑 CPU 峰值，又让主界面先出来可交互
  global.__cfg.instances.forEach((inst, i) => {
    setTimeout(() => { if (!widgetWins[inst.id]) createWidgetWindow(inst); }, i * 120);
  });
  setTimeout(() => applyPinMode(), Math.max(500, global.__cfg.instances.length * 120 + 300));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createManagerWindow(); });
});

// 管理器关窗不退出（托盘常驻）；显式退出才退
app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
app.on('before-quit', () => { isQuitting = true; });
