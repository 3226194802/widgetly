// 番茄时钟组件 —— Widgetly 主进程适配层
// 计时状态机放主进程（时间戳 + 250ms 心跳，窗口重载/未聚焦计时不中断）；渲染进程只负责显示与交互
const { ipcMain, Menu, BrowserWindow, screen, Notification } = require('electron');
const path = require('path');

const DEFAULTS = {
  tasks: [],            // [{id, text, done, count}]
  settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4, autoNext: false, sound: true },
  pinned: false,
  locked: false,
  bgOpacity: 0.4,       // 罩层不透明度（默认背景透明度 60%）
  state: { phase: 'idle', running: false, endAt: 0, round: 0, taskId: null, remainMs: 0 },
  today: { key: '', count: 0 },
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
let uid = Date.now() % 100000;
function nextId() { return 't' + (++uid); }

function setup({ instance, win, save }) {
  const instId = instance.id;
  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  let settings = { ...DEFAULTS.settings, ...(saved.settings || {}) };
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  let bgOpacity = (typeof saved.bgOpacity === 'number' && saved.bgOpacity >= 0 && saved.bgOpacity <= 1) ? saved.bgOpacity : DEFAULTS.bgOpacity;
  let today = { ...DEFAULTS.today, ...(saved.today || {}) };
  let state = { ...DEFAULTS.state, ...(saved.state || {}) };
  let selectedTaskId = (tasks.find(t => t.id === state.taskId) ? state.taskId : null);
  let addWin = null, settingsWin = null, tickTimer = null;

  if (today.key !== todayKey()) today = { key: todayKey(), count: 0 };

  // ---------- 持久化 / 推送 ----------
  function persist() {
    instance.config = { tasks, settings, pinned, locked, bgOpacity, state, today };
    save();
  }
  function push() {
    if (win && !win.isDestroyed()) {
      const remain = state.running ? Math.max(0, state.endAt - Date.now()) : (state.remainMs || 0);
      win.webContents.send('pomodoro:state:' + instId, {
        tasks, settings, today, locked, bgOpacity, selectedTaskId,
        state: { ...state, remain },
      });
    }
  }
  function pushTick() {
    if (!win || win.isDestroyed() || !state.running) return;
    win.webContents.send('pomodoro:tick:' + instId, {
      remain: Math.max(0, state.endAt - Date.now()), phase: state.phase,
      total: state.totalMs || 0,
    });
  }

  // ---------- 计时状态机 ----------
  function durationMs(phase) {
    if (phase === 'focus') return settings.focusMin * 60000;
    const isLong = settings.longBreakEvery > 0 && state.round > 0 && state.round % settings.longBreakEvery === 0;
    return (isLong ? settings.longBreakMin : settings.shortBreakMin) * 60000;
  }
  function begin(phase) {
    state.phase = phase;
    state.totalMs = durationMs(phase);
    state.remainMs = state.totalMs;
    state.endAt = Date.now() + state.remainMs;
    state.running = true;
  }
  function complete() {
    if (state.phase === 'focus') {
      const t = tasks.find(x => x.id === state.taskId);
      if (t) t.count = (t.count || 0) + 1;
      today.count++;
      state.round++;
      const isLong = settings.longBreakEvery > 0 && state.round % settings.longBreakEvery === 0;
      const bm = isLong ? settings.longBreakMin : settings.shortBreakMin;
      notify('专注完成！', isLong ? `长休息 ${bm} 分钟` : `休息 ${bm} 分钟`);
      bell('focus');
      begin('break');
    } else {
      notify('休息结束', '开始新一轮专注吧');
      bell('break');
      if (settings.autoNext && state.taskId && tasks.some(t => t.id === state.taskId)) {
        begin('focus');
      } else {
        state.phase = 'idle'; state.running = false; state.endAt = 0; state.remainMs = 0;
      }
    }
    persist();
    push();
  }
  function start(taskId) {
    const t = tasks.find(x => x.id === taskId);
    if (!t) return;
    state.taskId = taskId;
    begin('focus');
    persist(); push();
  }
  function pause() {
    if (!state.running) return;
    state.remainMs = Math.max(0, state.endAt - Date.now());
    state.running = false; state.endAt = 0;
    persist(); push();
  }
  function resume() {
    if (state.phase === 'idle' || state.running) return;
    state.running = true;
    state.endAt = Date.now() + Math.max(1000, state.remainMs);
    persist(); push();
  }
  function reset() {
    state.phase = 'idle'; state.running = false; state.endAt = 0; state.remainMs = 0;
    persist(); push();
  }
  function skipBreak() {
    if (state.phase !== 'break') return;
    if (settings.autoNext && state.taskId && tasks.some(t => t.id === state.taskId)) begin('focus');
    else { state.phase = 'idle'; state.running = false; state.endAt = 0; state.remainMs = 0; }
    persist(); push();
  }
  function notify(title, body) {
    try { new Notification({ title, body, silent: true }).show(); } catch (_) {}
  }
  function bell(type) {
    if (!settings.sound) return;
    if (win && !win.isDestroyed()) win.webContents.send('pomodoro:bell:' + instId, type);
  }

  function ensureTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (!state.running) return;
      pushTick();
      if (Date.now() >= state.endAt) complete();
    }, 250);
  }

  // 重启续跑：若保存时正在倒计时且未过期，直接恢复；已过期则补完成
  if (state.running) {
    if (Date.now() >= state.endAt) complete();
    else ensureTicker();
  } else {
    state.endAt = 0;
  }

  // ---------- 事项操作 ----------
  function addTask(text) {
    const t = String(text || '').trim().slice(0, 60);
    if (!t) return false;
    tasks.push({ id: nextId(), text: t, done: false, count: 0 });
    persist(); push();
    return true;
  }
  function toggleDone(taskId) {
    const t = tasks.find(x => x.id === taskId);
    if (!t) return;
    t.done = !t.done;
    persist(); push();
  }
  function selectTask(taskId) {
    if (tasks.some(x => x.id === taskId)) selectedTaskId = taskId;
    persist(); push();
  }
  function deleteTask(taskId) {
    tasks = tasks.filter(x => x.id !== taskId);
    if (selectedTaskId === taskId) selectedTaskId = null;
    if (state.taskId === taskId) { state.taskId = null; }
    persist(); push();
  }
  function deleteSelected() { if (selectedTaskId) deleteTask(selectedTaskId); }

  // ---------- 置顶 / 锁定 / 退出 ----------
  function togglePin() {
    pinned = !pinned;
    win.setAlwaysOnTop(pinned, 'floating');
    persist();
  }
  function toggleLock() {
    locked = !locked;
    persist();
  }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter(i => i.id !== instId);
    save();
    win.close();
  }

  // ---------- 右键菜单 ----------
  function openMenu() {
    if (!win.isFocused()) win.focus();
    try {
      const hasTask = !!tasks.find(t => t.id === state.taskId);
      const items = [];
      if (state.phase === 'focus') {
        items.push({ label: state.running ? '暂停' : '继续', click: () => (state.running ? pause() : resume()) });
        items.push({ label: '重置计时', click: reset });
      } else if (state.phase === 'break') {
        items.push({ label: '跳过休息', click: skipBreak });
        items.push({ label: '重置计时', click: reset });
      } else {
        items.push({ label: '开始专注', enabled: hasTask, click: () => start(state.taskId) });
      }
      items.push({ type: 'separator' });
      items.push({ label: '添加事项…', click: openAdd });
      items.push({ label: '删除选中事项', enabled: !!selectedTaskId, click: deleteSelected });
      items.push({ type: 'separator' });
      items.push({ label: '设置…', click: openSettings });
      items.push({ type: 'separator' });
      items.push({ label: '背景透明度…', click: () => win.webContents.send('show-opacity-panel:' + instId) });
      items.push({ label: '置顶显示', type: 'checkbox', checked: pinned, click: togglePin });
      items.push({ label: '锁定位置', type: 'checkbox', checked: locked, click: toggleLock });
      items.push({ type: 'separator' });
      items.push({ label: '退出此组件', click: quitWidget });
      Menu.buildFromTemplate(items).popup({ window: win });
    } catch (_) {}
  }

  // ---------- 添加事项浮层 ----------
  function openAdd() {
    if (addWin && !addWin.isDestroyed()) { addWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const p = { x: wa.x + Math.max(0, Math.round((wa.width - 280) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 170) / 2)) };
    addWin = new BrowserWindow({
      width: 280, height: 170, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    addWin.loadFile(path.join(__dirname, 'add.html'), { query: { inst: instId } });
    addWin.on('closed', () => { addWin = null; });
  }

  // ---------- 设置窗口 ----------
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    const p = { x: wa.x + Math.max(0, Math.round((wa.width - 300) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 330) / 2)) };
    settingsWin = new BrowserWindow({
      width: 300, height: 330, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  // ---------- IPC ----------
  ipcMain.on('pomodoro:action:' + instId, (_e, cmd) => {
    if (!cmd) return;
    if (cmd.type === 'start' && cmd.taskId) start(cmd.taskId);
    else if (cmd.type === 'pause') pause();
    else if (cmd.type === 'resume') resume();
    else if (cmd.type === 'reset') reset();
    else if (cmd.type === 'skip') skipBreak();
    else if (cmd.type === 'toggleDone' && cmd.taskId) toggleDone(cmd.taskId);
    else if (cmd.type === 'select' && cmd.taskId) selectTask(cmd.taskId);
    else if (cmd.type === 'delete' && cmd.taskId) deleteTask(cmd.taskId);
  });
  ipcMain.on('pomodoro:add:' + instId, (_e, d) => { if (addTask(d && d.text) && addWin && !addWin.isDestroyed()) addWin.close(); });
  ipcMain.on('pomodoro:add-close:' + instId, () => { if (addWin && !addWin.isDestroyed()) addWin.close(); });
  ipcMain.on('pomodoro:settings:' + instId, (_e, s) => {
    if (s && typeof s === 'object') {
      settings = { ...settings, ...s };
      persist(); push();
    }
  });
  ipcMain.on('pomodoro:settings-close:' + instId, () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
  ipcMain.handle('pomodoro:settings-init:' + instId, () => settings);
  ipcMain.on('pomodoro:menu:' + instId, openMenu);
  ipcMain.on('pomodoro:quit:' + instId, quitWidget);
  ipcMain.on('pomodoro:add-open:' + instId, openAdd);
  ipcMain.on('pomodoro:settings-open:' + instId, openSettings);
  ipcMain.on('save-bg-opacity:' + instId, (_e, v) => {
    if (typeof v === 'number' && v >= 0 && v <= 1) {
      bgOpacity = v;
      persist();
      push();
    }
  });
  ipcMain.on('pomodoro:opacity-panel:' + instId, () => {
    if (win && !win.isDestroyed()) win.webContents.send('show-opacity-panel:' + instId);
  });

  win.webContents.on('context-menu', openMenu);
  win.webContents.on('did-finish-load', () => {
    ensureTicker();
    push();
  });
  win.on('closed', () => {
    if (tickTimer) clearInterval(tickTimer);
    if (addWin && !addWin.isDestroyed()) addWin.close();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });

  if (pinned) win.setAlwaysOnTop(true, 'floating');
  ensureTicker();
}

module.exports = { setup };
