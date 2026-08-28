// Widgetly 全组件统一控制层：尺寸记忆、置顶、位置锁定、鼠标穿透和统一右键菜单。
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const activeControllers = new Map();

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function expectedSize(instance, base) {
  if (!instance || !base) return base || null;
  const size = (instance.windowState && instance.windowState.windowSize)
    || (instance.config && instance.config.windowSize);
  if (!size || typeof size !== 'object') return base;
  return {
    w: Math.round(clamp(size.width, 90, 1400, base.w)),
    h: Math.round(clamp(size.height, 64, 1000, base.h)),
  };
}

function transparencyOf(instance) {
  const config = (instance && instance.config) || {};
  const saved = instance && instance.windowState && instance.windowState.backgroundTransparency;
  if (Number.isFinite(Number(saved))) return Math.round(clamp(saved, 0, 100, 60));
  if (Number.isFinite(Number(config.backgroundTransparency))) return Math.round(clamp(config.backgroundTransparency, 0, 100, 60));
  const wid = String(instance && instance.widgetId || '');
  if ((wid === 'clock' || wid === 'clockS' || wid === 'clockM' || wid === 'launcher' || wid.startsWith('calendar'))
      && Number.isFinite(Number(config.veilOpacity))) return Math.round(clamp(config.veilOpacity, 0, 100, 60));
  if (wid === 'todo' && config.appearance && Number.isFinite(Number(config.appearance.bgOpacity))) {
    return Math.round(clamp(config.appearance.bgOpacity, 0, 100, 60));
  }
  if (wid === 'memory' && config.appearance) {
    if (Number.isFinite(Number(config.appearance.bgOpacity))) return Math.round((1 - clamp(config.appearance.bgOpacity, 0, 1, .4)) * 100);
    if (config.appearance.bgMode === 'transparent') return 100;
    if (config.appearance.bgMode === 'solid') return 0;
    if (config.appearance.bgMode === 'frosted') return 38;
  }
  if (Number.isFinite(Number(config.bgOpacity))) return Math.round((1 - clamp(config.bgOpacity, 0, 1, .4)) * 100);
  return wid.startsWith('countdown') ? 80 : 60;
}

function writeTransparency(instance, percent) {
  const value = Math.round(clamp(percent, 0, 100, 60));
  const alpha = 1 - value / 100;
  const wid = String(instance.widgetId || '');
  instance.config = instance.config || {};
  instance.config.backgroundTransparency = value;
  if (wid === 'clock' || wid === 'clockS' || wid === 'clockM' || wid === 'launcher' || wid.startsWith('calendar')) {
    instance.config.veilOpacity = value;
  } else if (wid === 'todo') {
    instance.config.appearance = { ...(instance.config.appearance || {}), bgOpacity: value };
  } else if (wid === 'memory') {
    instance.config.appearance = { ...(instance.config.appearance || {}), bgOpacity: alpha };
  } else {
    instance.config.bgOpacity = alpha;
  }
  return { percent: value, alpha };
}

function setup({ instance, win, wdef, save, pushToBack, studio = false }) {
  const id = instance.id;
  // `openMenu()` 与 `directItems()` 都需要组件类型。这里在控制器作用域内
  // 统一缓存，避免右键菜单窗口加载完成时引用到不存在的局部变量而导致主进程退出。
  const wid = String(instance.widgetId || '');
  // BrowserWindow 的 closed 事件触发时再读取 win.webContents 会直接抛出
  // "Object has been destroyed"。窗口仍存活时缓存引用，清理阶段只检查该引用。
  const widgetContents = win.webContents;
  instance.config = instance.config || {};
  const initialTransparency = transparencyOf(instance);
  // 公共窗口状态放在实例顶层，避免旧组件适配器保存自己的配置时整对象替换、误删尺寸/穿透/置顶。
  const common = instance.windowState = {
    windowSize: (instance.windowState && instance.windowState.windowSize) || instance.config.windowSize || null,
    pinned: typeof (instance.windowState && instance.windowState.pinned) === 'boolean' ? instance.windowState.pinned : !!instance.config.pinned,
    locked: typeof (instance.windowState && instance.windowState.locked) === 'boolean' ? instance.windowState.locked : !!instance.config.locked,
    clickThrough: typeof (instance.windowState && instance.windowState.clickThrough) === 'boolean' ? instance.windowState.clickThrough : !!instance.config.clickThrough,
    backgroundTransparency: initialTransparency,
    opacitySchemaVersion: 1,
  };
  writeTransparency(instance, initialTransparency);
  let menuWin = null;
  // 右键命中的组件内部对象（目前用于桌面快捷坞的具体快捷方式）。
  // 仅保存在运行时，不写进 config.json。
  let menuContext = {};
  let generation = 0;
  let resizeTimer = null;
  let transparencySaveTimer = null;
  let installingCapture = false;
  let userResizeBounds = null;
  let lastMenuOpenAt = 0;
  let stableSize = expectedSize(instance, wdef) || { w: wdef.w, h: wdef.h };
  const capturedHandlers = widgetContents.listeners('context-menu');
  if (capturedHandlers.length) widgetContents.removeAllListeners('context-menu');

  // 没有单独声明最小尺寸的旧组件统一允许缩到默认尺寸的 42%。
  // 其内部仍按相同比例缩放，因此是完整缩小，而不是只缩外框后让内容溢出。
  const minW = Math.max(90, Number(wdef.minW) || Math.round(wdef.w * .42));
  const minH = Math.max(64, Number(wdef.minH) || Math.round(wdef.h * .42));
  const maxW = Math.max(minW, Number(wdef.maxW) || 1400);
  const maxH = Math.max(minH, Number(wdef.maxH) || 1000);
  const useResponsiveStudioLayout = studio || instance.widgetId === 'promptOptimizer' || String(instance.widgetId).startsWith('countdown');
  function applyLegacyZoom() {
    if (useResponsiveStudioLayout || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
    const [width, height] = win.getSize();
    // 旧组件内部有一部分仍使用固定像素。按较短边等比缩放其排版坐标，再由 100% 卡片填满窗口，
    // 可在任意宽高下保持文字/按钮不互相覆盖；新组件则完全使用容器查询重新排版，不走缩放。
    const factor = Math.max(.42, Math.min(2.4, Math.min(width / wdef.w, height / wdef.h)));
    try { win.webContents.setZoomFactor(factor); } catch (_) {}
  }
  if (instance.widgetId !== 'promptOptimizer' && !String(instance.widgetId).startsWith('countdown')) {
    win.setResizable(true);
    win.setMinimumSize(minW, minH);
    win.setMaximumSize(maxW, maxH);
    // 只把 will-resize 给出的尺寸视为用户主动调整。透明窗口在聚焦、右键或拖动时
    // 偶尔会由 Windows 报出 1px 漂移，不能把这种漂移保存成下一次的“正确尺寸”。
    win.on('will-resize', (_event, bounds) => {
      userResizeBounds = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
    });
    win.on('resize', () => {
      if (win.isDestroyed()) return;
      const [width, height] = win.getSize();
      const wid = String(instance.widgetId || '');
      if (userResizeBounds) {
        stableSize = { w: userResizeBounds.width, h: userResizeBounds.height };
        common.windowSize = { width: stableSize.w, height: stableSize.h };
        userResizeBounds = null;
      } else {
        const driftW = Math.abs(width - stableSize.w);
        const driftH = Math.abs(height - stableSize.h);
        if ((driftW || driftH) && driftW <= 2 && driftH <= 2) {
          const [x, y] = win.getPosition();
          win.setBounds({ x, y, width: stableSize.w, height: stableSize.h });
          return;
        }
        // 兼容组件自身发起的明显尺寸切换（例如旧启动器的形态切换）。
        stableSize = { w: width, h: height };
        common.windowSize = { width, height };
      }
      applyLegacyZoom();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(save, 240);
      if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    });
  }

  function applyPinned() {
    if (win.isDestroyed()) return;
    if (common.pinned) win.setAlwaysOnTop(true, 'floating');
    else {
      win.setAlwaysOnTop(false);
      if (typeof pushToBack === 'function') pushToBack(win);
    }
  }
  function applyClickThrough() {
    if (win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!!common.clickThrough, { forward: true });
  }
  function notifyCommonState() {
    if (!win.isDestroyed() && !widgetContents.isDestroyed()) widgetContents.send('widgetly:common-state:' + id, {
      pinned: !!common.pinned,
      locked: !!common.locked,
      clickThrough: !!common.clickThrough,
      backgroundTransparency: common.backgroundTransparency,
    });
  }
  function persistAndNotify() {
    save();
    notifyCommonState();
  }
  function commitTransparencyToAdapter(data) {
    const wid = String(instance.widgetId || '');
    const event = { sender: widgetContents };
    if (wid === 'clock' || wid === 'clockS' || wid === 'clockM') widgetContents.send('clock:veil:' + id, { v: data.percent, save: true });
    else if (wid.startsWith('calendar')) widgetContents.send('cal:veil:' + id, { v: data.percent, save: true });
    else if (wid === 'launcher') widgetContents.send('launcher:veil:' + id, { v: data.percent, save: true });
    else if (wid === 'dock' || wid === 'monitor' || wid === 'sysmon' || wid === 'sysmonL' || wid.startsWith('pomodoro')) ipcMain.emit('save-bg-opacity:' + id, event, data.alpha);
    else if (wid.startsWith('clock2')) ipcMain.emit('clock2:bg-opacity:' + id, event, data.alpha);
    else if (wid.startsWith('weather')) ipcMain.emit('weather:bg-opacity:' + id, event, data.alpha);
    else if (wid === 'todo') ipcMain.emit('todo:appearance:' + id, event, { bgOpacity: data.percent });
    else if (wid === 'memory') ipcMain.emit('memory:appearance:' + id, event, { bgOpacity: data.alpha });
    else if (wid.startsWith('countdown')) ipcMain.emit('countdown:background-opacity:' + id, event, data.alpha);
    else if (wid === 'promptOptimizer') ipcMain.emit('prompt:bg-opacity:' + id, event, data.alpha);
  }
  function applyBackgroundTransparency(percent, commit = false) {
    const data = writeTransparency(instance, percent);
    common.backgroundTransparency = data.percent;
    if (!widgetContents.isDestroyed()) widgetContents.send('widgetly:background-transparency:' + id, data);
    clearTimeout(transparencySaveTimer);
    if (commit) {
      commitTransparencyToAdapter(data);
      save();
    } else {
      transparencySaveTimer = setTimeout(save, 220);
    }
  }
  function emit(channel, payload) {
    ipcMain.emit(channel + ':' + id, { sender: widgetContents }, payload);
  }
  function directItems() {
    const wid = String(instance.widgetId || '');
    const items = [];
    if (wid === 'componentDock') {
      const childId = String(menuContext.childId || '');
      const child = childId && global.__cfg && Array.isArray(global.__cfg.instances)
        ? global.__cfg.instances.find((item) => item && item.id === childId && item.host && item.host.type === 'componentDock' && item.host.dockId === id)
        : null;
      if (child) {
        const name = String(menuContext.childName || child.widgetId || '子组件');
        const rawAlpha = Number(child.config && child.config.bgOpacity);
        const value = Number.isFinite(rawAlpha) ? Math.round((1 - Math.max(0, Math.min(1, rawAlpha))) * 100) : 80;
        items.push({ label: `${name} 设置…`, action: 'dockgroup-child-settings' });
        items.push({ kind: 'slider', label: '子组件背景透明度', action: 'child-transparency', value });
        items.push({ label: '移出组件坞', action: 'dockgroup-child-detach' });
        items.push({ label: '删除此子组件', action: 'dockgroup-child-remove', danger: true });
        items.push({ kind: 'separator' });
        // 子组件右键只显示它自己的操作；最底部保留一个明确入口，便于需要时
        // 回到组件坞编辑器，而不会把外层置顶、锁定等功能混进子组件菜单。
        items.push({ label: '组件坞设置…', action: 'dockgroup-settings' });
      } else {
        items.push({ label: '编辑组件坞…', action: 'dockgroup-settings' });
        items.push({ label: '添加 / 替换组件…', action: 'dockgroup-settings' });
        items.push({ label: '自动整理组件', action: 'dockgroup-reflow' });
        items.push({ label: '解散组件坞', action: 'dockgroup-dissolve' });
        items.push({ label: '删除组件坞', action: 'dockgroup-delete', danger: true });
      }
      if (items.length && items[items.length - 1].kind !== 'separator') items.push({ kind: 'separator' });
      return items;
    }
    const clockLike = ['clock','clockS','clockM','clock2','clock2S','clock2Sec','flipClock','digitalClockGlass','clockCalendar'].includes(wid);
    if (clockLike) items.push({ label: '24 小时制', action: 'quick-hour24', toggle: true, on: instance.config.hour12 !== true });
    if (['clock2','clock2S','clock2Sec','flipClock','digitalClockGlass','clockCalendar'].includes(wid)) {
      const defaultSeconds = wid === 'clock2Sec' || ['flipClock','digitalClockGlass','clockCalendar'].includes(wid);
      items.push({ label: '显示秒数', action: 'quick-seconds', toggle: true, on: typeof instance.config.showSeconds === 'boolean' ? instance.config.showSeconds : defaultSeconds });
    }
    if (wid === 'miniCalendarGlass' || wid === 'clockCalendar') {
      items.push({ label: '显示农历', action: 'quick-lunar', toggle: true, on: instance.config.showLunar !== false });
    }
    if (wid === 'durationTimer') items.push({ label: '循环倒计时', action: 'quick-loop', toggle: true, on: !!instance.config.loop });
    if (wid === 'alarmClock') {
      const sound = instance.config.alarmSound || {};
      items.push({ label: '到点提示声音', action: 'quick-alarm-sound', toggle: true, on: sound.mode !== 'none' });
    }
    if (wid === 'clock' || wid === 'clockS' || wid === 'clockM') {
      items.push({ label: '复制当前时间', action: 'clock-copy-time' });
      items.push({ label: '深色模式', action: 'clock-theme', toggle: true, on: instance.config.theme === 'dark' });
    }
    if (wid === 'clock2' || wid === 'clock2S' || wid === 'clock2Sec') {
      const theme = ['light','dark'].includes(instance.config.theme) ? instance.config.theme : 'auto';
      items.push(
        { label: '主题：跟随系统', action: 'clock2-theme-auto', toggle: true, on: theme === 'auto' },
        { label: '主题：浅色', action: 'clock2-theme-light', toggle: true, on: theme === 'light' },
        { label: '主题：深色', action: 'clock2-theme-dark', toggle: true, on: theme === 'dark' },
      );
    }
    if (items.length) items.push({ kind: 'separator' });

    if (studio) items.push({ label: '组件设置…', action: 'studio-settings' });
    else if (wid === 'dock') {
      const selectedPath = typeof menuContext.dockPath === 'string' ? menuContext.dockPath : '';
      if (selectedPath) {
        items.push(
          { label: '打开此快捷方式', action: 'dock-open-selected' },
          { label: '移除此快捷方式', action: 'dock-remove-selected', danger: true },
          { kind: 'separator' },
        );
      }
      items.push({ label: '添加文件或文件夹…', action: 'dock-add' });
      const currentLayout = String(instance.config.layout || '4x2');
      [
        ['3x3', '排列：3 × 3 紧凑'],
        ['3x4', '排列：3 × 4 竖版'],
        ['4x2', '排列：4 × 2 矮横条'],
        ['4x3', '排列：4 × 3 横版'],
        ['4x4', '排列：4 × 4 高版'],
        ['4x5', '排列：4 × 5 长版'],
        ['5x4', '排列：5 × 4 大容量'],
        ['5x3', '排列：5 × 3 紧凑'],
      ].forEach(([layout, label]) => items.push({ label, action: 'dock-layout-' + layout, toggle: true, on: currentLayout === layout }));
    }
    else if (wid.startsWith('gallery')) items.push({ label: '图库设置…', action: 'gallery-settings' });
    else if (wid === 'todo') {
      if (Number.isInteger(menuContext.todoIndex) && menuContext.todoDate) {
        items.push({ label: '删除该待办', action: 'todo-remove-selected', danger: true }, { kind: 'separator' });
      }
      items.push(
        { label: '设置每日待办…', action: 'todo-settings' },
        { label: '应用此待办日期…', action: 'todo-apply-day' },
        { label: '外观配色…', action: 'todo-appearance' },
        { label: '尺寸：小号', action: 'todo-size-small', toggle: true, on: instance.config.size === 'small' },
        { label: '尺寸：中号', action: 'todo-size-medium', toggle: true, on: !instance.config.size || instance.config.size === 'medium' },
        { label: '尺寸：大号', action: 'todo-size-large', toggle: true, on: instance.config.size === 'large' },
      );
    }
    else if (wid === 'memory') items.push({ label: '外观配色…', action: 'memory-appearance' });
    else if (wid === 'monitor') items.push(
      { label: '立即刷新', action: 'monitor-refresh' },
      { label: '毛玻璃效果', action: 'monitor-glass', toggle: true, on: !!instance.config.glass },
      { label: '监测平台…', action: 'monitor-platform' },
      { label: '外观配色…', action: 'monitor-appearance' },
    );
    else if (wid === 'sysmon' || wid === 'sysmonL') items.push({ label: '监测项目…', action: 'sysmon-settings' }, { label: '外观配色…', action: 'sysmon-appearance' });
    else if (wid.startsWith('pomodoro')) items.push(
      { label: '开始 / 暂停 / 继续', action: 'pomodoro-toggle' },
      { label: '重置计时', action: 'pomodoro-reset' },
      { label: '跳过休息', action: 'pomodoro-skip' },
      { label: '添加事项…', action: 'pomodoro-add' },
      { label: '删除选中事项', action: 'pomodoro-delete' },
      { label: '番茄钟设置…', action: 'pomodoro-settings' },
    );
    else if (wid.startsWith('clock2')) items.push({ label: '外观配色…', action: 'clock2-appearance' });
    else if (wid.startsWith('weather')) items.push({ label: '刷新天气', action: 'weather-refresh' }, { label: '城市设置…', action: 'weather-settings' }, { label: '外观配色…', action: 'weather-appearance' });
    else if (wid.startsWith('countdown')) {
      const slot = Number(menuContext.countdownSlot);
      if (Number.isInteger(slot) && slot >= -1 && slot <= 2) {
        const targets = Array.isArray(global.__cfg && global.__cfg.countdownTargets) ? global.__cfg.countdownTargets.slice(0, 8) : [];
        const selectedId = slot < 0 ? String(instance.config.activeId || '') : String((instance.config.slotIds || [])[slot] || '');
        targets.forEach((target, index) => items.push({
          label: `${target.name} · ${target.date}`,
          action: `countdown-choose-${index}`,
          toggle: true,
          on: String(target.id) === selectedId,
        }));
        if (!targets.length) items.push({ label: '还没有目标日期', action: 'countdown-settings' });
        items.push({ label: '管理全部目标日期…', action: 'countdown-settings' });
      } else {
        items.push({ label: '管理目标日期…', action: 'countdown-settings' });
        if (wid === 'countdownSingle') items.push({ label: '选择显示目标…', action: 'countdown-select--1' });
        else [0,1,2].forEach((index) => items.push({ label: `选择第 ${index + 1} 行目标…`, action: `countdown-select-${index}` }));
        items.push({ label: '外观配色…', action: 'countdown-appearance' });
      }
    }
    else if (wid === 'promptOptimizer') {
      const strength = Math.max(1, Math.min(3, Math.round(Number(instance.config.strength) || 1)));
      items.push(
        { label: '打开专业工作台', action: 'prompt-workspace' },
        { label: '配置 AI 模型…', action: 'prompt-model' },
        { kind: 'separator' },
        { label: '强度 1 · 基础润色', action: 'prompt-strength-1', toggle: true, on: strength === 1 },
        { label: '强度 2 · 结构增强', action: 'prompt-strength-2', toggle: true, on: strength === 2 },
        { label: '强度 3 · 专家重构', action: 'prompt-strength-3', toggle: true, on: strength === 3 },
        { label: '关于开源组件', action: 'prompt-about' },
      );
    }
    else if (wid === 'launcher') items.push(
      { label: '启动 / 停止服务', action: 'launcher-toggle' },
      { label: '尺寸：小号', action: 'launcher-size-small', toggle: true, on: instance.config.size === 'small' },
      { label: '尺寸：中号', action: 'launcher-size-medium', toggle: true, on: !instance.config.size || instance.config.size === 'medium' },
      { label: '尺寸：大号', action: 'launcher-size-large', toggle: true, on: instance.config.size === 'large' },
      { label: '主题：玻璃拟态', action: 'launcher-theme-light', toggle: true, on: instance.config.theme !== 'dark' },
      { label: '主题：深色极光', action: 'launcher-theme-dark', toggle: true, on: instance.config.theme === 'dark' },
      { label: '启动器设置…', action: 'launcher-settings' },
    );
    else if (wid === 'clock' || wid === 'clockS' || wid === 'clockM') items.push({ label: '外观配色…', action: 'clock-appearance' });
    else if (wid.startsWith('calendar')) items.push({ label: '外观配色…', action: 'calendar-appearance' });
    if (items.length && items[items.length - 1].kind !== 'separator') items.push({ kind: 'separator' });
    return items;
  }
  function closeMenu() {
    if (menuWin && !menuWin.isDestroyed()) menuWin.close();
    menuWin = null;
  }
  function openMenu() {
    if (common.clickThrough || win.isDestroyed()) return;
    const openedAt = Date.now();
    if (menuWin && !menuWin.isDestroyed() && openedAt - lastMenuOpenAt < 260) return;
    lastMenuOpenAt = openedAt;
    closeMenu();
    const gen = ++generation;
    const cursor = screen.getCursorScreenPoint();
    menuWin = new BrowserWindow({
      width: 246, height: 360, x: cursor.x, y: cursor.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      show: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const current = menuWin;
    current.on('blur', closeMenu);
    current.on('closed', () => { if (menuWin === current) menuWin = null; });
    current.webContents.on('did-finish-load', () => {
      if (current.isDestroyed() || gen !== generation) return;
      const [width, height] = win.getSize();
      const items = directItems();
      const isDockChildMenu = wid === 'componentDock' && !!menuContext.childId;
      if (!isDockChildMenu) {
        items.push({ kind: 'slider', label: wid === 'componentDock' ? '组件坞背景透明度' : '背景透明度', action: 'transparency', value: common.backgroundTransparency });
        items.push({ kind: 'separator' });
        items.push({ label: '窗口置顶', action: 'pin', toggle: true, on: !!common.pinned });
        items.push({ label: '鼠标穿透', action: 'through', toggle: true, on: !!common.clickThrough });
        items.push({ label: '锁定位置', action: 'lock', toggle: true, on: !!common.locked });
        items.push({ kind: 'separator' });
      }
      if (wid !== 'componentDock') {
        items.push({ label: '恢复默认大小', state: `${wdef.w} × ${wdef.h}`, action: 'reset-size' });
        items.push({ label: '移除此组件', action: 'quit', danger: true });
      }
      current.webContents.send('widgetly-menu:data:' + id, {
        generation: gen,
        name: wdef.name,
        width,
        height,
        items,
        clickThroughShortcut: String(global.__widgetlyClickThroughShortcut || ''),
      });
    });
    current.loadFile(path.join(__dirname, 'menu.html'), { query: { inst: id } });
  }

  function installContextCapture() {
    if (installingCapture || win.isDestroyed()) return;
    installingCapture = true;
    const source = instance.widgetId === 'promptOptimizer'
      ? `(() => { if (window.__widgetlyCommonMenu) return; window.__widgetlyCommonMenu = true; window.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopImmediatePropagation(); if (window.widgetlyPrompt && window.widgetlyPrompt.openCommonMenu) window.widgetlyPrompt.openCommonMenu(); }, true); })()`
      : instance.widgetId === 'dock'
        ? `(() => { if (window.__widgetlyCommonMenu) return; window.__widgetlyCommonMenu = true; window.addEventListener('contextmenu', (event) => { const cell = event.target && event.target.closest ? event.target.closest('.cell:not(.empty)') : null; const dockPath = cell && cell.dataset ? String(cell.dataset.path || '') : ''; event.preventDefault(); event.stopImmediatePropagation(); require('electron').ipcRenderer.send('widgetly-common-menu:${id}', { dockPath }); }, true); })()`
        : instance.widgetId === 'todo'
          ? `(() => { if (window.__widgetlyCommonMenu) return; window.__widgetlyCommonMenu = true; window.addEventListener('contextmenu', (event) => { const row = event.target && event.target.closest ? event.target.closest('.todo-row') : null; const todoIndex = row && row.dataset ? Number(row.dataset.todoIndex) : NaN; const todoDate = row && row.dataset ? String(row.dataset.todoDate || '') : ''; event.preventDefault(); event.stopImmediatePropagation(); require('electron').ipcRenderer.send('widgetly-common-menu:${id}', { todoIndex: Number.isInteger(todoIndex) ? todoIndex : null, todoDate }); }, true); })()`
        : `(() => { if (window.__widgetlyCommonMenu) return; window.__widgetlyCommonMenu = true; window.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopImmediatePropagation(); require('electron').ipcRenderer.send('widgetly-common-menu:${id}'); }, true); })()`;
    win.webContents.executeJavaScript(source).catch(() => {}).finally(() => { installingCapture = false; });
  }

  const onOpen = (_event, data) => {
    menuContext = data && typeof data === 'object' ? { ...data } : {};
    openMenu();
  };
  const onReady = (_event, data) => {
    if (!data || data.generation !== generation || !menuWin || menuWin.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const workArea = screen.getDisplayNearestPoint(cursor).workArea;
    const width = Math.max(220, Math.min(320, Number(data.width) || 264));
    const height = Math.max(100, Math.min(620, Number(data.height) || 360));
    let x = cursor.x, y = cursor.y;
    if (x + width > workArea.x + workArea.width) x = workArea.x + workArea.width - width - 6;
    if (y + height > workArea.y + workArea.height) y = workArea.y + workArea.height - height - 6;
    menuWin.setBounds({ x: Math.max(workArea.x + 2, x), y: Math.max(workArea.y + 2, y), width, height });
    menuWin.show(); menuWin.focus();
  };
  const onClick = (_event, data) => {
    if (!data || data.generation !== generation) return;
    const action = data.action;
    closeMenu();
    if (action === 'quick-hour24') {
      if (['clock','clockS','clockM'].includes(instance.widgetId)) {
        // 旧时钟的 renderer 会自行切换并保存，主进程不能先改一次，否则会发生“双重取反”。
        widgetContents.send('clock:menu:' + id, { action: 'hour12' });
      } else {
        instance.config.hour12 = instance.config.hour12 !== true;
        if (studio) widgetContents.send('cfg:updated:' + id, instance.config);
        else emit('clock2:options', { hour12: instance.config.hour12 });
        save();
      }
    } else if (action === 'quick-seconds') {
      const defaultOn = instance.widgetId === 'clock2Sec' || ['flipClock','digitalClockGlass','clockCalendar'].includes(instance.widgetId);
      const current = typeof instance.config.showSeconds === 'boolean' ? instance.config.showSeconds : defaultOn;
      instance.config.showSeconds = !current;
      if (studio) widgetContents.send('cfg:updated:' + id, instance.config);
      else emit('clock2:options', { showSeconds: instance.config.showSeconds });
      save();
    } else if (action === 'quick-lunar') {
      instance.config.showLunar = instance.config.showLunar === false;
      widgetContents.send('cfg:updated:' + id, instance.config); save();
    } else if (action === 'quick-loop') {
      instance.config.loop = !instance.config.loop;
      widgetContents.send('cfg:updated:' + id, instance.config); save();
    } else if (action === 'quick-alarm-sound') {
      const sound = { mode: 'system', filePath: '', fileName: '', volume: .85, repeat: true, ...(instance.config.alarmSound || {}) };
      sound.mode = sound.mode === 'none' ? 'system' : 'none';
      instance.config.alarmSound = sound;
      widgetContents.send('cfg:updated:' + id, instance.config); save();
    } else if (action === 'clock-copy-time') {
      // 旧灵动时钟由渲染器复制其屏幕上正在显示的文本，确保 12/24 小时制完全一致。
      widgetContents.send('clock:menu:' + id, { action: 'copy' });
    } else if (action === 'clock-theme') {
      widgetContents.send('clock:menu:' + id, { action: 'theme' });
    } else if (/^clock2-theme-(auto|light|dark)$/.test(action)) {
      emit('clock2:options', { theme: action.slice('clock2-theme-'.length) });
    } else if (action === 'studio-settings') emit('studio:settings-open');
    else if (action === 'dockgroup-settings') emit('dockgroup:settings-open');
    else if (action === 'dockgroup-child-settings') emit('dockgroup:child-settings', menuContext.childId);
    else if (action === 'dockgroup-child-detach') emit('dockgroup:child-detach', menuContext.childId);
    else if (action === 'dockgroup-child-remove') emit('dockgroup:child-remove', menuContext.childId);
    else if (action === 'dockgroup-dissolve') emit('dockgroup:dissolve');
    else if (action === 'dockgroup-reflow') emit('dockgroup:reflow');
    else if (action === 'dockgroup-delete') emit('dockgroup:delete');
    else if (action === 'dock-add') emit('add');
    else if (action === 'dock-open-selected' && menuContext.dockPath) emit('dock:open-selected', menuContext.dockPath);
    else if (action === 'dock-remove-selected' && menuContext.dockPath) emit('dock:remove-selected', menuContext.dockPath);
    else if (/^dock-layout-(3x3|3x4|4x2|4x3|4x4|4x5|5x4|5x3)$/.test(action)) emit('dock:layout', action.slice('dock-layout-'.length));
    else if (action === 'gallery-settings') emit('gallery:settings-open');
    else if (action === 'todo-settings') emit('todo:settings-open');
    else if (action === 'todo-apply-day') emit('todo:apply-day-open');
    else if (action === 'todo-remove-selected' && Number.isInteger(menuContext.todoIndex) && menuContext.todoDate) emit('todo:remove', { date: menuContext.todoDate, index: menuContext.todoIndex });
    else if (/^todo-size-(small|medium|large)$/.test(action)) emit('todo:size', action.slice('todo-size-'.length));
    else if (action === 'todo-appearance') emit('todo:appearance-open');
    else if (action === 'memory-appearance') emit('memory:appearance-open');
    else if (action === 'monitor-refresh') emit('monitor:refresh');
    else if (action === 'monitor-glass') emit('monitor:glass-toggle');
    else if (action === 'monitor-platform') emit('monitor:platform-open');
    else if (action === 'monitor-appearance') emit('monitor:appearance-open');
    else if (action === 'sysmon-settings') emit('sysmon:settings-open');
    else if (action === 'sysmon-appearance') emit('sysmon:appearance-open');
    else if (action === 'pomodoro-toggle') emit('pomodoro:quick', 'toggle');
    else if (action === 'pomodoro-reset') emit('pomodoro:quick', 'reset');
    else if (action === 'pomodoro-skip') emit('pomodoro:quick', 'skip');
    else if (action === 'pomodoro-add') emit('pomodoro:quick', 'add');
    else if (action === 'pomodoro-delete') emit('pomodoro:quick', 'delete');
    else if (action === 'pomodoro-settings') emit('pomodoro:settings-open');
    else if (action === 'clock2-appearance') emit('clock2:appearance-open');
    else if (action === 'weather-refresh') emit('weather:refresh');
    else if (action === 'weather-settings') emit('weather:settings-open');
    else if (action === 'weather-appearance') emit('weather:appearance-open');
    else if (/^countdown-select-(-1|0|1|2)$/.test(action)) {
      menuContext = { countdownSlot: Number(action.slice('countdown-select-'.length)) };
      lastMenuOpenAt = 0;
      setTimeout(openMenu, 0);
    }
    else if (/^countdown-choose-[0-7]$/.test(action)) {
      const targets = Array.isArray(global.__cfg && global.__cfg.countdownTargets) ? global.__cfg.countdownTargets.slice(0, 8) : [];
      const target = targets[Number(action.slice('countdown-choose-'.length))];
      if (target) emit('countdown:choose', { slot: Number(menuContext.countdownSlot), targetId: String(target.id) });
    }
    else if (action === 'countdown-settings') emit('countdown:settings-open');
    else if (action === 'countdown-appearance') emit('countdown:appearance-open');
    else if (action === 'prompt-workspace') emit('prompt:workspace-open', 'visible');
    else if (action === 'prompt-model') emit('prompt:model-settings');
    else if (/^prompt-strength-[123]$/.test(action)) emit('prompt:strength', Number(action.slice(-1)));
    else if (action === 'prompt-about') emit('prompt:about');
    else if (action === 'launcher-toggle') emit('launcher:common-toggle');
    else if (/^launcher-size-(small|medium|large)$/.test(action)) emit('launcher:common-size', action.slice('launcher-size-'.length));
    else if (/^launcher-theme-(light|dark)$/.test(action)) emit('launcher:common-theme', action.slice('launcher-theme-'.length));
    else if (action === 'launcher-settings') emit('launcher:settings-open');
    else if (action === 'clock-appearance') emit('clock:appearance-open');
    else if (action === 'calendar-appearance') emit('cal:appearance-open');
    else if (action === 'pin') {
      common.pinned = !common.pinned; instance.config.pinned = common.pinned; applyPinned(); persistAndNotify();
    } else if (action === 'through') {
      common.clickThrough = !common.clickThrough; instance.config.clickThrough = common.clickThrough; persistAndNotify(); applyClickThrough();
    } else if (action === 'lock') {
      common.locked = !common.locked; instance.config.locked = common.locked; persistAndNotify();
    } else if (action === 'reset-size') {
      common.windowSize = null; delete instance.config.windowSize; save();
      stableSize = { w: wdef.w, h: wdef.h };
      if (!win.isDestroyed()) { const [x, y] = win.getPosition(); win.setBounds({ x, y, width: stableSize.w, height: stableSize.h }); }
    } else if (action === 'quit') {
      global.__cfg.instances = global.__cfg.instances.filter((item) => item.id !== id); save(); win.close();
    }
  };
  const onSlide = (_event, data) => {
    if (!data || data.generation !== generation) return;
    if (data.action === 'transparency') applyBackgroundTransparency(data.value, !!data.done);
    else if (instance.widgetId === 'componentDock' && data.action === 'child-transparency' && menuContext.childId) {
      emit('dockgroup:child-transparency', { childId: menuContext.childId, value: data.value, done: !!data.done });
    }
  };
  const onClose = () => closeMenu();
  const onNativeContextMenu = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (instance.widgetId === 'dock' || instance.widgetId === 'componentDock') {
      // Dock/组件坞需要 DOM 命中信息才能显示对应子项菜单。优先等捕获阶段的
      // contextmenu 上报；若脚本注入意外失败，再退化为空白区域菜单。
      const requestedAt = Date.now();
      setTimeout(() => {
        if (!win.isDestroyed() && lastMenuOpenAt < requestedAt) {
          menuContext = {};
          openMenu();
        }
      }, 60);
      return;
    }
    menuContext = {};
    openMenu();
  };
  ipcMain.on('widgetly-common-menu:' + id, onOpen);
  ipcMain.on('widgetly-menu:ready:' + id, onReady);
  ipcMain.on('widgetly-menu:click:' + id, onClick);
  ipcMain.on('widgetly-menu:slide:' + id, onSlide);
  ipcMain.on('widgetly-menu:close:' + id, onClose);
  // 主进程事件作为所有组件的兜底：即使某个旧组件没有正确派发 DOM contextmenu，
  // 第一次右键也能直接打开统一菜单，不需要先左键激活窗口。
  widgetContents.on('context-menu', onNativeContextMenu);

  widgetContents.on('did-finish-load', () => {
    installContextCapture();
    // 统一改善所有新旧组件的文字栅格化；不覆盖各组件自己的字体设计，只让中文和数字边缘更干净。
    win.webContents.insertCSS('html{font-synthesis:none;text-rendering:optimizeLegibility}body,button,input,textarea,select{-webkit-font-smoothing:antialiased}').catch(() => {});
    applyLegacyZoom();
    applyPinned(); applyClickThrough();
    applyBackgroundTransparency(common.backgroundTransparency, false);
    persistAndNotify();
  });
  win.on('closed', () => {
    clearTimeout(resizeTimer); clearTimeout(transparencySaveTimer); closeMenu(); activeControllers.delete(id);
    ipcMain.removeListener('widgetly-common-menu:' + id, onOpen);
    ipcMain.removeListener('widgetly-menu:ready:' + id, onReady);
    ipcMain.removeListener('widgetly-menu:click:' + id, onClick);
    ipcMain.removeListener('widgetly-menu:slide:' + id, onSlide);
    ipcMain.removeListener('widgetly-menu:close:' + id, onClose);
    if (!widgetContents.isDestroyed()) widgetContents.removeListener('context-menu', onNativeContextMenu);
  });

  const controller = {
    disableClickThrough() {
      instance.config = instance.config || {};
      instance.windowState = instance.windowState || common;
      const changed = common.clickThrough === true
        || instance.windowState.clickThrough === true
        || instance.config.clickThrough === true;
      common.clickThrough = false;
      instance.windowState.clickThrough = false;
      instance.config.clickThrough = false;
      // 不依赖配置是否已经被其他渲染器改成 false：原生窗口状态可能仍停留在穿透，必须强制恢复。
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
      notifyCommonState();
      return changed;
    },
  };
  activeControllers.set(id, controller);
  return controller;
}

function disableAllClickThrough(save) {
  let changed = false;
  // 先修正完整实例注册表，覆盖尚未创建、已临时关闭或控制器尚未挂载的组件。
  const instances = global.__cfg && Array.isArray(global.__cfg.instances) ? global.__cfg.instances : [];
  for (const instance of instances) {
    if (!instance || typeof instance !== 'object') continue;
    instance.config = instance.config || {};
    instance.windowState = instance.windowState || {};
    changed = instance.config.clickThrough === true || instance.windowState.clickThrough === true || changed;
    instance.config.clickThrough = false;
    instance.windowState.clickThrough = false;
  }
  // 再强制解除所有活动 BrowserWindow 的原生穿透状态，即使配置此前已经错误地显示为关闭。
  for (const controller of activeControllers.values()) changed = controller.disableClickThrough() || changed;
  if (changed && typeof save === 'function') save();
  return changed;
}

module.exports = { expectedSize, setup, disableAllClickThrough };
