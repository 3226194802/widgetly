// Widgetly AI 提示词优化组件：轻量壳 + 按需加载的 Prompt Optimizer v2.11.8 工作台。
const { ipcMain, Menu, screen } = require('electron');

const MINI_SIZE = { w: 360, h: 150 };
const RESULT_SIZE = { w: 360, h: 330 };
const WORKSPACE_DEFAULT = { w: 1180, h: 760 };
const WIDGET_LIMITS = {
  minWidth: 300,
  maxWidth: 760,
  minMiniHeight: 128,
  maxMiniHeight: 420,
  minResultHeight: 300,
  maxResultHeight: 760,
};
const controllers = new Map();
let activeWorkspaceId = null;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function trimText(value, max) {
  return String(value || '').slice(0, max);
}

function expectedSize(instance, base) {
  if (!instance || instance.widgetId !== 'promptOptimizer') return base;
  if (instance._promptWorkspaceMode === 'visible' && instance._promptWorkspaceSize) {
    return { ...instance._promptWorkspaceSize };
  }
  const cfg = instance.config || {};
  const width = Math.round(clamp(cfg.widgetWidth, WIDGET_LIMITS.minWidth, WIDGET_LIMITS.maxWidth, MINI_SIZE.w));
  if (instance._promptResultExpanded) {
    return {
      w: width,
      h: Math.round(clamp(cfg.resultHeight, WIDGET_LIMITS.minResultHeight, WIDGET_LIMITS.maxResultHeight, RESULT_SIZE.h)),
    };
  }
  return {
    w: width,
    h: Math.round(clamp(cfg.miniHeight, WIDGET_LIMITS.minMiniHeight, WIDGET_LIMITS.maxMiniHeight, MINI_SIZE.h)),
  };
}

function setup({ instance, win, save }) {
  const instId = instance.id;
  const listeners = [];
  const handlers = [];
  let resizeSaveTimer = null;
  instance.config = instance.config || {};

  // 这些字段只参与当前窗口的尺寸计算，不能被 saveConfig 写入用户配置。
  delete instance._promptResultExpanded;
  delete instance._promptWorkspaceMode;
  delete instance._promptWorkspaceSize;
  function setRuntime(key, value) {
    Object.defineProperty(instance, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  let cfg = {
    bgOpacity: clamp(instance.config.bgOpacity, 0, 1, 0.4),
    strength: Math.round(clamp(instance.config.strength, 1, 3, 1)),
    pinned: !!instance.config.pinned,
    locked: !!instance.config.locked,
    draft: trimText(instance.config.draft, 16000),
    lastResult: trimText(instance.config.lastResult, 24000),
    widgetWidth: Math.round(clamp(instance.config.widgetWidth, WIDGET_LIMITS.minWidth, WIDGET_LIMITS.maxWidth, MINI_SIZE.w)),
    miniHeight: Math.round(clamp(instance.config.miniHeight, WIDGET_LIMITS.minMiniHeight, WIDGET_LIMITS.maxMiniHeight, MINI_SIZE.h)),
    resultHeight: Math.round(clamp(instance.config.resultHeight, WIDGET_LIMITS.minResultHeight, WIDGET_LIMITS.maxResultHeight, RESULT_SIZE.h)),
  };
  let workspaceMode = 'closed';
  let miniBounds = null;
  let workspaceBounds = null;
  let resultExpanded = !!cfg.lastResult;
  setRuntime('_promptResultExpanded', resultExpanded);
  setRuntime('_promptWorkspaceMode', 'closed');
  setRuntime('_promptWorkspaceSize', null);

  function on(channel, fn) {
    ipcMain.on(channel, fn);
    listeners.push({ channel, fn });
  }
  function handle(channel, fn) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
    handlers.push(channel);
  }
  function persist() {
    instance.config = { ...(instance.config || {}), ...cfg };
    save();
  }
  function state() {
    return {
      ...cfg,
      workspaceMode,
      resultExpanded,
      upstreamVersion: '2.11.8',
      sourceUrl: 'https://github.com/linshenkx/prompt-optimizer',
    };
  }
  function pushState() {
    if (!win.isDestroyed()) win.webContents.send(`prompt:state:${instId}`, state());
  }
  function setBoundsKeepingPosition(size) {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    // Windows 会按上一形态的 min/max 拒绝跨形态缩放（例如结果 330px → 小窗 150px）。
    // 先临时放宽约束，设置完成后由调用方重新应用当前形态的限制。
    win.setMinimumSize(1, 1);
    win.setMaximumSize(10000, 10000);
    win.setBounds({ x, y, width: size.w, height: size.h });
  }
  function applyWidgetResizeLimits() {
    if (win.isDestroyed()) return;
    win.setResizable(true);
    win.setMinimumSize(WIDGET_LIMITS.minWidth, resultExpanded ? WIDGET_LIMITS.minResultHeight : WIDGET_LIMITS.minMiniHeight);
    win.setMaximumSize(WIDGET_LIMITS.maxWidth, resultExpanded ? WIDGET_LIMITS.maxResultHeight : WIDGET_LIMITS.maxMiniHeight);
  }
  function setResultExpanded(expanded) {
    const nextExpanded = !!expanded;
    // 快速优化完成时，renderer 会连续发出“关闭按需工作台”和“展开结果”。
    // 两个 IPC 频道在极端情况下可能交错；这里把结果展开做成原子动作，
    // 防止状态已经是 expanded、窗口却仍停在小形态高度。
    if (nextExpanded && workspaceMode !== 'closed') closeWorkspace();
    resultExpanded = nextExpanded;
    setRuntime('_promptResultExpanded', resultExpanded);
    if (workspaceMode === 'closed') {
      setBoundsKeepingPosition({
        w: cfg.widgetWidth,
        h: resultExpanded ? cfg.resultHeight : cfg.miniHeight,
      });
      applyWidgetResizeLimits();
    }
    pushState();
  }
  function restoreWidgetWindow() {
    if (win.isDestroyed()) return;
    win.setMaximizable(false);
    win.setMinimizable(false);
    win.setSkipTaskbar(true);
    win.setAlwaysOnTop(!!cfg.pinned, cfg.pinned ? 'floating' : 'normal');
    const fallback = {
      w: cfg.widgetWidth,
      h: resultExpanded ? cfg.resultHeight : cfg.miniHeight,
    };
    const current = miniBounds || { ...win.getBounds(), width: fallback.w, height: fallback.h };
    win.setMinimumSize(1, 1);
    win.setMaximumSize(10000, 10000);
    win.setBounds({ x: current.x, y: current.y, width: fallback.w, height: fallback.h });
    applyWidgetResizeLimits();
  }
  function closeWorkspace({ notify = false } = {}) {
    if (workspaceMode === 'closed') return;
    workspaceMode = 'closed';
    setRuntime('_promptWorkspaceMode', 'closed');
    setRuntime('_promptWorkspaceSize', null);
    if (activeWorkspaceId === instId) activeWorkspaceId = null;
    restoreWidgetWindow();
    if (notify && !win.isDestroyed()) win.webContents.send(`prompt:force-mini:${instId}`);
    pushState();
  }
  function claimWorkspace() {
    if (activeWorkspaceId && activeWorkspaceId !== instId) {
      const previous = controllers.get(activeWorkspaceId);
      if (previous) previous.closeWorkspace({ notify: true });
    }
    activeWorkspaceId = instId;
  }
  function openWorkspace(mode) {
    if (win.isDestroyed()) return;
    claimWorkspace();
    if (workspaceMode === 'closed') miniBounds = win.getBounds();
    workspaceMode = mode === 'quick' ? 'quick' : 'visible';
    setRuntime('_promptWorkspaceMode', workspaceMode);
    if (workspaceMode === 'visible') {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const wa = display.workArea;
      const w = Math.min(WORKSPACE_DEFAULT.w, Math.max(760, wa.width - 60));
      const h = Math.min(WORKSPACE_DEFAULT.h, Math.max(560, wa.height - 60));
      const previous = workspaceBounds || {};
      const x = Number.isFinite(previous.x) ? previous.x : wa.x + Math.round((wa.width - w) / 2);
      const y = Number.isFinite(previous.y) ? previous.y : wa.y + Math.round((wa.height - h) / 2);
      win.setResizable(true);
      win.setMaximumSize(10000, 10000);
      win.setMinimumSize(760, 560);
      win.setMaximizable(true);
      win.setMinimizable(true);
      win.setSkipTaskbar(false);
      win.setAlwaysOnTop(false);
      win.setBounds({ x, y, width: w, height: h });
      setRuntime('_promptWorkspaceSize', { w, h });
      win.show();
      win.focus();
    }
    pushState();
  }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((item) => item.id !== instId);
    save();
    if (!win.isDestroyed()) win.close();
  }
  function openModelSettings() {
    openWorkspace('visible');
    win.webContents.send(`prompt:open-model-settings:${instId}`);
  }
  function openMenu() {
    if (win.isDestroyed()) return;
    const transparent = Math.round((1 - cfg.bgOpacity) * 100);
    Menu.buildFromTemplate([
      { label: '打开专业工作台', click: () => openWorkspace('visible') },
      { label: '配置 AI 模型…', click: openModelSettings },
      { label: '优化强度', submenu: [
        { label: '强度 1 · 基础润色', type: 'radio', checked: cfg.strength === 1, click: () => setStrength(1) },
        { label: '强度 2 · 结构增强', type: 'radio', checked: cfg.strength === 2, click: () => setStrength(2) },
        { label: '强度 3 · 专家重构', type: 'radio', checked: cfg.strength === 3, click: () => setStrength(3) },
      ] },
      { type: 'separator' },
      { label: `背景透明度…（${transparent}%）`, click: () => win.webContents.send(`prompt:show-opacity:${instId}`) },
      { label: '置顶显示', type: 'checkbox', checked: cfg.pinned, click: (item) => {
        cfg.pinned = !!item.checked;
        if (workspaceMode !== 'visible') win.setAlwaysOnTop(cfg.pinned, cfg.pinned ? 'floating' : 'normal');
        persist(); pushState();
      } },
      { label: cfg.locked ? '解锁位置' : '锁定位置', click: () => {
        cfg.locked = !cfg.locked;
        persist(); pushState();
      } },
      { type: 'separator' },
      { label: '关于开源组件', click: () => win.webContents.send(`prompt:state:${instId}`, { ...state(), showAbout: true }) },
      { label: '退出此组件', click: quitWidget },
    ]).popup({ window: win });
  }
  function setStrength(value) {
    cfg.strength = Math.round(clamp(value, 1, 3, 1));
    persist(); pushState();
  }

  const controller = { closeWorkspace };
  controllers.set(instId, controller);

  handle(`prompt:init:${instId}`, () => state());
  on(`prompt:draft:${instId}`, (_event, draft) => { cfg.draft = trimText(draft, 16000); persist(); });
  on(`prompt:result:${instId}`, (_event, result) => { cfg.lastResult = trimText(result, 24000); persist(); });
  on(`prompt:strength:${instId}`, (_event, value) => setStrength(value));
  on(`prompt:result-expanded:${instId}`, (_event, expanded) => setResultExpanded(expanded));
  on(`prompt:workspace-open:${instId}`, (_event, mode) => openWorkspace(mode));
  on(`prompt:workspace-close:${instId}`, () => closeWorkspace());
  on(`prompt:workspace-minimize:${instId}`, () => { if (!win.isDestroyed() && workspaceMode === 'visible') win.minimize(); });
  on(`prompt:workspace-maximize:${instId}`, () => {
    if (win.isDestroyed() || workspaceMode !== 'visible') return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  on(`prompt:model-settings:${instId}`, openModelSettings);
  on(`prompt:menu:${instId}`, openMenu);
  on(`prompt:bg-opacity:${instId}`, (_event, opacity) => {
    cfg.bgOpacity = clamp(opacity, 0, 1, cfg.bgOpacity);
    persist(); pushState();
  });

  win.on('resize', () => {
    if (win.isDestroyed() || win.isMaximized()) return;
    const bounds = win.getBounds();
    if (workspaceMode === 'visible') {
      workspaceBounds = bounds;
      setRuntime('_promptWorkspaceSize', { w: bounds.width, h: bounds.height });
      return;
    }
    if (workspaceMode !== 'closed') return;
    cfg.widgetWidth = Math.round(clamp(bounds.width, WIDGET_LIMITS.minWidth, WIDGET_LIMITS.maxWidth, cfg.widgetWidth));
    if (resultExpanded) {
      cfg.resultHeight = Math.round(clamp(bounds.height, WIDGET_LIMITS.minResultHeight, WIDGET_LIMITS.maxResultHeight, cfg.resultHeight));
    } else {
      cfg.miniHeight = Math.round(clamp(bounds.height, WIDGET_LIMITS.minMiniHeight, WIDGET_LIMITS.maxMiniHeight, cfg.miniHeight));
    }
    // 共享拖动引擎会立即读取 instance.config，因此先更新内存，再防抖保存。
    instance.config = { ...(instance.config || {}), ...cfg };
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(persist, 220);
  });
  win.webContents.on('did-finish-load', pushState);
  win.on('closed', () => {
    clearTimeout(resizeSaveTimer);
    if (activeWorkspaceId === instId) activeWorkspaceId = null;
    controllers.delete(instId);
    listeners.forEach(({ channel, fn }) => ipcMain.removeListener(channel, fn));
    handlers.forEach((channel) => ipcMain.removeHandler(channel));
  });

  if (cfg.pinned) win.setAlwaysOnTop(true, 'floating');
  setBoundsKeepingPosition({ w: cfg.widgetWidth, h: resultExpanded ? cfg.resultHeight : cfg.miniHeight });
  applyWidgetResizeLimits();
  // 同时清理早期测试构建可能写入配置文件的 `_prompt*` 临时字段。
  save();
}

module.exports = { MINI_SIZE, RESULT_SIZE, WIDGET_LIMITS, expectedSize, setup };
