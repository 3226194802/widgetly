// 今日待办组件 —— Widgetly 主进程适配层
// 主组件/设置窗口用 HTML 自定义菜单（无竞态）；外观独立窗口；应用待办日期窗口；每日待办
const { ipcMain, screen, BrowserWindow } = require('electron');
const path = require('path');

const DEFAULTS = {
  todos: {},
  appearance: { bg: 'white', bgOpacity: 40, fontColor: '#1e2832', fontSize: 12 },
  size: 'medium',
  locked: false,
};
const SIZES = {
  medium: { w: 280, h: 180, label: '中号' },
  large: { w: 280, h: 280, label: '大号' },
  xlarge: { w: 342, h: 500, label: '超大号' },
};

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayKey() { return dateKey(new Date()); }
function labelFor(i, d) {
  if (i === 0) return '今日待办';
  if (i === 1) return '明日待办';
  return `${d.getMonth() + 1}月${d.getDate()}日待办`;
}
function nextDays(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    out.push({ key: dateKey(d), label: labelFor(i, d) });
  }
  return out;
}

function setup({ instance, win, save }) {
  const instId = instance.id;

  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let todos = (saved.todos && typeof saved.todos === 'object') ? JSON.parse(JSON.stringify(saved.todos)) : {};
  let appearance = { ...DEFAULTS.appearance, ...(saved.appearance || {}) };
  let size = SIZES[saved.size] ? saved.size : 'medium';
  let locked = !!saved.locked;
  let settingsWin = null;
  let applyWin = null;
  let appearanceWin = null;
  let menuWin = null;
  let menuGen = 0;
  let applyTodoText = '';
  let applyDayMode = false;

  function persist() {
    instance.config = { todos, appearance, size, locked };
    save();
  }
  function toggleLock() {
    locked = !locked;
    persist();
  }

  if (size !== 'medium') {
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: SIZES[size].w, height: SIZES[size].h });
  }

  function dayView(date) {
    const daily = todos['*'] || [];
    return [
      ...daily.map((t) => ({ ...t, daily: true })),
      ...(todos[date] || []).map((t) => ({ ...t, daily: false })),
    ];
  }
  function getDays() {
    return nextDays(8).map((d) => ({ ...d, todos: dayView(d.key) }));
  }
  function toggleTodo(date, index) {
    const daily = todos['*'] || [];
    if (index < daily.length) { daily[index].done = !daily[index].done; todos['*'] = daily; }
    else { const l = todos[date] || []; const i = index - daily.length; if (l[i]) { l[i].done = !l[i].done; todos[date] = l; } }
    persist(); notifyAll();
  }
  function removeTodo(date, index) {
    const daily = todos['*'] || [];
    if (index < daily.length) { todos['*'] = daily.filter((_, x) => x !== index); }
    else { const i = index - daily.length; todos[date] = (todos[date] || []).filter((_, x) => x !== i); }
    persist(); notifyAll();
  }
  function addTodo(date, text) {
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return;
    if (!todos[date]) todos[date] = [];
    todos[date].push({ text: t, done: false });
    persist(); notifyAll();
  }
  function copyTodos(target, source) {
    if (!target || !source || target === source) return;
    // 覆盖目标日期的待办（而非追加）
    todos[target] = (todos[source] || []).map((t) => ({ text: t.text, done: false }));
    persist(); notifyAll();
  }
  function applyTodoToDates(text, dates, allDays) {
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return;
    if (allDays) {
      if (!todos['*']) todos['*'] = [];
      todos['*'].push({ text: t, done: false });
    }
    (dates || []).forEach((d) => {
      if (!todos[d]) todos[d] = [];
      todos[d].push({ text: t, done: false });
    });
    persist(); notifyAll();
  }
  // 应用「今日全部待办」到所选日期（边缘空白右键菜单的「应用此待办日期」）
  function applyTodayToDates(dates, allDays) {
    const list = dayView(todayKey()).filter((t) => !t.daily);
    if (!list.length) return;
    const texts = list.map((t) => t.text);
    (dates || []).forEach((d) => {
      if (!todos[d]) todos[d] = [];
      texts.forEach((tx) => todos[d].push({ text: tx, done: false }));
    });
    if (allDays) {
      if (!todos['*']) todos['*'] = [];
      texts.forEach((tx) => todos['*'].push({ text: tx, done: false }));
    }
    persist(); notifyAll();
  }
  function setAppearance(a) {
    appearance = { ...appearance, ...a };
    persist();
    notifyMain();
  }
  function setSize(s) {
    if (!SIZES[s] || s === size) return;
    size = s;
    persist();
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: SIZES[s].w, height: SIZES[s].h });
    notifyMain();
  }

  function notifyMain() {
    if (!win || win.isDestroyed()) return;
    const tk = todayKey();
    win.webContents.send('todo:changed:' + instId, { today: tk, todos: dayView(tk), appearance, size });
  }
  function notifySettings() {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('todo:settings-refresh:' + instId, getDays());
    }
  }
  function notifyAll() { notifyMain(); notifySettings(); }

  function centerWin(sw, sh) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + Math.max(0, Math.round((wa.width - sw) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - sh) / 2)) };
  }

  // ---------- 设置每日待办大窗口 ----------
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const p = centerWin(830, 650);
    settingsWin = new BrowserWindow({
      width: 830, height: 650, x: p.x, y: p.y,
      frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, backgroundColor: '#eef0f3',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  // ---------- 外观设置独立窗口（280×300，约大号大小） ----------
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    const p = centerWin(280, 300);
    appearanceWin = new BrowserWindow({
      width: 280, height: 300, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }

  // ---------- 应用待办日期窗口 ----------
  function openApplyWindow(index) {
    if (applyWin && !applyWin.isDestroyed()) { applyWin.focus(); return; }
    const view = dayView(todayKey());
    const todo = view[index];
    if (!todo) return;
    applyTodoText = todo.text;
    applyDayMode = false;
    const p = centerWin(280, 340);
    applyWin = new BrowserWindow({
      width: 280, height: 340, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    applyWin.loadFile(path.join(__dirname, 'apply.html'), { query: { inst: instId } });
    applyWin.on('closed', () => { applyWin = null; });
  }
  // 应用「今日全部待办」到其它日期（空白右键菜单）
  function openApplyDayWindow() {
    if (applyWin && !applyWin.isDestroyed()) { applyWin.focus(); return; }
    applyTodoText = '';
    applyDayMode = true;
    const p = centerWin(280, 340);
    applyWin = new BrowserWindow({
      width: 280, height: 340, x: p.x, y: p.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    applyWin.loadFile(path.join(__dirname, 'apply.html'), { query: { inst: instId } });
    applyWin.on('closed', () => { applyWin = null; });
  }

  function quitWidget() {
    closeMenu();
    global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
    save();
    win.close();
  }

  // ---------- 浮动右键菜单（独立小窗口，跟随鼠标，不被组件边界裁剪） ----------
  function closeMenu() {
    if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    menuWin = null;
  }
  function openMenu(items) {
    if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    const gen = ++menuGen;
    const cur = screen.getCursorScreenPoint();
    const win = new BrowserWindow({
      width: 220, height: 80,
      x: cur.x, y: cur.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    menuWin = win;
    win.on('closed', () => { if (menuGen === gen) menuWin = null; });
    win.on('blur', () => { if (menuGen === gen) closeMenu(); });
    win.webContents.on('did-finish-load', () => {
      if (menuGen !== gen || win.isDestroyed()) return;
      win.webContents.send('todo:menu-items:' + instId, { gen, items });
    });
    win.loadFile(path.join(__dirname, 'menu.html'), { query: { inst: instId } });
  }
  // 菜单请求：from:'main'（主组件）/ from:'settings'（设置窗口）
  ipcMain.on('todo:menu:' + instId, (_e, ctx) => {
    if (!ctx) return;
    const items = [];
    if (ctx.from === 'settings' || ctx.from === 'settings-btn') {
      items.push({ kind: 'head', label: '从哪一天复制' });
      getDays().filter((d) => d.key !== ctx.date).forEach((d) => {
        items.push({ label: '从「' + d.label + '」复制', action: 'settings-copy', payload: { target: ctx.date, source: d.key } });
      });
      if (ctx.from === 'settings') {
        items.push({ kind: 'sep' });
        items.push({ label: '删除该待办', action: 'settings-remove', payload: { date: ctx.date, index: ctx.index }, danger: true });
      }
    } else if (ctx.type === 'todo') {
      // 点击单个事项：只显示「删除该待办」
      items.push({ label: '删除该待办', action: 'remove', payload: ctx.index, danger: true });
    } else {
      // 点击空白/边缘：外观 + 设置每日待办 + 应用此待办日期 + 尺寸 + 锁定 + 退出
      items.push({ label: '外观设置…', action: 'appearance-open' });
      items.push({ label: '设置每日待办…', action: 'settings-open' });
      items.push({ label: '应用此待办日期…', action: 'apply-day-open' });
      items.push({ kind: 'sep' });
      items.push({ kind: 'head', label: '窗口尺寸' });
      Object.keys(SIZES).forEach((s) => {
        items.push({ label: SIZES[s].label + (size === s ? '（当前）' : ''), action: 'size', payload: s });
      });
      items.push({ kind: 'sep' });
      items.push({ label: '锁定位置' + (locked ? '（已锁定）' : ''), action: 'lock' });
      items.push({ kind: 'sep' });
      items.push({ label: '退出此组件', action: 'quit' });
    }
    openMenu(items);
  });
  // 菜单内容渲染完成 → 按内容尺寸定位（避开屏幕边缘）后显示
  ipcMain.on('todo:menu-ready:' + instId, (_e, { gen, w, h }) => {
    if (gen !== menuGen) return;
    const win = menuWin;
    if (!win || win.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cur).workArea;
    const mw = Math.max(120, Math.min(340, w || 190));
    const mh = Math.max(40, Math.min(560, h || 80));
    let x = cur.x, y = cur.y;
    if (x + mw > wa.x + wa.width) x = wa.x + wa.width - mw - 6;
    if (y + mh > wa.y + wa.height) y = wa.y + wa.height - mh - 6;
    x = Math.max(wa.x + 2, x); y = Math.max(wa.y + 2, y);
    win.setBounds({ x, y, width: mw, height: mh });
    win.show();
    win.focus();
  });
  // 菜单项点击 → 分发动作
  ipcMain.on('todo:menu-click:' + instId, (_e, cmd) => {
    closeMenu();
    if (!cmd || !cmd.action) return;
    const p = cmd.payload;
    if (cmd.action === 'appearance-open') openAppearance();
    else if (cmd.action === 'settings-open') openSettings();
    else if (cmd.action === 'size') setSize(p);
    else if (cmd.action === 'apply-open') openApplyWindow(p);
    else if (cmd.action === 'apply-day-open') openApplyDayWindow();
    else if (cmd.action === 'remove') removeTodo(todayKey(), p);
    else if (cmd.action === 'lock') toggleLock();
    else if (cmd.action === 'quit') quitWidget();
    else if (cmd.action === 'settings-copy') copyTodos(p.target, p.source);
    else if (cmd.action === 'settings-remove') removeTodo(p.date, p.index);
  });
  ipcMain.on('todo:menu-close:' + instId, closeMenu);

  // ---------- 主组件 IPC（菜单走独立浮动窗口，无竞态） ----------
  ipcMain.handle('todo:init:' + instId, () => {
    const tk = todayKey();
    return { today: tk, todos: dayView(tk), appearance, size };
  });
  ipcMain.on('todo:add:' + instId, (_e, { date, text }) => { if (date) addTodo(date, text); });
  ipcMain.on('todo:toggle:' + instId, (_e, { date, index }) => { if (date && typeof index === 'number') toggleTodo(date, index); });
  ipcMain.on('todo:remove:' + instId, (_e, { date, index }) => { if (date && typeof index === 'number') removeTodo(date, index); });
  ipcMain.on('todo:appearance:' + instId, (_e, a) => { if (a) setAppearance(a); });
  ipcMain.on('todo:size:' + instId, (_e, s) => setSize(s));
  ipcMain.on('todo:settings-open:' + instId, openSettings);
  ipcMain.on('todo:appearance-open:' + instId, openAppearance);
  ipcMain.on('todo:apply-open:' + instId, (_e, index) => openApplyWindow(index));
  ipcMain.on('todo:quit:' + instId, quitWidget);

  // 外观窗口：滑动透明度时窗口透明（实时看组件外观），松手恢复
  ipcMain.on('todo:appearance-slide-start:' + instId, () => {
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.setOpacity(0.04);
  });
  ipcMain.on('todo:appearance-slide-end:' + instId, () => {
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.setOpacity(1);
  });

  // ---------- 设置窗口 IPC ----------
  ipcMain.handle('todo:settings-init:' + instId, () => ({ days: getDays() }));
  ipcMain.on('todo:settings-copy:' + instId, (_e, { target, source }) => copyTodos(target, source));
  ipcMain.on('todo:settings-close:' + instId, () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

  // ---------- 外观窗口 IPC ----------
  ipcMain.handle('todo:appearance-init:' + instId, () => appearance);
  ipcMain.on('todo:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });

  // ---------- 应用日期窗口 IPC ----------
  ipcMain.handle('todo:apply-init:' + instId, () => ({ text: applyTodoText, dayMode: applyDayMode, days: nextDays(8) }));
  ipcMain.on('todo:apply-confirm:' + instId, (_e, { dates, allDays }) => {
    if (applyDayMode) applyTodayToDates(dates || [], !!allDays);
    else applyTodoToDates(applyTodoText, dates || [], !!allDays);
    if (applyWin && !applyWin.isDestroyed()) applyWin.close();
  });
  ipcMain.on('todo:apply-close:' + instId, () => { if (applyWin && !applyWin.isDestroyed()) applyWin.close(); });

  win.webContents.on('did-finish-load', () => notifyMain());
}

module.exports = { setup, SIZES };
