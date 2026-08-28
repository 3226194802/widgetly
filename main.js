// Widgetly 组件坞 —— 主进程
// 单进程管理：管理器窗口 + 组件窗口（多实例）+ 系统托盘 + 共享引擎（壁纸/拖动/配置）
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// ============ 启动异常日志 ============
// 说明：JS/渲染进程异常可以在当次直接写入桌面；若是进程被系统强制终止，
// 则保留启动标记，并在下一次正常启动时补出一份“上次启动异常退出”报告。
// 日志绝不包含用户设置的 AI API Key。
const CRASH_STATE_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Widgetly');
const STARTUP_MARKER_FILE = path.join(CRASH_STATE_DIR, 'startup-in-progress.json');
const STARTED_AT = Date.now();
const IS_TEST_MODE = process.argv.includes('--widgetly-test-mode');
// 开机启动必须带上独立标记，不能再依赖“启动后才读到的配置”猜测启动来源。
// 这能避免 Windows 登录时多次唤醒或旧启动项竞争，错误弹出组件坞主界面。
const BACKGROUND_START_ARGUMENT = '--widgetly-background';
const IS_BACKGROUND_START = process.argv.includes(BACKGROUND_START_ARGUMENT);
let startupMarkedHealthy = false;

function desktopLogDir() {
  try { return app.getPath('desktop'); } catch (_) { return path.join(os.homedir(), 'Desktop'); }
}
function formatCrashDetail(err) {
  if (!err) return '未提供异常对象';
  if (err instanceof Error) return err.stack || err.message || String(err);
  if (typeof err === 'object') {
    try { return JSON.stringify(err, null, 2); } catch (_) { return String(err); }
  }
  return String(err);
}
let recentCrashLog = { path: '', at: 0 };
function writeCrashLog(kind, err, extra = '') {
  try {
    const d = new Date();
    const stamp = d.toISOString().replace(/[.:]/g, '-');
    const lines = [
      'Widgetly 组件坞 - 异常诊断日志',
      '生成时间: ' + d.toLocaleString('zh-CN'),
      '异常类型: ' + kind,
      '应用版本: ' + (app.getVersion ? app.getVersion() : '未知'),
      '运行环境: Windows ' + os.release() + ' / ' + process.arch + ' / Electron ' + (process.versions.electron || '未知'),
      '是否安装版: ' + (app.isPackaged ? '是' : '否'),
      '启动后经过: ' + Math.max(0, Date.now() - STARTED_AT) + ' ms',
      '',
      '异常详情:',
      formatCrashDetail(err),
    ];
    if (extra) lines.push('', '附加信息:', String(extra));
    lines.push('', '说明：请将此文件发给 Widgetly 开发者。日志不会记录 API Key。');
    // 同一次底层崩溃可能依次触发 renderer/child/uncaught 多个事件。两秒内的附加诊断
    // 合并进同一个桌面文件，既保留信息，也不再给用户生成两份几乎相同的日志。
    if (recentCrashLog.path && d.getTime() - recentCrashLog.at < 2000 && fs.existsSync(recentCrashLog.path)) {
      fs.appendFileSync(recentCrashLog.path, '\r\n\r\n—— 同次异常的附加诊断 ——\r\n' + lines.join('\r\n'), 'utf8');
      recentCrashLog.at = d.getTime();
      return recentCrashLog.path;
    }
    // 只写入桌面上的单个 .txt 文件；这里不创建“日志文件夹”，也不会在桌面留下目录。
    const output = path.join(desktopLogDir(), `Widgetly-异常日志-${stamp}.txt`);
    fs.writeFileSync(output, lines.join('\r\n'), 'utf8');
    recentCrashLog = { path: output, at: d.getTime() };
    return output;
  } catch (_) {
    // 写桌面目录失败时，不再抛出第二个异常，避免掩盖原始问题。
  }
}
function recoverInterruptedStartup() {
  try {
    if (!fs.existsSync(STARTUP_MARKER_FILE)) return;
    const previous = JSON.parse(fs.readFileSync(STARTUP_MARKER_FILE, 'utf8'));
    writeCrashLog('上一次启动未完成', new Error('程序在完成启动前异常退出或被系统终止。'), '上次启动时间: ' + (previous.startedAt || '未知'));
    fs.unlinkSync(STARTUP_MARKER_FILE);
  } catch (_) {}
}
function markStartupInProgress() {
  try {
    fs.mkdirSync(CRASH_STATE_DIR, { recursive: true });
    fs.writeFileSync(STARTUP_MARKER_FILE, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }), 'utf8');
  } catch (_) {}
}
function markStartupHealthy() {
  if (startupMarkedHealthy) return;
  startupMarkedHealthy = true;
  try { if (fs.existsSync(STARTUP_MARKER_FILE)) fs.unlinkSync(STARTUP_MARKER_FILE); } catch (_) {}
}

// 必须在加载各个组件适配层之前注册：这样某个组件依赖加载失败也能留下日志。
// 同一次关闭波次可能让多个窗口几乎同时报出相同异常；只保留第一份有效诊断，
// 避免用户桌面在几十毫秒内出现多份重复日志。
let fatalExitScheduled = false;
process.on('uncaughtException', (err) => {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  writeCrashLog('主进程未捕获异常', err);
  setTimeout(() => app.exit(1), 40);
});
process.on('unhandledRejection', (reason) => writeCrashLog('未处理的异步异常', reason));

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
const countdownAdapter = require('./widgets/countdown/adapter.js');
const promptAdapter = require('./widgets/prompt/adapter.js');
const studioAdapter = require('./widgets/studio/adapter.js');
const componentDockAdapter = require('./widgets/componentDock/adapter.js');
const commonWidgetAdapter = require('./widgets/common/adapter.js');

const APP_DIR = __dirname;
const USER_DATA = app.getPath('userData');                 // 可写目录（%APPDATA%\Widgetly）
const CONFIG_FILE = path.join(USER_DATA, 'config.json');   // 主配置（打包后可写）
const LEGACY_CONFIG = path.join(APP_DIR, 'config.json');   // 旧位置（开发期，首次启动自动迁移）
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.png');   // 应用图标（窗口/托盘/打包共用）

app.disableHardwareAcceleration();

// ============ 单实例锁 ============
// 防止双击任务栏/再次启动导致第二实例读取同一配置、在相同位置重复创建组件（用户反馈"组件重叠"）。
// 第二个实例启动时，直接聚焦已存在的管理器窗口。
let startupConfigReady = false;
const pendingSecondInstanceRequests = [];

function commandLineRequestsBackground(commandLine) {
  return Array.isArray(commandLine) && commandLine.includes(BACKGROUND_START_ARGUMENT);
}

function shouldKeepManagerHiddenForRequest(commandLine) {
  // 新版开机项具有明确标记；即使设置文件刚好尚未读完，也绝不能弹组件坞。
  if (commandLineRequestsBackground(commandLine)) return true;
  // 兼容旧版本留下的不带参数启动项：用户关闭该选项后，所有来自重复进程的
  // 唤醒均维持后台驻留。用户仍可通过托盘“打开组件坞”显式打开界面。
  return global.__cfg && global.__cfg.openManagerOnStart === false;
}

function handleSecondInstance(commandLine) {
  if (!startupConfigReady) {
    pendingSecondInstanceRequests.push(commandLine || []);
    return;
  }
  if (shouldKeepManagerHiddenForRequest(commandLine)) {
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
}

// 隔离测试配置允许与用户已安装的正式版同时运行；正式版本仍保持单实例，
// 不会因测试开关改变用户日常启动或托盘行为。
const gotSingleLock = IS_TEST_MODE ? true : app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  // 本地自动化测试使用隔离 profile，不能在用户桌面写入“异常退出”诊断文件。
  if (!IS_TEST_MODE) {
    recoverInterruptedStartup();
    markStartupInProgress();
  }
  app.on('second-instance', (_event, commandLine) => handleSecondInstance(commandLine));
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
  flipClock: { id: 'flipClock', name: '翻页时钟', icon: '◫', w: 280, h: 148, minW: 190, minH: 104, entry: 'index.html', dir: 'studio', category: 'clock' },
  digitalClockGlass: { id: 'digitalClockGlass', name: '桌面时钟日历·精简', icon: '◧', w: 280, h: 148, minW: 180, minH: 92, entry: 'index.html', dir: 'studio', category: 'clock' },
  durationTimer: { id: 'durationTimer', name: '倒计时工具', icon: '◴', w: 360, h: 220, minW: 220, minH: 130, entry: 'index.html', dir: 'studio', category: 'productivity' },
  componentDock: { id: 'componentDock', name: '组件坞', icon: '✦', w: 500, h: 350, minW: 260, minH: 170, maxW: 1400, maxH: 1000, entry: 'index.html', dir: 'componentDock', category: 'componentDock' },
  cycleCountdown: { id: 'cycleCountdown', name: '周期倒数日', icon: '↻', w: 280, h: 210, minW: 180, minH: 125, entry: 'index.html', dir: 'studio', category: 'calendar' },
  simplePomodoro: { id: 'simplePomodoro', name: '简约番茄时钟', icon: '🍅', w: 300, h: 205, minW: 190, minH: 130, entry: 'index.html', dir: 'studio', category: 'productivity' },
  // —— 280×180 ——
  todo: { id: 'todo', name: '今日待办', icon: '✅', w: 280, h: 180, entry: 'index.html', category: 'productivity' },
  quadrantTasks: { id: 'quadrantTasks', name: '四象限清单', icon: '▦', w: 370, h: 370, minW: 220, minH: 220, entry: 'index.html', dir: 'studio', category: 'productivity' },
  stickyNote: { id: 'stickyNote', name: '桌面便签', icon: '✎', w: 310, h: 300, minW: 190, minH: 140, entry: 'index.html', dir: 'studio', category: 'productivity' },
  desktopCounter: { id: 'desktopCounter', name: '桌面计数器', icon: '±', w: 320, h: 210, minW: 190, minH: 125, entry: 'index.html', dir: 'studio', category: 'productivity' },
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
  analogClock: { id: 'analogClock', name: '圆盘时钟', icon: '◷', w: 220, h: 220, minW: 130, minH: 130, maxW: 700, maxH: 700, entry: 'index.html', dir: 'studio', category: 'clock' },
  alarmClock: { id: 'alarmClock', name: '闹钟', icon: '⌁', w: 360, h: 220, minW: 240, minH: 145, entry: 'index.html', dir: 'studio', category: 'clock' },
  // —— 大正方形 280-285 ——
  galleryL: { id: 'galleryL', name: '图库·大', icon: '🖼️', w: 280, h: 280, entry: 'index.html', dir: 'gallery', category: 'tool' },
  calendarSquare: { id: 'calendarSquare', name: '日历·月相月历', icon: '🌙', w: 270, h: 280, entry: 'square.html', dir: 'calendar', category: 'calendar' },
  calendarRing: { id: 'calendarRing', name: '日历·周环', icon: '💫', w: 270, h: 280, entry: 'ring.html', dir: 'calendar', category: 'calendar' },
  countdownSingle: { id: 'countdownSingle', name: '倒数日·单目标', icon: '⌛', w: 250, h: 260, entry: 'index.html', dir: 'countdown', category: 'calendar' },
  countdownTriple: { id: 'countdownTriple', name: '倒数日·三目标', icon: '📋', w: 250, h: 260, entry: 'triple.html', dir: 'countdown', category: 'calendar' },
  promptOptimizer: { id: 'promptOptimizer', name: 'AI 提示词优化', icon: '✦', w: 360, h: 150, entry: 'index.html', dir: 'prompt', category: 'productivity' },
  miniCalendarGlass: { id: 'miniCalendarGlass', name: '桌面小日历', icon: '▦', w: 310, h: 330, minW: 210, minH: 220, entry: 'index.html', dir: 'studio', category: 'calendar' },
  clockCalendar: { id: 'clockCalendar', name: '桌面时钟日历·完整', icon: '▣', w: 330, h: 560, minW: 220, minH: 300, maxW: 900, maxH: 900, entry: 'index.html', dir: 'studio', category: 'calendar' },
  lineWeather: { id: 'lineWeather', name: '桌面折线天气', icon: '⌁', w: 360, h: 310, minW: 220, minH: 170, entry: 'index.html', dir: 'studio', category: 'tool' },
  desktopSchedule: { id: 'desktopSchedule', name: '桌面日程', icon: '☷', w: 340, h: 300, minW: 210, minH: 150, entry: 'index.html', dir: 'studio', category: 'productivity' },
  markdownNote: { id: 'markdownNote', name: '桌面笔记', icon: 'M↓', w: 330, h: 420, minW: 210, minH: 160, entry: 'index.html', dir: 'studio', category: 'productivity' },
  classSchedule: { id: 'classSchedule', name: '桌面课程表', icon: '课', w: 310, h: 390, minW: 210, minH: 170, entry: 'index.html', dir: 'studio', category: 'productivity' },
  progressTracker: { id: 'progressTracker', name: '桌面进度条', icon: '≋', w: 360, h: 300, minW: 210, minH: 150, entry: 'index.html', dir: 'studio', category: 'productivity' },
  calendarBig: { id: 'calendarBig', name: '日历·墨滴月历', icon: '🖌️', w: 285, h: 285, entry: 'big.html', dir: 'calendar', category: 'calendar' },
  pomodoro: { id: 'pomodoro', name: '番茄时钟', icon: '🍅', w: 285, h: 285, entry: 'index.html', category: 'productivity' },
  sysmonL: { id: 'sysmonL', name: '系统监测·大', icon: '🖥️', w: 285, h: 285, entry: 'index.html', dir: 'sysmon', category: 'tool' },
  // —— 超大（放最后）——
  calendarXL: { id: 'calendarXL', name: '日历·全景', icon: '🗓️', w: 342, h: 500, entry: 'xl.html', dir: 'calendar', category: 'calendar' },
  plannerCalendar: { id: 'plannerCalendar', name: '桌面待办大日历', icon: '▣', w: 720, h: 500, minW: 360, minH: 260, maxW: 1200, maxH: 850, entry: 'index.html', dir: 'studio', category: 'calendar' },
  desktopFolder: { id: 'desktopFolder', name: '桌面文件夹', icon: '▤', w: 330, h: 440, minW: 210, minH: 180, entry: 'index.html', dir: 'studio', category: 'tool' },
  monitor: { id: 'monitor', name: 'AI 用量监控', icon: '📊', w: 342, h: 551, entry: 'index.html', category: 'tool' },
};
// 左侧导航分类：组件坞是独立的一级能力，不放在“工具”分类内。
const CATEGORIES = [
  { id: 'all', name: '全部', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>' },
  { id: 'componentDock', name: '组件坞', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><rect x="7" y="7" width="4" height="4" rx="1"/><rect x="13" y="7" width="4" height="4" rx="1"/><rect x="7" y="13" width="4" height="4" rx="1"/><rect x="13" y="13" width="4" height="4" rx="1"/></svg>' },
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
  // 倒数日组件：默认 80% 透明（背景不透明度 0.2）；两个组件共享全局目标日期库。
  countdownSingle: { bgOpacity: 0.2, bgColor: '#f7fbff', textColor: '#142033', accentColor: '#319fe8', secondaryColor: '#ff9f2e', pinned: false, locked: false, activeId: '' },
  countdownTriple: { bgOpacity: 0.2, bgColor: '#f7fbff', textColor: '#142033', accentColor: '#319fe8', secondaryColor: '#ff9f2e', pinned: false, locked: false, slotIds: ['', '', ''] },
  promptOptimizer: { bgOpacity: 0.4, strength: 1, pinned: false, locked: false, draft: '', lastResult: '' },
  // 组件坞负责整体窗口与布局；子组件自身仍单独保存配置，不会被合并配置覆盖。
  componentDock: { layout: 'free', gap: 10, padding: 10, page: 0, pageSize: 6, style: 'unified', backgroundTransparency: 80, bgOpacity: .2, pinned: false, locked: false, clickThrough: false },
};

// ============ 组件坞：一个真实窗口承载多个独立组件实例 ============
// 子组件并不复制数据，而是保留在 instances 中，仅通过 host 指向所属组件坞。
// 这样解散、移出和升级都能恢复原组件，而不会丢失便签、闹钟、文件夹等数据。
const componentDockRuntimes = new Map();
function isComponentDock(instance) { return !!instance && instance.widgetId === 'componentDock'; }
function isDockableWidgetId(widgetId) { return !!WIDGETS[widgetId] && studioAdapter.isStudioWidget(widgetId); }

// 组件坞采用 0～1 的相对坐标保存子组件位置。外层窗口缩放时，同一套布局会按比例
// 实时重排；不会重新创建 iframe，因此天气、闹钟、便签等正在运行的组件不会被刷新。
function dockNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function dockGridRects(count, mode = 'smart') {
  const gap = .018;
  const cell = (col, row, cols, rows) => ({
    x: col / cols + (col ? gap / 2 : 0),
    y: row / rows + (row ? gap / 2 : 0),
    w: 1 / cols - gap * (cols - 1) / cols,
    h: 1 / rows - gap * (rows - 1) / rows,
  });
  if (count <= 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  if (mode === 'horizontal') return Array.from({ length: count }, (_, index) => cell(index, 0, count, 1));
  if (mode === 'vertical') return Array.from({ length: count }, (_, index) => cell(0, index, 1, count));
  if (count === 2) return [cell(0, 0, 2, 1), cell(1, 0, 2, 1)];
  if (count === 3 && mode !== 'grid') {
    return [
      { x: 0, y: 0, w: .575, h: 1 },
      { x: .595, y: 0, w: .405, h: .491 },
      { x: .595, y: .509, w: .405, h: .491 },
    ];
  }
  const cols = mode === 'grid' ? 2 : (count >= 6 ? 3 : 2);
  const rows = Math.ceil(count / cols);
  return Array.from({ length: count }, (_, index) => cell(index % cols, Math.floor(index / cols), cols, rows));
}
function normalizeDockRect(rect, fallback) {
  const source = rect && typeof rect === 'object' ? rect : fallback;
  const x = dockNumber(source && source.x, 0, .92, fallback.x);
  const y = dockNumber(source && source.y, 0, .92, fallback.y);
  const w = dockNumber(source && source.w, .12, 1, fallback.w);
  const h = dockNumber(source && source.h, .10, 1, fallback.h);
  return {
    x: Math.min(x, 1 - Math.min(w, 1)),
    y: Math.min(y, 1 - Math.min(h, 1)),
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y),
  };
}
// ============ 焦点不变式：被用户拖住的组件，算法在任何路径都不得移动它 ============
// 缩放意图对应的“被按住”的边：resize-e/w/n/s/ne/se/sw/nw 中，
// 东/南 是“往外推”的方向（另一条边被按住不动），西/北 是“往回拉”的方向（这条边被按住）。
function dockEdgeOf(intent) {
  const type = String(intent || '');
  return type.startsWith('resize-') ? type.slice('resize-'.length) : '';
}
function dockAnchorFor(intent) {
  const edge = dockEdgeOf(intent);   // e / w / n / s / ne / se / sw / nw
  const anchors = { east: false, west: false, north: false, south: false };
  if (edge.includes('e')) anchors.east = true;    // 右缘被按住 → 左边固定，右边跟手
  if (edge.includes('w')) anchors.west = true;    // 左缘被按住 → 右边固定，左边跟手
  if (edge.includes('n')) anchors.north = true;   // 上缘被按住 → 下边固定，上边跟手
  if (edge.includes('s')) anchors.south = true;   // 下缘被按住 → 上边固定，下边跟手
  return anchors;
}
// 按“锚定边”钳制焦点矩形：被按住的边绝对不动；尺寸不低于组件最小相对尺寸。
function clampFocusRect(requested, original, intent, minRel) {
  const minW = (minRel && minRel.w) || .12;
  const minH = (minRel && minRel.h) || .10;
  const src = requested && typeof requested === 'object' ? { ...requested } : { ...original };
  const move = !String(intent || '').startsWith('resize');
  const w = Number.isFinite(src.w) ? Math.max(minW, Math.min(1, src.w)) : original.w;
  const h = Number.isFinite(src.h) ? Math.max(minH, Math.min(1, src.h)) : original.h;
  if (move) {
    return {
      x: Math.max(0, Math.min(1 - w, Number.isFinite(src.x) ? src.x : original.x)),
      y: Math.max(0, Math.min(1 - h, Number.isFinite(src.y) ? src.y : original.y)),
      w, h,
    };
  }
  const a = dockAnchorFor(intent);
  const rightEdge = original.x + original.w;
  const bottomEdge = original.y + original.h;
  let x = Number.isFinite(src.x) ? src.x : original.x;
  let y = Number.isFinite(src.y) ? src.y : original.y;
  let ww = w, hh = h;
  // 锚定边拥有最高优先级：被按住的边绝不动，尺寸超界时钳尺寸而不是挪锚定边。
  if (a.east) { x = original.x; ww = Math.min(w, 1 - x); }
  if (a.west) { ww = Math.min(w, rightEdge); x = rightEdge - ww; }
  if (a.south) { y = original.y; hh = Math.min(h, 1 - y); }
  if (a.north) { hh = Math.min(h, bottomEdge); y = bottomEdge - hh; }
  // 未被锚定的边仍受边界约束（拖动移动场景允许整体平移）
  if (!a.east && !a.west) x = Math.max(0, Math.min(1 - ww, x));
  if (!a.south && !a.north) y = Math.max(0, Math.min(1 - hh, y));
  return { x, y, w: ww, h: hh };
}
// 组件最小可读尺寸 → 相对单位（随组件坞当前像素尺寸换算）
function dockMinRelative(widgetId, win) {
  const def = WIDGETS[widgetId] || {};
  const minW = Math.max(90, Number(def.minW) || Math.round(Number(def.w) * .42) || 120);
  const minH = Math.max(64, Number(def.minH) || Math.round(Number(def.h) * .42) || 90);
  const [winW, winH] = win && !win.isDestroyed() ? win.getSize() : [500, 350];
  return { w: Math.min(.98, minW / Math.max(1, winW)), h: Math.min(.98, minH / Math.max(1, winH)) };
}
function dockRectsOverlap(a, b, padding = 0) {
  return a.x + a.w > b.x + padding && b.x + b.w > a.x + padding
    && a.y + a.h > b.y + padding && b.y + b.h > a.y + padding;
}
function dockRectDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) * .25 + Math.abs(a.h - b.h) * .25;
}
function dockPreferredRect(widgetId) {
  const def = WIDGETS[widgetId] || { w: 280, h: 180 };
  const ratio = dockNumber(def.w / Math.max(1, def.h), .6, 2.4, 1.35);
  const w = ratio > 1.55 ? .46 : ratio < .9 ? .28 : .36;
  const h = Math.max(.2, Math.min(.54, w / ratio));
  return { x: .5 - w / 2, y: .5 - h / 2, w, h };
}
function dockCandidatePositions(rect, placed) {
  const xs = new Set([0, 1 - rect.w, rect.x]); const ys = new Set([0, 1 - rect.h, rect.y]);
  placed.forEach((item) => {
    const other = item.rect || item;   // 兼容 {rect} 条目与纯矩形两种形态
    [other.x, other.x + other.w, other.x - rect.w, other.x + other.w - rect.w].forEach((value) => xs.add(Math.max(0, Math.min(1 - rect.w, value))));
    [other.y, other.y + other.h, other.y - rect.h, other.y + other.h - rect.h].forEach((value) => ys.add(Math.max(0, Math.min(1 - rect.h, value))));
  });
  for (let step = 0; step <= 20; step += 1) {
    xs.add(Math.min(1 - rect.w, step / 20)); ys.add(Math.min(1 - rect.h, step / 20));
  }
  return [...xs].flatMap((x) => [...ys].map((y) => ({ ...rect, x, y }))).sort((a, b) => dockRectDistance(a, rect) - dockRectDistance(b, rect));
}
function findDockFreeRect(desired, placed) {
  const minW = Math.min(desired.w, .12); const minH = Math.min(desired.h, .10);
  // 组件坞内部宁可把非焦点组件缩到可用的最小交互尺寸，也绝不能与焦点组件重叠。
  for (let scale = 1; scale >= .12; scale -= .06) {
    const rect = normalizeDockRect({ ...desired, w: Math.max(minW, desired.w * scale), h: Math.max(minH, desired.h * scale) }, desired);
    const candidate = dockCandidatePositions(rect, placed).find((item) => !placed.some((other) => dockRectsOverlap(item, other.rect || other)));
    if (candidate) return candidate;
  }
  // 此处不允许“退而重叠”。调用方会进入全局紧凑布局，把所有组件重新放入一个
  // 无碰撞网格；组件坞扩大外框不等于可用相对坐标变多，因此不能用扩大外框来掩盖重叠。
  return null;
}
function dockPushDirections(intent, before, after) {
  const edge = dockEdgeOf(intent);
  if (edge.includes('e')) return ['right', 'down', 'up', 'left'];
  if (edge.includes('w')) return ['left', 'down', 'up', 'right'];
  if (edge.includes('s')) return ['bottom', 'right', 'left', 'top'];
  if (edge.includes('n')) return ['top', 'right', 'left', 'bottom'];
  const dx = (after.x + after.w / 2) - (before.x + before.w / 2);
  const dy = (after.y + after.h / 2) - (before.y + before.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'bottom', 'top', 'left'] : ['left', 'bottom', 'top', 'right'];
  return dy >= 0 ? ['bottom', 'right', 'left', 'top'] : ['top', 'right', 'left', 'bottom'];
}
function dockCandidateRectsNear(rect, blockers) {
  const xs = new Set([rect.x, 0, 1 - rect.w]); const ys = new Set([rect.y, 0, 1 - rect.h]);
  blockers.forEach((item) => {
    const b = item.rect || item;   // 兼容 {rect} 条目与纯矩形两种形态
    [b.x - rect.w, b.x + b.w, b.x, b.x + b.w - rect.w].forEach((x) => xs.add(Math.max(0, Math.min(1 - rect.w, x))));
    [b.y - rect.h, b.y + b.h, b.y, b.y + b.h - rect.h].forEach((y) => ys.add(Math.max(0, Math.min(1 - rect.h, y))));
  });
  return [...xs].flatMap((x) => [...ys].map((y) => ({ ...rect, x, y })));
}
function dockDirectionPenalty(candidate, original, direction) {
  if (direction === 'right' && candidate.x + .001 < original.x) return 6;
  if (direction === 'left' && candidate.x > original.x + .001) return 6;
  if (direction === 'bottom' && candidate.y + .001 < original.y) return 6;
  if (direction === 'top' && candidate.y > original.y + .001) return 6;
  return 0;
}
function relocateDockEntry(entryRect, blockers, directions, focusRect, min) {
  const original = entryRect && typeof entryRect === 'object' ? { ...entryRect } : { x: 0, y: 0, w: .3, h: .3 };
  const minW = (min && min.w) || .12, minH = (min && min.h) || .10;
  // 先保持原尺寸寻找最近空位；只有确实没有空间时才逐级缩小非焦点组件（不低于组件最小可读尺寸）。
  const start = Math.min(1, Math.max(minW / Math.max(.01, original.w), minH / Math.max(.01, original.h)));
  const scales = [];
  for (let s = 1; s >= start - 1e-9; s -= Math.max(.02, (1 - start) / 10)) scales.push(Math.max(start, s));
  if (!scales.includes(1)) scales.unshift(1);
  const focus = focusRect && typeof focusRect === 'object' ? focusRect : null;
  for (const scale of scales) {
    const w = Math.max(minW, original.w * scale); const h = Math.max(minH, original.h * scale);
    const desired = normalizeDockRect({ x: original.x, y: original.y, w, h }, original);
    const candidates = dockCandidateRectsNear(desired, blockers).filter((candidate) => !blockers.some((item) => dockRectsOverlap(candidate, item.rect || item)));
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      // 总代价 = 移动距离（主导） + 缩小代价 + 方向惩罚（不许逆着拖动方向跑）+ 远离焦点奖励
      const score = (candidate) => {
        let s = dockRectDistance(candidate, original) * 24 + (1 - scale) * 10;
        s += Math.min(...directions.map((direction) => dockDirectionPenalty(candidate, original, direction))) * 5;
        if (focus) {
          const before = dockRectDistance(original, focus);
          const after = dockRectDistance(candidate, focus);
          if (after < before - 1e-6) s += (before - after) * 8;   // 往焦点里钻 = 高代价
        }
        return s;
      };
      return score(a) - score(b);
    });
    return candidates[0];
  }
  return null;
}
// 把矩形逐级缩小直到放得下（保留锚定中心不重叠）；失败返回 null
function shrinkToFit(entryRect, blockers, min, directions, focusRect) {
  const original = { ...entryRect };
  const minW = (min && min.w) || .12, minH = (min && min.h) || .10;
  const start = Math.min(1, Math.max(minW / Math.max(.01, original.w), minH / Math.max(.01, original.h)));
  for (let scale = 1; scale >= start - 1e-9; scale -= .05) {
    const s = Math.max(start, scale);
    const w = Math.max(minW, original.w * s), h = Math.max(minH, original.h * s);
    const desired = normalizeDockRect({ x: original.x, y: original.y, w, h }, original);
    const candidates = dockCandidateRectsNear(desired, blockers).filter((candidate) => !blockers.some((item) => dockRectsOverlap(candidate, item.rect || item)));
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      const score = (candidate) => dockRectDistance(candidate, original) * 24 + (1 - s) * 10 + Math.min(...directions.map((direction) => dockDirectionPenalty(candidate, original, direction))) * 5;
      return score(a) - score(b);
    });
    return candidates[0];
  }
  return null;
}
// 终极兜底：焦点纹丝不动，其余组件放入焦点周围最密的可行网格（绝不重叠）
function forcePackGrid(entries, focusId) {
  const focus = entries.find((entry) => entry.id === String(focusId));
  const focusRect = focus ? { ...focus.rect } : null;
  const used = focusRect ? [focusRect] : [];
  const COLS = 8, ROWS = 6;
  const cellW = 1 / COLS, cellH = 1 / ROWS;
  const out = [];
  const rest = entries.filter((entry) => entry.id !== String(focusId)).sort((a, b) => a.index - b.index);
  for (const entry of rest) {
    let placed = false;
    for (let row = 0; row < ROWS && !placed; row += 1) {
      for (let col = 0; col < COLS && !placed; col += 1) {
        const rect = { x: col * cellW + cellW * .02, y: row * cellH + cellH * .02, w: cellW * .96, h: cellH * .96 };
        if (!used.some((u) => dockRectsOverlap(rect, u))) { used.push(rect); out.push({ ...entry, rect, compacted: true }); placed = true; }
      }
    }
    if (!placed) out.push({ ...entry, rect: { ...entry.rect }, compacted: true });
  }
  if (focus) out.unshift({ ...focus, compacted: false });
  return out;
}
function growDockForLayout(dock, win, layouts) {
  if (!dock || !win || win.isDestroyed() || !Array.isArray(layouts)) return false;
  const children = new Map(dockChildren(dock.id).map((pair) => [pair.child.id, pair.child]));
  const bounds = win.getBounds();
  let needW = 260; let needH = 170;
  layouts.forEach((entry) => {
    const child = children.get(entry.id); const def = child && WIDGETS[child.widgetId];
    const resolvedDef = def || WIDGETS[entry.widgetId] || {};
    const minW = Math.max(100, Number(resolvedDef.minW) || Math.round(Number(resolvedDef.w) * .42) || 120);
    const minH = Math.max(72, Number(resolvedDef.minH) || Math.round(Number(resolvedDef.h) * .42) || 90);
    // 保证自动被压缩的组件仍有可读空间；外框只增长，不在拖动中反复缩小造成晃动。
    needW = Math.max(needW, Math.ceil(minW * .82 / Math.max(.12, entry.rect.w)));
    needH = Math.max(needH, Math.ceil(minH * .82 / Math.max(.10, entry.rect.h)));
  });
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const width = Math.min(Math.min(1400, area.x + area.width - bounds.x), Math.max(bounds.width, needW));
  const height = Math.min(Math.min(1000, area.y + area.height - bounds.y), Math.max(bounds.height, needH));
  if (width - bounds.width < 4 && height - bounds.height < 4) return false;
  win.setBounds({ x: bounds.x, y: bounds.y, width: Math.round(width), height: Math.round(height) });
  dock.windowState = { ...(dock.windowState || {}), windowSize: { width: Math.round(width), height: Math.round(height) } };
  return true;
}
// 动态最小窗口尺寸：保证每个子组件在当前相对尺寸下至少有最小可读像素（手动拖边框缩小也不会踩烂组件）
function applyDockMinimumSize(dock, win) {
  if (!dock || !win || win.isDestroyed()) return;
  const children = dockChildren(dock.id);
  if (!children.length) return;
  let needW = 0, needH = 0;
  children.forEach(({ child, slot }) => {
    const def = WIDGETS[child.widgetId] || {};
    const minW = Math.max(90, Number(def.minW) || Math.round(Number(def.w) * .42) || 120);
    const minH = Math.max(64, Number(def.minH) || Math.round(Number(def.h) * .42) || 90);
    const rect = normalizeDockRect(slot.rect, { x: 0, y: 0, w: 1, h: 1 });
    needW = Math.max(needW, Math.ceil(minW / Math.max(.05, rect.w)));
    needH = Math.max(needH, Math.ceil(minH / Math.max(.05, rect.h)));
  });
  try { win.setMinimumSize(Math.min(1400, Math.max(260, needW)), Math.min(1000, Math.max(170, needH))); } catch (_) {}
}
// 松手后收缩外框：内容只占窗口一部分时，把窗口缩到“刚好包住内容 + 边距”，
// 同时重算子组件相对坐标，保证它们的像素尺寸不变（不跳变、不缩小）。
function shrinkDockToFit(dock, win) {
  if (!dock || !win || win.isDestroyed()) return false;
  const children = dockChildren(dock.id);
  if (!children.length) return false;
  const bounds = win.getBounds();
  const content = { right: 0, bottom: 0 };
  children.forEach(({ slot }) => {
    const rect = normalizeDockRect(slot.rect, { x: 0, y: 0, w: 1, h: 1 });
    content.right = Math.max(content.right, rect.x + rect.w);
    content.bottom = Math.max(content.bottom, rect.y + rect.h);
  });
  // 保守收缩：只有内容明显小于窗口（两个方向都 <78%）才触发，避免每次移动都跳变窗口
  if (content.right > .78 || content.bottom > .78) return false;
  const pad = Math.max(8, Number(dock.config && dock.config.padding) || 10);
  const gapX = 2 * pad + 26, gapY = 2 * pad + 26;
  const targetW = Math.max(280, Math.min(bounds.width, Math.round(content.right * bounds.width + gapX)));
  const targetH = Math.max(180, Math.min(bounds.height, Math.round(content.bottom * bounds.height + gapY)));
  if (bounds.width - targetW < bounds.width * .08 && bounds.height - targetH < bounds.height * .08) return false;
  const sx = targetW / bounds.width, sy = targetH / bounds.height;
  // 新窗口下保持子组件像素尺寸：相对坐标 = 旧相对坐标 / 缩放比
  children.forEach(({ slot }) => {
    const rect = normalizeDockRect(slot.rect, { x: 0, y: 0, w: 1, h: 1 });
    slot.rect = { x: rect.x / sx, y: rect.y / sy, w: rect.w / sx, h: rect.h / sy };
  });
  win.setBounds({ x: bounds.x, y: bounds.y, width: targetW, height: targetH });
  dock.windowState = { ...(dock.windowState || {}), windowSize: { width: targetW, height: targetH } };
  return true;
}
function resolveDockLayout(dock, focusId, requestedRect, virtualWidgetId = '', intent = '') {
  const slots = dockSlots(dock);
  const dockWin = widgetWins[dock.id];
  const entries = slots.map((slot, index) => { const child = global.__cfg.instances.find((item) => item && item.id === slot.instanceId); return { id: String(slot.instanceId), slot, index, widgetId: child && child.widgetId, rect: normalizeDockRect(slot.rect, dockGridRects(slots.length)[index] || { x: 0, y: 0, w: 1, h: 1 }) }; });
  const focus = entries.find((entry) => entry.id === String(focusId)) || (virtualWidgetId ? { id: String(focusId), virtual: true, index: entries.length, widgetId: virtualWidgetId, rect: dockPreferredRect(virtualWidgetId) } : null);
  if (!focus) return { layouts: entries, focus: null };
  const originalFocus = { ...focus.rect };
  // 焦点矩形只由用户操作决定：先按“锚定边”钳制（缩放只动对应边），之后任何路径都不再修改它。
  focus.rect = clampFocusRect(requestedRect || focus.rect, originalFocus, intent, dockMinRelative(focus.widgetId, dockWin));
  const directions = dockPushDirections(intent, originalFocus, focus.rect);
  const result = new Map([[focus.id, { ...focus, rect: { ...focus.rect } }]]);
  const pending = new Set();   // 尚未解决重叠的条目 id
  const others = entries.filter((entry) => entry.id !== focus.id);
  others.forEach((entry) => { if (dockRectsOverlap(focus.rect, entry.rect)) pending.add(entry.id); });

  // 级联推挤：每次处理一个离焦点最近的冲突条目；被推走后又撞到别人 → 重新入队
  let guard = 0;
  while (pending.size && guard++ < 200) {
    let targetId = null, best = Infinity;
    for (const id of pending) {
      const entry = others.find((other) => other.id === id);
      const current = result.has(id) ? result.get(id).rect : entry.rect;
      const d = dockRectDistance(current, focus.rect);
      if (d < best) { best = d; targetId = id; }
    }
    const entry = others.find((other) => other.id === targetId);
    const current = result.has(targetId) ? result.get(targetId).rect : { ...entry.rect };
    const blockers = [...result.values()].map((item) => item.rect);
    const next = relocateDockEntry(current, blockers, directions, focus.rect, dockMinRelative(entry.widgetId, dockWin));
    pending.delete(targetId);
    if (next) {
      result.set(targetId, { ...entry, rect: next });
      // 新位置引发的连锁碰撞
      for (const other of others) {
        if (other.id === targetId || result.has(other.id)) continue;
        if (dockRectsOverlap(next, other.rect)) pending.add(other.id);
      }
    } else {
      // 当前尺寸放不下 → 缩小后重试；仍失败则记录，最后统一兜底
      const min = dockMinRelative(entry.widgetId, dockWin);
      const shrunk = shrinkToFit(current, blockers, min, directions, focus.rect);
      if (shrunk) result.set(targetId, { ...entry, rect: shrunk });
      else result.set(targetId, { ...entry, rect: { ...current }, constrained: true });
    }
  }

  // 收敛检查：仍有重叠 → 非焦点组件按最小扰动重新安置（焦点保持不动）
  const list = [...result.values()];
  const hasOverlap = list.some((a, i) => list.slice(i + 1).some((b) => dockRectsOverlap(a.rect, b.rect)));
  if (hasOverlap) {
    const fixed = [{ ...focus, rect: { ...focus.rect } }];
    const rest = others.slice().sort((a, b) => a.index - b.index);
    let allClean = true;
    for (const entry of rest) {
      const placed = fixed.map((item) => item.rect);
      const min = dockMinRelative(entry.widgetId, dockWin);
      const next = relocateDockEntry(entry.rect, placed, directions, focus.rect, min)
        || shrinkToFit(entry.rect, placed, min, directions, focus.rect)
        || findDockFreeRect(entry.rect, placed);
      if (next) fixed.push({ ...entry, rect: next });
      else { fixed.push({ ...entry, rect: { ...entry.rect } }); allClean = false; }
    }
    const clean = allClean && !fixed.some((a, i) => fixed.slice(i + 1).some((b) => dockRectsOverlap(a.rect, b.rect)));
    if (!clean) {
      // 终极兜底：焦点位置绝不动，其余放入稠密可行网格
      const packed = forcePackGrid(fixed, focus.id);
      return { layouts: packed, focus: packed.find((item) => item.id === focus.id) || null, compacted: true };
    }
    return { layouts: fixed, focus: fixed.find((item) => item.id === focus.id) || null, constrained: true };
  }
  return { layouts: list, focus: list.find((item) => item.id === focus.id) || null };
}
function persistDockLayout(dock, layouts) {
  const byId = new Map(layouts.filter((item) => !item.virtual).map((item) => [item.id, item.rect]));
  dockSlots(dock).forEach((slot) => {
    const rect = byId.get(String(slot.instanceId));
    if (rect) slot.rect = normalizeDockRect(rect, slot.rect || { x: 0, y: 0, w: 1, h: 1 });
  });
}
function arrangeDockSlots(dock, mode = 'smart') {
  const slots = Array.isArray(dock && dock.config && dock.config.children) ? dock.config.children : [];
  const rects = dockGridRects(slots.length, mode === 'free' || mode === 'pages' ? 'smart' : mode);
  slots.forEach((slot, index) => {
    slot.rect = normalizeDockRect(rects[index] || rects[0], { x: 0, y: 0, w: 1, h: 1 });
    slot.manual = false;
  });
}
function ensureDockSlotRects(dock) {
  const slots = Array.isArray(dock && dock.config && dock.config.children) ? dock.config.children : [];
  const fallback = dockGridRects(slots.length, String(dock && dock.config && dock.config.layout || 'smart'));
  slots.forEach((slot, index) => {
    if (!slot || typeof slot !== 'object') return;
    slot.rect = normalizeDockRect(slot.rect, fallback[index] || fallback[0] || { x: 0, y: 0, w: 1, h: 1 });
    if (typeof slot.manual !== 'boolean') slot.manual = false;
  });
}
function dockSlots(dock) {
  dock.config = { ...(WIDGET_DEFAULTS.componentDock || {}), ...(dock.config || {}) };
  if (!Array.isArray(dock.config.children)) dock.config.children = [];
  ensureDockSlotRects(dock);
  return dock.config.children;
}
function dockChildren(dockId) {
  const dock = global.__cfg.instances.find((item) => item && item.id === dockId && isComponentDock(item));
  if (!dock) return [];
  const byId = new Map(global.__cfg.instances.map((item) => [item.id, item]));
  const slots = dockSlots(dock);
  const ordered = slots.map((slot) => {
    const child = byId.get(slot && slot.instanceId);
    return child && child.host && child.host.type === 'componentDock' && child.host.dockId === dockId ? { child, slot } : null;
  }).filter(Boolean);
  // 兼容早期中断保存：被标记为属于组件坞、但尚未来得及写入 children 的组件也不会丢失。
  global.__cfg.instances.forEach((child) => {
    if (!child || !child.host || child.host.type !== 'componentDock' || child.host.dockId !== dockId) return;
    if (!ordered.some((item) => item.child.id === child.id)) {
      const slot = { instanceId: child.id, slotId: `slot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, surface: 'inherit', hidden: false, rect: null, manual: false };
      slots.push(slot); ordered.push({ child, slot });
    }
  });
  return ordered;
}
function dockModel(dockId) {
  const dock = global.__cfg.instances.find((item) => item && item.id === dockId && isComponentDock(item));
  if (!dock) return { dock: null, children: [], available: [], supported: [] };
  const children = dockChildren(dockId).map(({ child, slot }) => {
    const def = WIDGETS[child.widgetId] || {};
    return {
      id: child.id, widgetId: child.widgetId, name: def.name || child.widgetId, icon: def.icon || '◫', slotId: slot.slotId,
      surface: slot.surface === 'card' ? 'card' : 'inherit', hidden: !!slot.hidden,
      rect: { ...normalizeDockRect(slot.rect, { x: 0, y: 0, w: 1, h: 1 }) }, manual: !!slot.manual,
    };
  });
  const supported = Object.values(WIDGETS).filter((def) => isDockableWidgetId(def.id)).map((def) => ({ id: def.id, name: def.name, icon: def.icon, w: def.w, h: def.h }));
  const available = global.__cfg.instances.filter((item) => item && !item.host && item.id !== dockId && isDockableWidgetId(item.widgetId)).map((item) => {
    const def = WIDGETS[item.widgetId] || {};
    return { id: item.id, widgetId: item.widgetId, name: def.name || item.widgetId, icon: def.icon || '◫' };
  });
  return { dock: { id: dock.id, name: '组件坞', config: { ...(dock.config || {}), locked: !!((dock.windowState && dock.windowState.locked) || dock.config.locked) } }, children, available, supported };
}
function dockChildId(widgetId) { return `${widgetId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function createDockChild(dock, widgetId) {
  if (!isDockableWidgetId(widgetId)) return null;
  const child = {
    id: dockChildId(widgetId), widgetId,
    x: dock.x, y: dock.y,
    config: {},
    host: { type: 'componentDock', dockId: dock.id },
    lastStandalone: { x: dock.x + 40, y: dock.y + 40, windowSize: null },
  };
  global.__cfg.instances.push(child);
  dockSlots(dock).push({ instanceId: child.id, slotId: `slot-${child.id}`, surface: 'inherit', hidden: false, rect: null, manual: false });
  arrangeDockSlots(dock, dock.config.layout || 'smart');
  return child;
}
function updateDockFrameConfig(win, childId, nextConfig) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  const frames = win.webContents.mainFrame && Array.isArray(win.webContents.mainFrame.frames) ? win.webContents.mainFrame.frames : [];
  for (const frame of frames) {
    try {
      const url = new URL(frame.url);
      if (url.searchParams.get('inst') === childId) frame.send(`cfg:updated:${childId}`, nextConfig);
    } catch (_) {}
  }
}
function growDockToFit(dock, win, grow = {}) {
  if (!dock || !win || win.isDestroyed()) return false;
  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const count = dockSlots(dock).length;
  const baseline = count <= 1 ? { w: 360, h: 220 }
    : count === 2 ? { w: 490, h: 245 }
      : count === 3 ? { w: 540, h: 345 }
        : count <= 4 ? { w: 560, h: 405 }
          : { w: 650, h: 450 };
  const growX = Math.max(0, Number(grow.x) || 0);
  const growY = Math.max(0, Number(grow.y) || 0);
  // 只向当前右侧/下侧仍可用的桌面区域扩展，不挤走用户刚摆好的组件坞位置。
  const rightRoom = Math.max(0, area.x + area.width - bounds.x);
  const bottomRoom = Math.max(0, area.y + area.height - bounds.y);
  const targetW = Math.min(Math.min(1400, rightRoom), Math.max(bounds.width, baseline.w, bounds.width + Math.round(growX * bounds.width)));
  const targetH = Math.min(Math.min(1000, bottomRoom), Math.max(bounds.height, baseline.h, bounds.height + Math.round(growY * bounds.height)));
  if (targetW - bounds.width < 3 && targetH - bounds.height < 3) return false;
  win.setBounds({ x: bounds.x, y: bounds.y, width: Math.round(targetW), height: Math.round(targetH) });
  dock.windowState = { ...(dock.windowState || {}), windowSize: { width: Math.round(targetW), height: Math.round(targetH) } };
  return true;
}
function registerHostedStudioChild(dock, win, child) {
  if (!dock || !win || !child || !isDockableWidgetId(child.widgetId)) return;
  const runtime = componentDockRuntimes.get(dock.id);
  if (!runtime || runtime.hosted.has(child.id)) return;
  runtime.hosted.add(child.id);
  const cfgChannel = `cfg:${child.id}`;
  const saveChannel = `cfg:save:${child.id}`;
  ipcMain.removeHandler(cfgChannel);
  ipcMain.removeAllListeners(saveChannel);
  ipcMain.handle(cfgChannel, () => ({ ...(WIDGET_DEFAULTS[child.widgetId] || {}), ...(child.config || {}) }));
  const onSave = (_event, cfg) => {
    child.config = { ...(child.config || {}), ...(cfg || {}) };
    saveConfig();
    updateDockFrameConfig(win, child.id, child.config);
    // 子组件保存内容时，只更新它自身和编辑器，不重建整个组件坞。否则天气、闹钟等
    // iframe 会被重新加载，用户拖动外层窗口后就会误以为组件在“刷新”。
    if (runtime.controller && runtime.controller.notify) runtime.controller.notify('', { render: false });
  };
  ipcMain.on(saveChannel, onSave);
  runtime.cleanups.push(() => { ipcMain.removeHandler(cfgChannel); ipcMain.removeListener(saveChannel, onSave); });
  // Studio 适配层继续处理天气、文件夹、闹钟声音和独立设置页；它们的宿主窗口改为组件坞。
  const controller = studioAdapter.setup({ instance: child, win, save: saveConfig });
  runtime.childDisposers.set(child.id, controller && controller.dispose);
}
function setupHostedStudioChildren(dock, win) {
  dockChildren(dock.id).forEach(({ child }) => registerHostedStudioChild(dock, win, child));
}

// ============ 配置 ============
const DEFAULT_CLICK_THROUGH_SHORTCUT = 'CommandOrControl+Alt+Shift+W';
let activeClickThroughShortcut = '';
let clickThroughShortcutError = '';

function normalizeClickThroughShortcut(value) {
  const raw = String(value || '').trim().replace(/\s*\+\s*/g, '+');
  if (!raw || raw.length > 80 || /[\r\n]/.test(raw)) return '';
  const parts = raw.split('+');
  if (parts.length < 2 || parts.some((part) => !part)) return '';

  const modifierAliases = {
    commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl', ctrl: 'CommandOrControl', control: 'CommandOrControl',
    command: 'Command', cmd: 'Command', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', win: 'Super',
  };
  const modifiers = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = modifierAliases[String(part).toLowerCase()];
    if (!modifier || modifiers.includes(modifier)) return '';
    modifiers.push(modifier);
  }
  if (!modifiers.length) return '';

  const rawKey = parts[parts.length - 1];
  const namedKeys = {
    space: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  };
  let key = namedKeys[String(rawKey).toLowerCase()] || '';
  if (!key && /^[a-z0-9]$/i.test(rawKey)) key = rawKey.toUpperCase();
  if (!key && /^f(?:[1-9]|1\d|2[0-4])$/i.test(rawKey)) key = rawKey.toUpperCase();
  if (!key) return '';
  return [...modifiers, key].join('+');
}

function defaultConfig() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    theme: 'dark',
    autostart: true,
    autostartMethod: 'registry',   // 开机自启方式：registry(最快) | startup(启动文件夹) | scheduler(计划任务)
    openManagerOnStart: true,  // 启动时是否自动打开组件坞（关闭则仅驻留托盘）
    closeToTray: true,         // 关闭组件坞时隐藏到托盘（关闭后仍可从托盘打开）
    clickThroughShortcut: DEFAULT_CLICK_THROUGH_SHORTCUT, // 全局解除鼠标穿透快捷键（可在设置中修改）
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
  const merged = { ...defaultConfig(), ...(c || {}) };
  // 0.2.14 以前的简易 prompt 组件已经移除；新版使用独立 id promptOptimizer，
  // 防止旧实例/API 配置意外复活或污染内嵌 Prompt Optimizer 的数据。
  merged.instances = Array.isArray(merged.instances) ? merged.instances.filter((i) => i && i.widgetId !== 'prompt') : [];
  if (Array.isArray(merged.widgetOrder)) merged.widgetOrder = merged.widgetOrder.filter((id) => id !== 'prompt');
  delete merged.aiPrompt;
  if (!Array.isArray(merged.countdownTargets)) merged.countdownTargets = [];
  merged.clickThroughShortcut = normalizeClickThroughShortcut(merged.clickThroughShortcut) || DEFAULT_CLICK_THROUGH_SHORTCUT;
  return merged;
}
function saveConfig() {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(global.__cfg, null, 2));
  } catch (_) {}
}

function isClickThroughShortcutRegistered(shortcut) {
  if (!shortcut) return false;
  try { return !!globalShortcut.isRegistered(shortcut); } catch (_) { return false; }
}

function publishActiveClickThroughShortcut(shortcut) {
  activeClickThroughShortcut = shortcut || '';
  // 统一组件菜单在每次打开时读取这个运行时值；注册失败时不展示一个实际不可用的快捷键。
  global.__widgetlyClickThroughShortcut = activeClickThroughShortcut;
}

function disableAllClickThroughFromShortcut() {
  commonWidgetAdapter.disableAllClickThrough(saveConfig);
}

// 事务式注册：新快捷键失败时立刻恢复之前仍在工作的快捷键，避免一次错误设置
// 把用户唯一的穿透恢复手段也一起注销。Electron 被占用时只返回 false，不会抛异常。
function registerClickThroughShortcut(value) {
  const shortcut = normalizeClickThroughShortcut(value);
  if (!shortcut) {
    return { ok: false, code: 'invalid', message: '快捷键无效，请同时按至少一个 Ctrl、Alt、Shift 或 Win 键，再按字母、数字或功能键。' };
  }

  const previous = activeClickThroughShortcut;
  if (previous === shortcut && isClickThroughShortcutRegistered(shortcut)) {
    publishActiveClickThroughShortcut(shortcut);
    return { ok: true, shortcut, activeShortcut: shortcut };
  }

  if (previous) {
    try { globalShortcut.unregister(previous); } catch (_) {}
  }

  let registered = false;
  try {
    registered = globalShortcut.register(shortcut, disableAllClickThroughFromShortcut) === true
      && globalShortcut.isRegistered(shortcut) === true;
  } catch (_) {
    registered = false;
  }
  if (registered) {
    publishActiveClickThroughShortcut(shortcut);
    return { ok: true, shortcut, activeShortcut: shortcut };
  }

  try { if (globalShortcut.isRegistered(shortcut)) globalShortcut.unregister(shortcut); } catch (_) {}
  let restored = false;
  if (previous) {
    try {
      restored = globalShortcut.register(previous, disableAllClickThroughFromShortcut) === true
        && globalShortcut.isRegistered(previous) === true;
    } catch (_) {
      restored = false;
    }
  }
  publishActiveClickThroughShortcut(restored ? previous : '');
  return {
    ok: false,
    code: 'conflict',
    shortcut,
    activeShortcut: restored ? previous : '',
    restored,
    message: restored
      ? '快捷键注册失败，可能已被其他软件占用；原快捷键已恢复。'
      : '快捷键注册失败，且原快捷键未能恢复。请先使用系统托盘菜单解除鼠标穿透。',
  };
}

function clickThroughShortcutState(extra = {}) {
  const configuredShortcut = normalizeClickThroughShortcut(global.__cfg && global.__cfg.clickThroughShortcut)
    || DEFAULT_CLICK_THROUGH_SHORTCUT;
  const registered = isClickThroughShortcutRegistered(activeClickThroughShortcut);
  if (!registered && activeClickThroughShortcut) publishActiveClickThroughShortcut('');
  return {
    ok: registered,
    configuredShortcut,
    activeShortcut: registered ? activeClickThroughShortcut : '',
    registered,
    defaultShortcut: DEFAULT_CLICK_THROUGH_SHORTCUT,
    message: clickThroughShortcutError,
    ...extra,
  };
}

function saveClickThroughShortcut(value) {
  const shortcut = normalizeClickThroughShortcut(value);
  if (!shortcut) {
    clickThroughShortcutError = '快捷键无效，请同时按至少一个 Ctrl、Alt、Shift 或 Win 键，再按字母、数字或功能键。';
    return clickThroughShortcutState({ ok: false, code: 'invalid', message: clickThroughShortcutError });
  }
  const result = registerClickThroughShortcut(shortcut);
  if (!result.ok) {
    clickThroughShortcutError = result.message;
    return clickThroughShortcutState({ ...result, configuredShortcut: global.__cfg.clickThroughShortcut || DEFAULT_CLICK_THROUGH_SHORTCUT });
  }
  global.__cfg.clickThroughShortcut = shortcut;
  clickThroughShortcutError = '';
  saveConfig();
  return clickThroughShortcutState({ ok: true, code: 'saved', message: '快捷键已保存并生效。' });
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
function startupLaunchArguments() {
  // 打包版 exe 自带资源定位；开发版 Electron 则仍需要 APP_DIR 才能启动正确项目。
  const args = app.isPackaged ? [] : [APP_DIR];
  if (global.__cfg && global.__cfg.openManagerOnStart === false) args.push(BACKGROUND_START_ARGUMENT);
  return args;
}
function quoteWindowsArgument(value) {
  const text = String(value || '');
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}
function createStartupShortcut(exe, dir) {
  try {
    const lnk = path.join(startupFolder(), 'Widgetly.lnk');
    const q = (s) => String(s).replace(/'/g, "''");
    const args = startupLaunchArguments().map(quoteWindowsArgument).join(' ');
    const ps = `$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut('${q(lnk)}');$sc.TargetPath='${q(exe)}';$sc.Arguments='${q(args)}';$sc.WorkingDirectory='${q(dir)}';$sc.Save()`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (_) {}
}
function removeScheduledTask() {
  try { spawn('schtasks', ['/Delete', '/TN', 'Widgetly', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {}
}
function createScheduledTask(exe, dir) {
  try {
    const args = startupLaunchArguments().map(quoteWindowsArgument).join(' ');
    spawn('schtasks', ['/Create', '/TN', 'Widgetly', '/TR', `"${exe}"${args ? ` ${args}` : ''}`, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (_) {}
}
function applyAutostart() {
  try {
    const method = global.__cfg.autostartMethod || 'registry';
    const exe = process.execPath, dir = APP_DIR;
    const startupArgs = startupLaunchArguments().map(quoteWindowsArgument).join(' ');
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
      run('reg', ['add', runKey, '/v', 'Widgetly', '/t', 'REG_SZ', '/d', `"${exe}"${startupArgs ? ` ${startupArgs}` : ''}`, '/f']);
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
  let result = base;
  if (instance.widgetId === 'todo' && todoAdapter.SIZES) {
    const s = (instance.config && instance.config.size) || 'medium';
    if (todoAdapter.SIZES[s]) result = { w: todoAdapter.SIZES[s].w, h: todoAdapter.SIZES[s].h };
  }
  if (instance.widgetId === 'dock' && dockAdapter.LAYOUTS) {
    const l = (instance.config && instance.config.layout) || '4x2';
    if (dockAdapter.LAYOUTS[l]) result = { w: dockAdapter.LAYOUTS[l].w, h: dockAdapter.LAYOUTS[l].h };
  }
  if (instance.widgetId === 'launcher' && launcherAdapter.SIZES) {
    const s = (instance.config && instance.config.size) || 'medium';
    if (launcherAdapter.SIZES[s]) result = { w: launcherAdapter.SIZES[s].w, h: launcherAdapter.SIZES[s].h };
  }
  if (instance.widgetId === 'promptOptimizer' && promptAdapter.expectedSize) {
    result = promptAdapter.expectedSize(instance, result);
  }
  if (String(instance.widgetId).startsWith('countdown') && countdownAdapter.expectedSize) {
    result = countdownAdapter.expectedSize(instance, result);
  }
  return commonWidgetAdapter.expectedSize(instance, result);
}
const dragTimers = new Map();       // webContents.id -> timer
const dragSizes = new Map();        // webContents.id -> { w, h } 拖动锚定尺寸
const lastDragStart = new Map();    // webContents.id -> 时间戳
const dragCss = new Map();          // webContents.id -> {key, active} 拖动期间关闭毛玻璃
const dragCssPending = new Set();   // webContents.id 正在等待 insertCSS 返回
const dragDockHovers = new Map();   // webContents.id -> { dockId, since, ready, rect }
ipcMain.on('drag-start', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  const inst = findInstanceByWin(win);
  // 锁定位置：在共享拖动引擎统一拦截（所有组件通用，渲染进程无需各自判断）
  if (inst && ((inst.windowState && inst.windowState.locked) || (inst.config && inst.config.locked))) { logDrag(`start BLOCKED(已锁定) id=${id}`); return; }
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
      // 性能：逐帧 move 日志已移除（16ms 一次磁盘写入会拖慢拖动），仅保留 start/end
    }
    updateDockDropHover(id, inst, cur);
  }, 16);
  dragTimers.set(id, timer);
});
ipcMain.on('drag-end', (e, dropPoint) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const id = win.webContents.id;
  const hover = dragDockHovers.get(id);
  dragDockHovers.delete(id);
  if (hover) sendDockDropPreview(hover.dockId, { active: false });
  if (hover && !hover.ready) restoreDockHoverBounds(hover);
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
  tryAttachDraggedWidgetToDock(win, dropPoint, hover);
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

function dockWindowOverlap(sourceBounds, targetBounds) {
  if (!sourceBounds || !targetBounds) return 0;
  const left = Math.max(sourceBounds.x, targetBounds.x);
  const top = Math.max(sourceBounds.y, targetBounds.y);
  const right = Math.min(sourceBounds.x + sourceBounds.width, targetBounds.x + targetBounds.width);
  const bottom = Math.min(sourceBounds.y + sourceBounds.height, targetBounds.y + targetBounds.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const sourceArea = Math.max(1, sourceBounds.width * sourceBounds.height);
  return intersection / sourceArea;
}
function findDockAtPoint(child, point) {
  if (!child) return null;
  // 用“鼠标在坞内”+“被拖窗口和坞的覆盖面积”双重判定。
  // 桌面组件拖动时鼠标常停在组件边缘，单靠鼠标点会漏判，导致用户明明拖到坞上却无法加入。
  const sourceWin = widgetWins[child.id];
  const sourceBounds = sourceWin && !sourceWin.isDestroyed() ? sourceWin.getBounds() : null;
  const candidates = global.__cfg.instances.filter((item) => item && isComponentDock(item) && item.id !== child.id).map((item) => {
    if ((item.windowState && item.windowState.locked) || (item.config && item.config.locked)) return null;
    const targetWin = widgetWins[item.id];
    if (!targetWin || targetWin.isDestroyed()) return null;
    const bounds = targetWin.getBounds();
    const cursorInside = !!point && point.x >= bounds.x + 12 && point.x <= bounds.x + bounds.width - 12
      && point.y >= bounds.y + 12 && point.y <= bounds.y + bounds.height - 12;
    const overlap = dockWindowOverlap(sourceBounds, bounds);
    // 鼠标进入坞的有效区域或拖入组件已有可见覆盖时，均视为可投放目标。
    if (!cursorInside && overlap < .02) return null;
    return { item, score: (cursorInside ? 10 : 0) + overlap };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].item : null;
}
function dropRectAtPoint(dock, child, point) {
  const win = widgetWins[dock.id];
  if (!win || win.isDestroyed()) return dockPreferredRect(child.widgetId);
  const bounds = win.getBounds(); const base = dockPreferredRect(child.widgetId);
  return normalizeDockRect({
    ...base,
    x: (point.x - bounds.x) / Math.max(1, bounds.width) - base.w / 2,
    y: (point.y - bounds.y) / Math.max(1, bounds.height) - base.h / 2,
  }, base);
}
function dockPlacementPoint(dock, child, point) {
  const dockWin = dock && widgetWins[dock.id];
  if (!dockWin || dockWin.isDestroyed()) return point;
  const target = dockWin.getBounds();
  const cursorInside = point && point.x >= target.x && point.x <= target.x + target.width && point.y >= target.y && point.y <= target.y + target.height;
  if (cursorInside) return point;
  // 鼠标在被拖动组件边缘、但组件本体已经覆盖组件坞时，使用两者交集的中心作为投放点。
  const sourceWin = child && widgetWins[child.id];
  const source = sourceWin && !sourceWin.isDestroyed() ? sourceWin.getBounds() : null;
  if (!source) return point || { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const left = Math.max(source.x, target.x); const top = Math.max(source.y, target.y);
  const right = Math.min(source.x + source.width, target.x + target.width); const bottom = Math.min(source.y + source.height, target.y + target.height);
  if (right > left && bottom > top) return { x: (left + right) / 2, y: (top + bottom) / 2 };
  return point || { x: target.x + target.width / 2, y: target.y + target.height / 2 };
}
function sendDockDropPreview(dockId, data) {
  const win = widgetWins[dockId];
  if (!win || win.isDestroyed()) return;
  ipcMain.emit('componentDock:drop-preview:' + dockId, { sender: win.webContents }, data);
}
function restoreDockHoverBounds(hover) {
  if (!hover || !hover.originalBounds) return;
  const win = widgetWins[hover.dockId];
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds(); const original = hover.originalBounds;
  win.setBounds(original);
  const dock = global.__cfg.instances.find((item) => item && item.id === hover.dockId);
  if (dock) dock.windowState = { ...(dock.windowState || {}), windowSize: { width: original.width, height: original.height } };
  // 悬停预览取消后要把恢复后的尺寸也落盘；否则定时 resize 保存可能会把预览期的
  // 临时扩大尺寸写入配置，下一次启动时组件坞会无故变大。
  saveConfig();
  if (current.width !== original.width || current.height !== original.height) logDrag(`dock-preview restore ${hover.dockId} ${current.width}x${current.height} -> ${original.width}x${original.height}`);
}
const DOCK_HOVER_READY_MS = 260;   // 停留阈值：拖到组件坞上方停留 260ms 即开始实时推挤
const DOCK_HOVER_RESOLVE_MS = 50;  // 就绪后的连续推挤节流
function updateDockDropHover(sourceId, child, point) {
  if (!child || child.host || isComponentDock(child)) return;
  const dockable = isDockableWidgetId(child.widgetId);
  const dock = findDockAtPoint(child, point);
  const previous = dragDockHovers.get(sourceId);
  if (!dock) {
    if (previous) { sendDockDropPreview(previous.dockId, { active: false }); restoreDockHoverBounds(previous); }
    dragDockHovers.delete(sourceId); return;
  }
  if (!dockable) {
    // 不支持的组件：给“看得见”的明确反馈（一段拖拽只提示一次），不再无声无息。
    if (!previous || previous.dockId !== dock.id || previous.state !== 'rejected') {
      if (previous) { sendDockDropPreview(previous.dockId, { active: false }); restoreDockHoverBounds(previous); }
      dragDockHovers.set(sourceId, { dockId: dock.id, state: 'rejected', since: Date.now(), ready: false, rect: null, originalBounds: null });
      sendDockDropPreview(dock.id, { active: true, rejected: true, childName: (WIDGETS[child.widgetId] || {}).name || '此组件' });
    }
    return;
  }
  if (!previous || previous.dockId !== dock.id || previous.state !== 'hover') {
    if (previous) { sendDockDropPreview(previous.dockId, { active: false }); restoreDockHoverBounds(previous); }
    const rect = dropRectAtPoint(dock, child, dockPlacementPoint(dock, child, point));
    dragDockHovers.set(sourceId, { dockId: dock.id, state: 'hover', since: Date.now(), ready: false, rect, originalBounds: null, lastResolve: 0 });
    // 先给出“已识别到组件坞”的即时反馈；停留阈值后再真正挤开布局并允许松手加入。
    sendDockDropPreview(dock.id, { active: true, pending: true, childName: (WIDGETS[child.widgetId] || {}).name || '新组件', rect });
    return;
  }
  if (!previous.ready && Date.now() - previous.since < DOCK_HOVER_READY_MS) return;
  if (previous.ready && Date.now() - previous.lastResolve < DOCK_HOVER_RESOLVE_MS) return;
  const proposed = dropRectAtPoint(dock, child, dockPlacementPoint(dock, child, point));
  const resolved = resolveDockLayout(dock, `preview-${child.id}`, proposed, child.widgetId, 'external-drop');
  previous.lastResolve = Date.now();
  if (!previous.ready) {
    previous.ready = true;
    previous.originalBounds = widgetWins[dock.id] && !widgetWins[dock.id].isDestroyed() ? widgetWins[dock.id].getBounds() : null;
  }
  previous.rect = resolved.focus && resolved.focus.rect || proposed;
  const previewWin = widgetWins[dock.id];
  if (previewWin && !previewWin.isDestroyed()) growDockForLayout(dock, previewWin, resolved.layouts);
  sendDockDropPreview(dock.id, {
    active: true, childName: (WIDGETS[child.widgetId] || {}).name || '新组件', rect: previous.rect,
    layouts: resolved.layouts.map((item) => ({ id: item.id, rect: item.rect })),
  });
}
function tryAttachDraggedWidgetToDock(sourceWin, dropPoint, hover = null) {
  const child = findInstanceByWin(sourceWin);
  // 组件坞不能互相嵌套；已经被托管的组件也不能再次进入另一组件坞。
  if (!child || child.host || isComponentDock(child) || !isDockableWidgetId(child.widgetId)) return;
  // 真实拖动已经进入某个组件坞但尚未停留到预览阈值时，不执行误投放；
  // 没有 hover 会话时保留兼容路径，供旧组件或编辑器中的直接加入操作使用。
  if (hover && !hover.ready) return;
  const reported = dropPoint && typeof dropPoint === 'object' ? dropPoint : null;
  const point = screen.getCursorScreenPoint();
  const fallbackPoint = reported && Number.isFinite(Number(reported.x)) && Number.isFinite(Number(reported.y)) ? { x: Number(reported.x), y: Number(reported.y) } : null;
  const dock = hover && hover.ready ? global.__cfg.instances.find((item) => item && item.id === hover.dockId) : findDockAtPoint(child, point) || findDockAtPoint(child, fallbackPoint);
  if (!dock) return;
  const dockWin = widgetWins[dock.id];
  // 拖到组件坞内部即等同于编辑器中的“已有桌面组件 → 加入组件坞”。
  // 实际托管转换只在松手后发生，拖动过程绝不反复销毁或刷新组件。
  mutateComponentDock(dock, dockWin, {
    action: 'attach', childId: child.id,
    rect: hover && hover.rect || dropRectAtPoint(dock, child, dockPlacementPoint(dock, child, point)),
  }).then((result) => {
    // 例如组件坞已满、拖动过程中刚被锁定时，不能留下“预览放大”的临时尺寸。
    if ((!result || !result.ok) && hover) restoreDockHoverBounds(hover);
  }).catch(() => { if (hover) restoreDockHoverBounds(hover); });
}

// 仅供隔离的自动化回归使用：复用与真实拖动完全相同的“进入 → 停留 → 预留位 → 松开”路径，
// 不会被打进普通运行流程。这样可以避免仅测试 drag-end 而漏掉悬停识别的回归。
if (process.argv.includes('--widgetly-test-mode')) {
  ipcMain.handle('componentDock:test-hover', (event, point) => {
    const sourceWin = BrowserWindow.fromWebContents(event.sender);
    const child = findInstanceByWin(sourceWin);
    if (!sourceWin || !child) return { ok: false };
    const id = sourceWin.webContents.id;
    updateDockDropHover(id, child, point || screen.getCursorScreenPoint());
    const hover = dragDockHovers.get(id);
    return { ok: !!hover, ready: !!(hover && hover.ready), dockId: hover && hover.dockId };
  });
  // 批量驱动真实求解器（仅供隔离回归）：不写配置、不建窗口，返回纯布局结果。
  // scenarios: [{dockId, focusId, rect, virtualWidgetId, intent}, ...]
  ipcMain.handle('componentDock:test-resolve', (_event, scenarios) => {
    const results = [];
    for (const s of Array.isArray(scenarios) ? scenarios : []) {
      const dock = global.__cfg.instances.find((item) => item && item.id === s.dockId && isComponentDock(item));
      if (!dock) { results.push({ error: 'no-dock' }); continue; }
      try {
        const resolved = resolveDockLayout(dock, String(s.focusId || ''), s.rect, String(s.virtualWidgetId || ''), String(s.intent || ''));
        results.push({
          layouts: (resolved.layouts || []).map((item) => ({ id: item.id, rect: item.rect, compacted: !!item.compacted })),
          focus: resolved.focus ? { id: resolved.focus.id, rect: resolved.focus.rect, compacted: !!resolved.focus.compacted } : null,
          // 供测试按“最小尺寸钳制”规则复算期望值
          min: resolved.focus ? dockMinRelative(resolved.focus.widgetId, widgetWins[dock.id]) : null,
        });
      } catch (error) { results.push({ error: String((error && error.message) || error) }); }
    }
    return results;
  });
}

function disposeHostedDockChild(dockId, childId) {
  const runtime = componentDockRuntimes.get(dockId);
  if (!runtime) return;
  const dispose = runtime.childDisposers.get(childId);
  try { if (typeof dispose === 'function') dispose(); } catch (_) {}
  runtime.childDisposers.delete(childId);
  runtime.hosted.delete(childId);
  const cfgChannel = `cfg:${childId}`;
  const saveChannel = `cfg:save:${childId}`;
  ipcMain.removeHandler(cfgChannel);
  ipcMain.removeAllListeners(saveChannel);
}

async function mutateComponentDock(dock, win, payload = {}) {
  const action = String(payload.action || '');
  const slots = dockSlots(dock);
  const runtime = componentDockRuntimes.get(dock.id);
  const childAt = (id) => dockChildren(dock.id).find((item) => item.child.id === String(id || ''));
  const notify = (message = '', { render = true, layout = false, save = true } = {}) => {
    // 拖拽预览帧绝不写盘：一帧一次 saveConfig 会造成磁盘风暴，是挤压动画卡顿的根源之一。
    // 只在松手（child-rect）等关键动作落盘。
    if (save) saveConfig();
    if (runtime && runtime.controller && runtime.controller.notify) runtime.controller.notify(message, { render, layout });
  };
  if (action === 'layout') {
    const layout = String(payload.layout || 'free');
    if (!['free', 'smart', 'horizontal', 'vertical', 'grid', 'pages'].includes(layout)) return { ok: false, message: '不支持的布局方式' };
    dock.config.layout = layout; dock.config.page = 0;
    if (layout !== 'free') arrangeDockSlots(dock, layout);
    notify('已更新组件坞布局'); return { ok: true };
  }
  if (action === 'set') {
    const key = String(payload.key || '');
    if (key === 'backgroundTransparency') dock.config.backgroundTransparency = Math.max(0, Math.min(100, Number(payload.value) || 0));
    else if (key === 'gap') dock.config.gap = Math.max(0, Math.min(30, Number(payload.value) || 0));
    else if (key === 'padding') dock.config.padding = Math.max(0, Math.min(42, Number(payload.value) || 0));
    else if (key === 'style') dock.config.style = payload.value === 'flat' ? 'flat' : 'unified';
    else return { ok: false, message: '无法保存此设置' };
    notify(); return { ok: true };
  }
  if (action === 'page') {
    dock.config.page = Math.max(0, Math.floor(Number(payload.page) || 0)); notify(); return { ok: true };
  }
  if (action === 'add') {
    if (slots.length >= 12) return { ok: false, message: '一个组件坞最多放入 12 个组件，请使用分页或新建组件坞' };
    const child = createDockChild(dock, String(payload.widgetId || ''));
    if (!child) return { ok: false, message: '该组件暂不支持加入组件坞' };
    const resolved = resolveDockLayout(dock, child.id, payload.rect || dockPreferredRect(child.widgetId), '', payload.intent);
    persistDockLayout(dock, resolved.layouts);
    registerHostedStudioChild(dock, win, child);
    growDockForLayout(dock, win, resolved.layouts);
    notify(`已加入${(WIDGETS[child.widgetId] || {}).name || '组件'}`); return { ok: true };
  }
  if (action === 'attach') {
    if (slots.length >= 12) return { ok: false, message: '一个组件坞最多放入 12 个组件' };
    const child = global.__cfg.instances.find((item) => item && item.id === String(payload.childId || ''));
    if (!child || child.host || !isDockableWidgetId(child.widgetId)) return { ok: false, message: '此桌面组件暂时无法加入组件坞' };
    const oldWin = widgetWins[child.id];
    if (oldWin && !oldWin.isDestroyed()) {
      const bounds = oldWin.getBounds();
      child.lastStandalone = { x: bounds.x, y: bounds.y, windowSize: child.windowState && child.windowState.windowSize ? { ...child.windowState.windowSize } : null };
      try { oldWin.destroy(); } catch (_) {}
      delete widgetWins[child.id];
    } else child.lastStandalone = { x: child.x, y: child.y, windowSize: child.windowState && child.windowState.windowSize ? { ...child.windowState.windowSize } : null };
    child.host = { type: 'componentDock', dockId: dock.id };
    slots.push({ instanceId: child.id, slotId: `slot-${child.id}`, surface: 'inherit', hidden: false, rect: payload.rect || dockPreferredRect(child.widgetId), manual: false });
    const resolved = resolveDockLayout(dock, child.id, payload.rect || dockPreferredRect(child.widgetId), '', payload.intent);
    persistDockLayout(dock, resolved.layouts);
    registerHostedStudioChild(dock, win, child);
    growDockForLayout(dock, win, resolved.layouts);
    notify(`已将${(WIDGETS[child.widgetId] || {}).name || '组件'}加入组件坞`); return { ok: true };
  }
  if (action === 'move') {
    const index = slots.findIndex((slot) => slot && slot.instanceId === String(payload.childId || ''));
    const next = index + (Number(payload.by) < 0 ? -1 : 1);
    if (index < 0 || next < 0 || next >= slots.length) return { ok: false, message: '已经在边界位置' };
    [slots[index], slots[next]] = [slots[next], slots[index]];
    arrangeDockSlots(dock, dock.config.layout || 'smart');
    notify(); return { ok: true };
  }
  if (action === 'child-rect') {
    const pair = childAt(payload.childId);
    if (!pair) return { ok: false, message: '未找到此子组件' };
    if ((dock.windowState && dock.windowState.locked) || dock.config.locked) return { ok: false, message: '组件坞已锁定位置' };
    const resolved = resolveDockLayout(dock, pair.child.id, payload.rect, pair.child.widgetId, payload.intent);
    persistDockLayout(dock, resolved.layouts);
    pair.slot.manual = true;
    growDockForLayout(dock, win, resolved.layouts);
    applyDockMinimumSize(dock, win);
    shrinkDockToFit(dock, win);   // 松手后：边框收缩到“刚好包住内容”，子组件像素尺寸保持不变
    notify('', { render: false, layout: true });
    return { ok: true };
  }
  if (action === 'child-rect-preview') {
    const pair = childAt(payload.childId);
    if (!pair || (dock.windowState && dock.windowState.locked) || dock.config.locked) return { ok: false };
    // 预览阶段只改运行时布局并发送轻量位置消息：不写配置、不重建 iframe。
    // 松开鼠标时仍由 child-rect 统一落盘，确保“挤开其它组件”是连续动作而非事后闪现。
    const resolved = resolveDockLayout(dock, pair.child.id, payload.rect, pair.child.widgetId, payload.intent);
    persistDockLayout(dock, resolved.layouts);
    pair.slot.manual = true;
    growDockForLayout(dock, win, resolved.layouts);
    if (runtime && runtime.controller && runtime.controller.notify) runtime.controller.notify('', { render: false, layout: true });
    return { ok: true };
  }
  if (action === 'reflow') {
    arrangeDockSlots(dock, dock.config.layout || 'smart');
    growDockToFit(dock, win);
    applyDockMinimumSize(dock, win);
    shrinkDockToFit(dock, win);
    notify('已自动整理组件坞'); return { ok: true };
  }
  if (action === 'surface') {
    const pair = childAt(payload.childId);
    if (!pair) return { ok: false, message: '未找到此子组件' };
    pair.slot.surface = pair.slot.surface === 'card' ? 'inherit' : 'card'; notify(); return { ok: true };
  }
  if (action === 'childTransparency') {
    const pair = childAt(payload.childId);
    if (!pair) return { ok: false, message: '未找到此子组件' };
    const percent = Math.max(0, Math.min(100, Number(payload.value) || 0));
    pair.child.config = { ...(pair.child.config || {}), backgroundTransparency: percent, bgOpacity: 1 - percent / 100 };
    updateDockFrameConfig(win, pair.child.id, pair.child.config);
    notify('', { render: false }); return { ok: true };
  }
  if (action === 'detach') {
    const pair = childAt(payload.childId);
    if (!pair) return { ok: false, message: '未找到此子组件' };
    const child = pair.child;
    disposeHostedDockChild(dock.id, child.id);
    const index = slots.indexOf(pair.slot); if (index >= 0) slots.splice(index, 1);
    arrangeDockSlots(dock, dock.config.layout || 'smart');
    delete child.host;
    const last = child.lastStandalone || {};
    child.x = Number.isFinite(Number(last.x)) ? last.x : dock.x + 44;
    child.y = Number.isFinite(Number(last.y)) ? last.y : dock.y + 44;
    if (last.windowSize) child.windowState = { ...(child.windowState || {}), windowSize: { ...last.windowSize } };
    saveConfig();
    createWidgetWindow(child);
    notify('已移出组件坞，恢复为独立桌面组件'); return { ok: true };
  }
  if (action === 'remove') {
    const pair = childAt(payload.childId);
    if (!pair) return { ok: false, message: '未找到此子组件' };
    disposeHostedDockChild(dock.id, pair.child.id);
    const index = slots.indexOf(pair.slot); if (index >= 0) slots.splice(index, 1);
    arrangeDockSlots(dock, dock.config.layout || 'smart');
    global.__cfg.instances = global.__cfg.instances.filter((item) => item.id !== pair.child.id);
    notify('已从组件坞删除子组件'); return { ok: true };
  }
  if (action === 'dissolve') {
    const children = dockChildren(dock.id).map((item) => item.child);
    for (const child of children) {
      disposeHostedDockChild(dock.id, child.id);
      delete child.host;
      const last = child.lastStandalone || {};
      child.x = Number.isFinite(Number(last.x)) ? last.x : dock.x + 36;
      child.y = Number.isFinite(Number(last.y)) ? last.y : dock.y + 36;
      if (last.windowSize) child.windowState = { ...(child.windowState || {}), windowSize: { ...last.windowSize } };
    }
    global.__cfg.instances = global.__cfg.instances.filter((item) => item.id !== dock.id);
    saveConfig();
    if (!win.isDestroyed()) win.close();
    setTimeout(() => children.forEach((child) => createWidgetWindow(child)), 40);
    return { ok: true, message: '组件坞已解散，子组件已恢复到桌面' };
  }
  if (action === 'delete') {
    const result = await require('electron').dialog.showMessageBox(win, {
      type: 'warning', title: '删除组件坞', message: '确定删除组件坞及其所有子组件？',
      detail: '便签、闹钟、文件夹等子组件的数据也会被删除。若只想保留组件，请选择“解散组件坞”。',
      buttons: ['取消', '删除组件坞和全部组件'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return { ok: false, message: '已取消删除' };
    dockChildren(dock.id).forEach(({ child }) => disposeHostedDockChild(dock.id, child.id));
    const childIds = new Set(dockChildren(dock.id).map((item) => item.child.id));
    global.__cfg.instances = global.__cfg.instances.filter((item) => item.id !== dock.id && !childIds.has(item.id));
    saveConfig(); if (!win.isDestroyed()) win.close(); return { ok: true, message: '组件坞已删除' };
  }
  return { ok: false, message: '未识别的组件坞操作' };
}

function createWidgetWindow(instance) {
  if (instance && instance.host && instance.host.type === 'componentDock') return null;
  const wdef = WIDGETS[instance.widgetId];
  if (!wdef) return null;
  const initialSize = expectedSize(instance) || { w: wdef.w, h: wdef.h };
  const [ww, wh] = [initialSize.w, initialSize.h];

  const isPromptOptimizer = instance.widgetId === 'promptOptimizer';
  const isComponentDockWindow = instance.widgetId === 'componentDock';
  const win = new BrowserWindow({
    width: ww,
    height: wh,
    x: instance.x,
    y: instance.y,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: isPromptOptimizer ? {
      preload: path.join(APP_DIR, 'widgets', 'prompt', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Prompt Optimizer 的纯前端版本直接连接用户选择的 AI 服务商。
      // 仅此本地、无 Node 权限的窗口关闭 CORS 限制，避免影响其他组件。
      webSecurity: false,
      partition: 'persist:widgetly-prompt-optimizer',
      backgroundThrottling: true,
    } : {
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInSubFrames: isComponentDockWindow,
      // 闹钟与计时类组件在被其他窗口遮挡时也必须准点检查；其余组件保留 Chromium 节流以节省资源。
      backgroundThrottling: isComponentDockWindow ? false : !['alarmClock','durationTimer','simplePomodoro'].includes(instance.widgetId),
    },
  });
  widgetWins[instance.id] = win;
  if (isComponentDockWindow) componentDockRuntimes.set(instance.id, { dock: instance, win, hosted: new Set(), childDisposers: new Map(), cleanups: [], controller: null });
  if (isPromptOptimizer) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (/^https?:/i.test(url)) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });
  }
  // 显式 setBounds 精确化尺寸（构造函数在高 DPI 下会多 2px，文件夹组件靠此对齐）
  win.setBounds({ x: instance.x, y: instance.y, width: ww, height: wh });

  win.loadFile(path.join(APP_DIR, 'widgets', wdef.dir || instance.widgetId, wdef.entry), { query: { inst: instance.id, wid: instance.widgetId } });
  // 创建后立即放到所有窗口之下（不遮挡组件坞/其它软件）。
  // 注意：绝不能用 show:false + showInactive —— 会把透明窗口踢出屏幕合成导致组件不可见（坑）。
  pushWidgetToBack(win);
  if (managerWin && !managerWin.isDestroyed() && managerWin.isVisible()) managerWin.focus();
  win.webContents.on('did-finish-load', () => {
    // 刷新后再次压到最底层（组件重载会重新置顶，需重新压回）
    pushWidgetToBack(win);
    // 新增组件淡入（仅透明度，透明窗口安全；不影响各组件内部动画）
    try { win.webContents.insertCSS('html{animation:widgetlyIn .3s ease}@keyframes widgetlyIn{from{opacity:0}to{opacity:1}}'); } catch (_) {}
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
    // 独立设置页保存后，立即通知桌面上的组件刷新；组件自身的连续输入保存不回传，避免打断光标。
    if (!win.isDestroyed() && e.sender !== win.webContents) win.webContents.send(`cfg:updated:${instance.id}`, instance.config);
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
  if (String(instance.widgetId).startsWith('countdown')) countdownAdapter.setup({ instance, win, save: saveConfig });
  if (instance.widgetId === 'promptOptimizer') promptAdapter.setup({ instance, win, save: saveConfig });
  const isStudioWidget = studioAdapter.isStudioWidget(instance.widgetId);
  if (isStudioWidget) studioAdapter.setup({ instance, win, save: saveConfig });
  if (isComponentDockWindow) {
    const runtime = componentDockRuntimes.get(instance.id);
    runtime.controller = componentDockAdapter.setup({
      instance,
      win,
      getModel: () => dockModel(instance.id),
      command: (payload) => mutateComponentDock(instance, win, payload),
      openChildSettings: (childId) => {
        const child = dockChildren(instance.id).map((item) => item.child).find((item) => item.id === childId);
        if (!child) return;
        ipcMain.emit('studio:settings-open:' + child.id, { sender: win.webContents });
      },
    });
    setupHostedStudioChildren(instance, win);
  }
  // 统一控制层必须最后挂载：这样可以收拢旧组件已经注册的系统菜单，同时保留“组件专属设置”入口。
  commonWidgetAdapter.setup({ instance, win, wdef, save: saveConfig, pushToBack: pushWidgetToBack, studio: isStudioWidget || isComponentDockWindow });

  win.on('closed', () => {
    if (widgetWins[instance.id] === win) delete widgetWins[instance.id];
    if (isComponentDockWindow) {
      const runtime = componentDockRuntimes.get(instance.id);
      if (runtime) {
        runtime.childDisposers.forEach((dispose) => { try { if (typeof dispose === 'function') dispose(); } catch (_) {} });
        runtime.cleanups.forEach((cleanup) => { try { cleanup(); } catch (_) {} });
      }
      componentDockRuntimes.delete(instance.id);
    }
  });
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

// 管理器预览 iframe 没有真实实例适配器；提供纯示例数据，避免预览阶段产生“找不到 IPC”错误。
function previewWidgetId(event) {
  try { return new URL(event.senderFrame.url).searchParams.get('wid') || ''; } catch (_) { return ''; }
}
ipcMain.handle('cfg:preview', (event) => ({ ...(WIDGET_DEFAULTS[previewWidgetId(event)] || {}) }));
ipcMain.handle('launcher:init:preview', () => ({ state: 'idle', size: 'medium', veil: 60, port: 3080, dshPath: '', theme: 'light' }));
ipcMain.handle('gallery:init:preview', () => ({ folder: null, duration: 5, order: 'random', images: [path.join(APP_DIR, 'assets', 'icon.png')], locked: false }));
ipcMain.handle('todo:init:preview', () => ({
  today: new Date().toISOString().slice(0, 10), size: 'medium',
  appearance: { bg: 'white', bgOpacity: 40, fontColor: '#1e2832', fontSize: 12 },
  todos: [{ text: '背英语单词', done: false }, { text: '有氧训练', done: false }, { text: '写周报', done: true }],
}));
ipcMain.handle('memory:appearance-init:preview', () => ({ curveColor: '#ffd24a', barColor: '#a07fff', fontColor: '#f2eee6', bgMode: 'frosted', bgColor: '#191722' }));
ipcMain.handle('monitor:appearance-init:preview', () => ({ bgColor: '#3e3128', fontColor: '#f1e8d8', accentColor: '#f0a83a', bgOpacity: .78, glass: false }));

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
      count: global.__cfg.instances.filter(i => i.widgetId === w.id && !(i.host && i.host.type === 'componentDock')).length,
    })),
  };
});
ipcMain.on('widget-order:save', (_e, order) => {
  if (Array.isArray(order)) { global.__cfg.widgetOrder = order; saveConfig(); }
});
ipcMain.handle('instances-list', () => global.__cfg.instances.map(i => ({ ...i, widgetId: i.widgetId })));
// “我的小组件”只展示真正独立显示在桌面的实例。组件坞中的子组件由组件坞统一
// 管理，不应在这里重复计数或被单独删除。
ipcMain.handle('my-widgets-list', () => {
  const groups = new Map();
  global.__cfg.instances
    .filter((instance) => !(instance.host && instance.host.type === 'componentDock'))
    .forEach((instance) => {
      const widget = WIDGETS[instance.widgetId];
      if (!widget) return;
      if (!groups.has(widget.id)) groups.set(widget.id, { ...widget, instances: [] });
      groups.get(widget.id).instances.push({
        id: instance.id,
        widgetId: instance.widgetId,
        x: instance.x,
        y: instance.y,
      });
    });
  return [...groups.values()].map((group) => ({
    ...group,
    count: group.instances.length,
  }));
});
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
  // 新建组件坞时给出一套可立即使用的“时间中心”模板；三个子组件都是真实实例，
  // 可以在编辑器中替换、移出或解散，绝不只是预览图。
  if (widgetId === 'componentDock') {
    inst.config = { ...(WIDGET_DEFAULTS.componentDock || {}), children: [] };
    ['digitalClockGlass', 'miniCalendarGlass', 'lineWeather'].forEach((id) => createDockChild(inst, id));
  }
  saveConfig();
  createWidgetWindow(inst);
});
function removeWidgetInstance(id) {
  const instance = global.__cfg.instances.find((item) => item.id === id);
  if (!instance) return false;

  // 删除整个组件坞时，同时移除其托管的子组件，避免配置中遗留不可见实例。
  const ids = new Set([id]);
  if (instance.widgetId === 'componentDock') {
    global.__cfg.instances.forEach((item) => {
      if (item.host && item.host.type === 'componentDock' && item.host.dockId === id) ids.add(item.id);
    });
  }
  global.__cfg.instances = global.__cfg.instances.filter((item) => !ids.has(item.id));
  saveConfig();
  ids.forEach((instanceId) => destroyWidgetWindow(instanceId));
  return true;
}
ipcMain.handle('remove-widget:request', (_e, id) => ({ ok: removeWidgetInstance(id) }));
ipcMain.on('remove-widget', (_e, id) => {
  removeWidgetInstance(id);
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
  // 立即重写 Windows 启动项，确保下次登录使用正确的后台/前台参数，
  // 不给旧启动命令留下继续弹窗的机会。
  applyAutostart();
});
// ---------- 设置：关闭组件坞时最小化到托盘 ----------
ipcMain.handle('closeToTray:get', () => global.__cfg.closeToTray !== false);
ipcMain.on('closeToTray:save', (_e, v) => {
  global.__cfg.closeToTray = !!v;
  saveConfig();
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('closeToTray:changed', global.__cfg.closeToTray);
});
// ---------- 设置：全局解除鼠标穿透快捷键 ----------
ipcMain.handle('clickThroughShortcut:get', () => clickThroughShortcutState());
ipcMain.handle('clickThroughShortcut:save', (_e, value) => saveClickThroughShortcut(value));
ipcMain.handle('clickThroughShortcut:reset', () => saveClickThroughShortcut(DEFAULT_CLICK_THROUGH_SHORTCUT));
let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const settingsHeight = Math.min(710, wa.height);
  settingsWin = new BrowserWindow({
    width: 380, height: settingsHeight,
    x: wa.x + Math.max(0, Math.round((wa.width - 380) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - settingsHeight) / 2)),
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
    { label: '解除所有组件的鼠标穿透', click: () => commonWidgetAdapter.disableAllClickThrough(saveConfig) },
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
  startupConfigReady = true;
  // 立即落盘升级清理结果，确保被移除的 AI 提示词实例/API 配置不会继续残留在用户配置文件里。
  saveConfig();
  // Prompt Optimizer 的构建产物文件名偶尔不会随内部代码变化。
  // 清理的只是 HTTP/文件缓存，不会触碰该分区中的模型、API Key、历史记录或工作区数据。
  await session.fromPartition('persist:widgetly-prompt-optimizer').clearCache().catch(() => {});
  // 渲染进程/GPU/子进程异常不会总是触发主进程 uncaughtException，单独记录。
  app.on('render-process-gone', (_event, contents, details) => {
    if (isQuitting || (details && details.reason === 'clean-exit')) return;
    writeCrashLog('渲染进程异常退出', new Error(details && details.reason ? details.reason : '未知渲染进程异常'), `exitCode=${details && details.exitCode}; webContentsId=${contents && contents.id}`);
  });
  app.on('child-process-gone', (_event, details) => {
    if (isQuitting || (details && details.reason === 'clean-exit')) return;
    writeCrashLog('子进程异常退出', new Error(details && details.type ? details.type : '未知子进程异常'), `reason=${details && details.reason}; exitCode=${details && details.exitCode}`);
  });
  loadDesktopApi();              // 桌面层挂载 API（WorkerW）
  if (!IS_TEST_MODE) applyAutostart(); // 本地隔离测试不修改用户真实的 Windows 开机启动项
  initUpdater();                 // 在线更新（仅打包版生效）
  createTray();
  // 兼容旧版启动项：即使它还没来得及带上后台参数，只要用户关闭了该设置，
  // 首次启动也不创建组件坞；新版会在本次启动中自动重写为带标记的命令。
  if (global.__cfg.openManagerOnStart !== false) createManagerWindow();
  // 用户开启鼠标穿透后无法再直接右键组件；提供无需点中组件的安全解锁快捷键。
  const shortcutResult = registerClickThroughShortcut(global.__cfg.clickThroughShortcut || DEFAULT_CLICK_THROUGH_SHORTCUT);
  clickThroughShortcutError = shortcutResult.ok ? '' : shortcutResult.message;
  // 组件窗口错峰创建：同时创建 21 个渲染进程会引发 CPU 风暴（开机 2 分钟卡顿主因），
  // 每个间隔 120ms，既平滑 CPU 峰值，又让主界面先出来可交互
  global.__cfg.instances.forEach((inst, i) => {
    setTimeout(() => { if (!widgetWins[inst.id]) createWidgetWindow(inst); }, i * 120);
  });
  setTimeout(() => applyPinMode(), Math.max(500, global.__cfg.instances.length * 120 + 300));
  // 等管理器与错峰组件均有机会创建后，清除“启动中”标记。
  setTimeout(markStartupHealthy, Math.max(3000, global.__cfg.instances.length * 120 + 1500));
  // 在配置加载前抵达的第二次启动请求，可能来自 Windows 登录阶段的重复唤醒。
  // 只有明确的前台请求才打开组件坞；后台请求永远不弹窗。
  const queuedRequests = pendingSecondInstanceRequests.splice(0);
  queuedRequests.forEach((commandLine) => handleSecondInstance(commandLine));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createManagerWindow(); });
});

// 管理器关窗不退出（托盘常驻）；显式退出才退
app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
app.on('before-quit', () => { isQuitting = true; try { globalShortcut.unregisterAll(); } catch (_) {} if (!IS_TEST_MODE) markStartupHealthy(); });
