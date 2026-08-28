// 倒数日组件族 —— 单目标 / 三目标共享目标日期库
// 目标日期保存在 global.__cfg.countdownTargets；每个实例只保存自己的显示选择和外观。
const { ipcMain, BrowserWindow, screen } = require('electron');
const path = require('path');

const controllers = new Set();
const PALETTE = ['#319fe8', '#ff9f2e', '#8b74e8', '#27b58a', '#ef6d86', '#576de8'];
const DEFAULT_STYLE = {
  bgOpacity: 0.2, // 80% 透明
  bgColor: '#f7fbff',
  textColor: '#142033',
  accentColor: '#319fe8',
  secondaryColor: '#ff9f2e',
  pinned: false,
  locked: false,
};
// 这两个组件使用容器尺寸驱动排版，允许继续缩小而不裁切内容。
const MIN_SIZE = { w: 160, h: 166 };
const MAX_SIZE = { w: 520, h: 540 };

function clamp(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function color(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}
function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const [y, m, day] = v.split('-').map(Number);
  return d.getFullYear() === y && d.getMonth() + 1 === m && d.getDate() === day;
}
function newId(i = 0) {
  return `date-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`;
}
function normalizeTargets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.slice(0, 60).forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const name = String(item.name || '').trim().slice(0, 36);
    const date = String(item.date || '').trim();
    if (!name || !validDate(date)) return;
    let id = typeof item.id === 'string' && /^[a-z0-9_-]{3,80}$/i.test(item.id) ? item.id : newId(i);
    if (seen.has(id)) id = newId(i);
    seen.add(id);
    out.push({ id, name, date, color: color(item.color, PALETTE[i % PALETTE.length]) });
  });
  return out;
}
function allTargets() {
  if (!global.__cfg) return [];
  const normalized = normalizeTargets(global.__cfg.countdownTargets);
  global.__cfg.countdownTargets = normalized;
  return normalized;
}
function broadcast() {
  controllers.forEach((c) => c.pushState());
}

function expectedSize(instance, base) {
  const fallback = base || { w: 250, h: 260 };
  const cfg = instance && instance.config ? instance.config : {};
  return {
    w: Math.round(clamp(cfg.width, MIN_SIZE.w, MAX_SIZE.w, fallback.w)),
    h: Math.round(clamp(cfg.height, MIN_SIZE.h, MAX_SIZE.h, fallback.h)),
  };
}

function setup({ instance, win, save }) {
  const instId = instance.id;
  const variant = instance.widgetId === 'countdownTriple' ? 'triple' : 'single';
  let menuWin = null;
  let menuGen = 0;
  let settingsWin = null;
  let appearanceWin = null;
  const listeners = [];
  const handlers = [];
  let resizeSaveTimer = null;

  instance.config = instance.config || {};
  const savedOpacity = clamp(instance.config.bgOpacity, 0, 1, DEFAULT_STYLE.bgOpacity);
  // 0.2.13 的默认值是 70% 透明。仅迁移这个旧默认值；用户已经调成其他数值时原样保留。
  const needsOpacityMigration = instance.config.countdownOpacityVersion !== 2;
  const initialOpacity = needsOpacityMigration && Math.abs(savedOpacity - 0.3) < 0.0001 ? DEFAULT_STYLE.bgOpacity : savedOpacity;
  let style = {
    bgOpacity: initialOpacity,
    bgColor: color(instance.config.bgColor, DEFAULT_STYLE.bgColor),
    textColor: color(instance.config.textColor, DEFAULT_STYLE.textColor),
    accentColor: color(instance.config.accentColor, DEFAULT_STYLE.accentColor),
    secondaryColor: color(instance.config.secondaryColor, DEFAULT_STYLE.secondaryColor),
    pinned: !!instance.config.pinned,
    locked: !!instance.config.locked,
  };
  let activeId = typeof instance.config.activeId === 'string' ? instance.config.activeId : '';
  let slotIds = Array.isArray(instance.config.slotIds) ? instance.config.slotIds.slice(0, 3).map(String) : [];
  while (slotIds.length < 3) slotIds.push('');

  function on(channel, fn) { ipcMain.on(channel, fn); listeners.push(channel); }
  function handle(channel, fn) { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); handlers.push(channel); }
  function persist() {
    instance.config = {
      ...(instance.config || {}), ...style,
      countdownOpacityVersion: 2,
      activeId,
      slotIds: slotIds.slice(0, 3),
    };
    save();
  }

  // 倒数日窗口支持从四周自由缩放，并保存每个实例自己的尺寸。
  // resize 事件中立即更新内存，避免共享拖动引擎把窗口吸回旧尺寸；落盘做轻量防抖。
  win.setResizable(true);
  win.setMinimumSize(MIN_SIZE.w, MIN_SIZE.h);
  win.setMaximumSize(MAX_SIZE.w, MAX_SIZE.h);
  const initialSize = expectedSize(instance, { w: 250, h: 260 });
  instance.config.width = initialSize.w;
  instance.config.height = initialSize.h;
  win.on('resize', () => {
    if (win.isDestroyed()) return;
    const [width, height] = win.getSize();
    instance.config.width = Math.round(clamp(width, MIN_SIZE.w, MAX_SIZE.w, initialSize.w));
    instance.config.height = Math.round(clamp(height, MIN_SIZE.h, MAX_SIZE.h, initialSize.h));
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(save, 220);
  });
  function selectedState() {
    const targets = allTargets();
    const ids = new Set(targets.map((t) => t.id));
    const fallback = targets[0] ? targets[0].id : '';
    const actualActive = ids.has(activeId) ? activeId : fallback;
    const actualSlots = slotIds.map((id, i) => ids.has(id) ? id : (targets[i] ? targets[i].id : ''));
    return { variant, targets, activeId: actualActive, slotIds: actualSlots, appearance: { ...style } };
  }
  function pushState() {
    if (win && !win.isDestroyed()) win.webContents.send('countdown:state:' + instId, selectedState());
  }
  const controller = { pushState };
  controllers.add(controller);

  function closeMenu() {
    if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    menuWin = null;
  }
  function openMenu(items) {
    closeMenu();
    const gen = ++menuGen;
    const cur = screen.getCursorScreenPoint();
    const mwin = new BrowserWindow({
      width: 228, height: 90, x: cur.x, y: cur.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    menuWin = mwin;
    mwin.on('closed', () => { if (menuGen === gen) menuWin = null; });
    mwin.on('blur', () => { if (menuGen === gen) closeMenu(); });
    mwin.webContents.on('did-finish-load', () => {
      if (menuGen === gen && !mwin.isDestroyed()) mwin.webContents.send('countdown:menu-items:' + instId, { gen, items });
    });
    mwin.loadFile(path.join(__dirname, 'menu.html'), { query: { inst: instId } });
  }
  function selectionItems(slot) {
    const targets = allTargets();
    if (!targets.length) return [{ label: '先添加一个目标日期…', action: 'settings' }];
    return [
      { kind: 'label', label: slot < 0 ? '选择显示目标' : `选择第 ${slot + 1} 行目标` },
      ...targets.map((t) => ({ label: `${t.name}  ·  ${t.date}`, swatch: t.color, action: 'choose', payload: { slot, targetId: t.id } })),
      { kind: 'sep' },
      { label: '管理目标日期…', action: 'settings' },
    ];
  }
  function openMainMenu() {
    const transparentPct = Math.round((1 - style.bgOpacity) * 100);
    const items = [
      { label: '管理目标日期…', action: 'settings' },
      ...(variant === 'single'
        ? [{ label: '选择显示目标…', action: 'selector', payload: { slot: -1 } }]
        : [0, 1, 2].map((slot) => ({ label: `选择第 ${slot + 1} 行目标…`, action: 'selector', payload: { slot } }))),
      { kind: 'sep' },
      { label: '外观调节…', action: 'appearance' },
      { kind: 'slider', label: '背景透明度', value: transparentPct, action: 'opacity' },
      { kind: 'sep' },
      { label: '锁定位置' + (style.locked ? '（已锁定）' : ''), action: 'lock' },
      { kind: 'sep' },
      { label: '退出此组件', action: 'quit', danger: true },
    ];
    openMenu(items);
  }

  function centeredBounds(width, height) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { width, height, x: wa.x + Math.max(0, Math.round((wa.width - width) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - height) / 2)) };
  }
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    settingsWin = new BrowserWindow({
      ...centeredBounds(570, 650), frame: false, transparent: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: false,
      alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    settingsWin.on('closed', () => { settingsWin = null; });
  }
  function openAppearance() {
    if (appearanceWin && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return; }
    appearanceWin = new BrowserWindow({
      ...centeredBounds(360, 500), frame: false, transparent: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: false,
      alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    appearanceWin.loadFile(path.join(__dirname, 'appearance.html'), { query: { inst: instId } });
    appearanceWin.on('closed', () => { appearanceWin = null; });
  }
  function chooseTarget(slot, targetId) {
    if (!allTargets().some((t) => t.id === targetId)) return;
    if (variant === 'single' || slot < 0) activeId = targetId;
    else if (slot >= 0 && slot < 3) slotIds[slot] = targetId;
    persist();
    pushState();
  }

  handle('countdown:init:' + instId, () => selectedState());
  handle('countdown:settings-init:' + instId, () => selectedState());
  handle('countdown:settings-save:' + instId, (_e, raw) => {
    const targets = normalizeTargets(raw && raw.targets);
    global.__cfg.countdownTargets = targets;
    const ids = new Set(targets.map((t) => t.id));
    if (raw && typeof raw.activeId === 'string') activeId = ids.has(raw.activeId) ? raw.activeId : (targets[0] ? targets[0].id : '');
    if (raw && Array.isArray(raw.slotIds)) {
      slotIds = raw.slotIds.slice(0, 3).map((id, i) => ids.has(String(id)) ? String(id) : (targets[i] ? targets[i].id : ''));
      while (slotIds.length < 3) slotIds.push('');
    }
    persist();
    broadcast();
    return { ok: true, state: selectedState(), count: targets.length };
  });
  handle('countdown:appearance-init:' + instId, () => ({ ...style }));

  on('countdown:menu:' + instId, openMainMenu);
  on('countdown:select:' + instId, (_e, slot) => openMenu(selectionItems(Number.isFinite(Number(slot)) ? Number(slot) : -1)));
  on('countdown:menu-ready:' + instId, (_e, data) => {
    if (!data || data.gen !== menuGen || !menuWin || menuWin.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cur).workArea;
    const mw = Math.max(180, Math.min(390, Number(data.w) || 228));
    const mh = Math.max(44, Math.min(620, Number(data.h) || 90));
    let x = cur.x, y = cur.y;
    if (x + mw > wa.x + wa.width) x = wa.x + wa.width - mw - 6;
    if (y + mh > wa.y + wa.height) y = wa.y + wa.height - mh - 6;
    menuWin.setBounds({ x: Math.max(wa.x + 2, x), y: Math.max(wa.y + 2, y), width: mw, height: mh });
    menuWin.show();
    menuWin.focus();
  });
  on('countdown:menu-click:' + instId, (_e, cmd) => {
    closeMenu();
    if (!cmd || !cmd.action) return;
    if (cmd.action === 'settings') openSettings();
    else if (cmd.action === 'appearance') openAppearance();
    else if (cmd.action === 'selector') openMenu(selectionItems(Number(cmd.payload && cmd.payload.slot)));
    else if (cmd.action === 'choose') chooseTarget(Number(cmd.payload && cmd.payload.slot), String(cmd.payload && cmd.payload.targetId || ''));
    else if (cmd.action === 'lock') { style.locked = !style.locked; persist(); pushState(); }
    else if (cmd.action === 'quit') {
      global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
      save();
      win.close();
    }
  });
  on('countdown:menu-slide:' + instId, (_e, data) => {
    if (!data || data.gen !== menuGen) return;
    style.bgOpacity = 1 - clamp(data.v, 0, 100, 80) / 100;
    pushState();
    if (data.done) persist();
  });
  on('countdown:background-opacity:' + instId, (_e, alpha) => {
    style.bgOpacity = clamp(alpha, 0, 1, style.bgOpacity);
    persist();
    pushState();
  });
  on('countdown:menu-close:' + instId, closeMenu);
  on('countdown:settings-open:' + instId, openSettings);
  on('countdown:choose:' + instId, (_e, data) => {
    if (!data) return;
    chooseTarget(Number(data.slot), String(data.targetId || ''));
  });
  on('countdown:settings-close:' + instId, () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
  on('countdown:appearance-open:' + instId, openAppearance);
  on('countdown:appearance-save:' + instId, (_e, raw) => {
    if (!raw) return;
    style.bgColor = color(raw.bgColor, style.bgColor);
    style.textColor = color(raw.textColor, style.textColor);
    style.accentColor = color(raw.accentColor, style.accentColor);
    style.secondaryColor = color(raw.secondaryColor, style.secondaryColor);
    if (typeof raw.bgOpacity === 'number') style.bgOpacity = clamp(raw.bgOpacity, 0, 1, style.bgOpacity);
    persist();
    pushState();
  });
  on('countdown:appearance-reset:' + instId, () => {
    style = { ...style, ...DEFAULT_STYLE, pinned: style.pinned, locked: style.locked };
    persist();
    pushState();
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.webContents.send('countdown:appearance-state:' + instId, { ...style });
  });
  on('countdown:appearance-close:' + instId, () => { if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close(); });

  win.webContents.on('did-finish-load', pushState);
  if (style.pinned) win.setAlwaysOnTop(true, 'floating');
  if (needsOpacityMigration) persist();
  win.on('closed', () => {
    clearTimeout(resizeSaveTimer);
    controllers.delete(controller);
    closeMenu();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    if (appearanceWin && !appearanceWin.isDestroyed()) appearanceWin.close();
    listeners.forEach((channel) => ipcMain.removeAllListeners(channel));
    handlers.forEach((channel) => ipcMain.removeHandler(channel));
  });
}

module.exports = { MIN_SIZE, MAX_SIZE, expectedSize, setup, normalizeTargets };
