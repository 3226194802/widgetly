const { ipcRenderer } = require('electron');

const query = new URLSearchParams(location.search);
const dockId = query.get('inst') || 'preview';
const preview = dockId === 'preview';
const shell = document.getElementById('dockShell');
const surface = document.getElementById('dockSurface');
const grid = document.getElementById('dockGrid');
const empty = document.getElementById('dockEmpty');
const pageBar = document.getElementById('pageBar');
const toast = document.getElementById('dockToast');

let model = null;
let toastTimer = null;
let dragging = false;
let dockLocked = false;
let childInteraction = null;
let dropPreview = null;
let childPreviewTimer = null;

const PREVIEW_CHILDREN = [
  { id: 'preview-clock', widgetId: 'digitalClockGlass', name: '桌面时钟日历·精简', slotId: 'slot-clock', surface: 'inherit' },
  { id: 'preview-calendar', widgetId: 'miniCalendarGlass', name: '桌面小日历', slotId: 'slot-calendar', surface: 'inherit' },
  { id: 'preview-weather', widgetId: 'lineWeather', name: '桌面折线天气', slotId: 'slot-weather', surface: 'inherit' },
];

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = String(message || '');
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}
function defaultModel() {
  return {
    dock: { config: { layout: 'free', gap: 10, padding: 10, backgroundTransparency: 80, style: 'unified', page: 0 } },
    children: PREVIEW_CHILDREN,
  };
}
function currentDockConfig() {
  return (model && model.dock && model.dock.config) || {};
}
function currentChildren() {
  return Array.isArray(model && model.children) ? model.children.filter((item) => !item.hidden) : [];
}
function fallbackRects(count) {
  if (count <= 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  if (count === 2) return [{ x: 0, y: 0, w: .491, h: 1 }, { x: .509, y: 0, w: .491, h: 1 }];
  if (count === 3) return [{ x: 0, y: 0, w: .575, h: 1 }, { x: .595, y: 0, w: .405, h: .491 }, { x: .595, y: .509, w: .405, h: .491 }];
  const cols = count >= 6 ? 3 : 2; const rows = Math.ceil(count / cols); const gap = .018;
  return Array.from({ length: count }, (_, index) => ({
    x: index % cols / cols + (index % cols ? gap / 2 : 0), y: Math.floor(index / cols) / rows + (Math.floor(index / cols) ? gap / 2 : 0),
    w: 1 / cols - gap * (cols - 1) / cols, h: 1 / rows - gap * (rows - 1) / rows,
  }));
}
function rectOf(child, index, count) {
  const fallback = fallbackRects(count)[index] || { x: 0, y: 0, w: 1, h: 1 };
  const source = child && child.rect && typeof child.rect === 'object' ? child.rect : fallback;
  const w = clamp(source.w, .12, 1, fallback.w); const h = clamp(source.h, .1, 1, fallback.h);
  const x = Math.min(clamp(source.x, 0, .92, fallback.x), 1 - w);
  const y = Math.min(clamp(source.y, 0, .92, fallback.y), 1 - h);
  return { x, y, w, h };
}
function applySlotRect(slot, rect) {
  slot.style.setProperty('--slot-x', `${rect.x * 100}%`);
  slot.style.setProperty('--slot-y', `${rect.y * 100}%`);
  slot.style.setProperty('--slot-w', `${rect.w * 100}%`);
  slot.style.setProperty('--slot-h', `${rect.h * 100}%`);
}
function aspectClass() {
  const rect = shell.getBoundingClientRect();
  if (!rect.height) return 'shape-square';
  if (rect.width / rect.height > 1.22) return 'shape-wide';
  if (rect.width / rect.height < .84) return 'shape-tall';
  return 'shape-square';
}
function gridClass(children, cfg) {
  const layout = String(cfg.layout || 'smart');
  if (layout !== 'smart') return `layout-${layout}`;
  const shape = aspectClass();
  if (children.length <= 1) return 'layout-single';
  if (children.length === 2) return shape === 'shape-tall' ? 'layout-vertical' : 'layout-horizontal';
  if (children.length === 3) return shape === 'shape-tall' ? 'layout-vertical' : 'layout-feature';
  if (children.length === 4) return 'layout-grid';
  return shape === 'shape-wide' ? 'layout-many-wide' : 'layout-many';
}
function applyDockStyle() {
  const cfg = currentDockConfig();
  const transparency = clamp(cfg.backgroundTransparency, 0, 100, 80);
  shell.style.setProperty('--dock-alpha', String(1 - transparency / 100));
  shell.style.setProperty('--dock-gap', `${clamp(cfg.gap, 0, 30, 10)}px`);
  shell.style.setProperty('--dock-padding', `${clamp(cfg.padding, 0, 42, 10)}px`);
  shell.classList.toggle('light', cfg.theme === 'light');
  shell.classList.toggle('flat', cfg.style === 'flat');
  shell.classList.toggle('is-locked', dockLocked || !!cfg.locked);
}
function frameUrl(child) {
  const surfaceMode = child.surface === 'card' ? 'card' : 'inherit';
  const frameInstance = preview ? 'preview' : child.id;
  return `../studio/index.html?inst=${encodeURIComponent(frameInstance)}&wid=${encodeURIComponent(child.widgetId)}&host=componentDock&surface=${surfaceMode}`;
}
function installFrameHooks(frame, child) {
  frame.addEventListener('load', () => {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__widgetlyDockContext) return;
      doc.__widgetlyDockContext = true;
      doc.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!preview) ipcRenderer.send('widgetly-common-menu:' + dockId, { childId: child.id, childName: child.name || child.widgetId });
      }, true);
      doc.addEventListener('mousedown', () => {
        if (!preview) ipcRenderer.send('activate');
      }, true);
    } catch (_) {
      // 子页面短暂重载时不阻断组件坞本身；下一次 load 会重新安装菜单拦截。
    }
  });
}
function render() {
  if (!model) model = defaultModel();
  applyDockStyle();
  const cfg = currentDockConfig();
  const all = currentChildren();
  const layout = String(cfg.layout || 'smart');
  const pageSize = clamp(cfg.pageSize, 1, 6, 6);
  const isPaged = layout === 'pages';
  const page = clamp(cfg.page, 0, Math.max(0, Math.ceil(all.length / pageSize) - 1), 0);
  const children = isPaged ? all.slice(page * pageSize, page * pageSize + pageSize) : all;
  grid.className = `dock-grid dock-canvas ${aspectClass()}`;
  grid.innerHTML = '';
  empty.hidden = children.length > 0;
  grid.hidden = children.length === 0;
  children.forEach((child, index) => {
    const slot = document.createElement('section');
    slot.className = 'dock-slot' + (child.surface === 'card' ? ' own-surface' : '');
    slot.dataset.childId = child.id;
    slot.dataset.index = String(index);
    slot.title = child.name || child.widgetId;
    applySlotRect(slot, rectOf(child, index, children.length));
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'dock-item-handle'; handle.dataset.dockControl = 'move';
    handle.title = `拖动 ${child.name || child.widgetId}`; handle.setAttribute('aria-label', handle.title); handle.textContent = '⠿';
    const frame = document.createElement('iframe');
    frame.className = 'dock-frame';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('tabindex', '0');
    frame.src = frameUrl(child);
    installFrameHooks(frame, child);
    slot.appendChild(frame); slot.appendChild(handle);
    ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].forEach((edge) => {
      const resize = document.createElement('button');
      resize.type = 'button'; resize.className = `dock-item-resize edge-${edge}`; resize.dataset.dockControl = `resize-${edge}`;
      resize.title = `从${edge}方向调整 ${child.name || child.widgetId} 大小`; resize.setAttribute('aria-label', resize.title);
      resize.addEventListener('pointerdown', (event) => beginChildInteraction(event, slot, child, `resize-${edge}`));
      slot.appendChild(resize);
    });
    handle.addEventListener('pointerdown', (event) => beginChildInteraction(event, slot, child, 'move'));
    grid.appendChild(slot);
  });
  const pages = Math.ceil(all.length / pageSize);
  pageBar.hidden = !isPaged || pages <= 1;
  if (!pageBar.hidden) {
    pageBar.innerHTML = Array.from({ length: pages }, (_, index) => `<button type="button" data-page="${index}" class="${index === page ? 'active' : ''}" aria-label="第 ${index + 1} 页"></button>`).join('');
  }
}

function beginChildInteraction(event, slot, child, type) {
  if (preview || dockLocked || currentDockConfig().locked || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const canvas = grid.getBoundingClientRect();
  if (!canvas.width || !canvas.height) return;
  const rect = rectOf(child, Number(slot.dataset.index) || 0, currentChildren().length);
  childInteraction = { pointerId: event.pointerId, slot, child, type, startX: event.clientX, startY: event.clientY, canvas, rect, next: rect, grow: { x: 0, y: 0 } };
  slot.classList.add('editing');
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
  ipcRenderer.send('activate');
}
function updateChildInteraction(event) {
  const state = childInteraction;
  if (!state || event.pointerId !== state.pointerId) return;
  const dx = (event.clientX - state.startX) / state.canvas.width;
  const dy = (event.clientY - state.startY) / state.canvas.height;
  let raw = state.type === 'move' ? { ...state.rect, x: state.rect.x + dx, y: state.rect.y + dy } : { ...state.rect };
  if (state.type.startsWith('resize-')) {
    const edge = state.type.slice('resize-'.length);
    if (edge.includes('e')) raw.w = state.rect.w + dx;
    if (edge.includes('s')) raw.h = state.rect.h + dy;
    if (edge.includes('w')) { raw.x = state.rect.x + dx; raw.w = state.rect.w - dx; }
    if (edge.includes('n')) { raw.y = state.rect.y + dy; raw.h = state.rect.h - dy; }
  }
  state.grow = { x: Math.max(0, raw.x + raw.w - .985), y: Math.max(0, raw.y + raw.h - .985) };
  const w = clamp(raw.w, .12, 1, state.rect.w); const h = clamp(raw.h, .10, 1, state.rect.h);
  state.next = { x: Math.min(clamp(raw.x, 0, 1, state.rect.x), 1 - w), y: Math.min(clamp(raw.y, 0, 1, state.rect.y), 1 - h), w, h };
  applySlotRect(state.slot, state.next);
  // 在拖动过程中持续让主进程求解无重叠布局。只移动其它卡片，不重建任意 iframe，
  // 用户会看到其它组件被实时、平滑地挤开，而不是松手后突然闪一下。
  if (!childPreviewTimer && !preview) {
    childPreviewTimer = setTimeout(() => {
      childPreviewTimer = null;
      const active = childInteraction;
      if (!active) return;
      ipcRenderer.send('componentDock:command:' + dockId, { action: 'child-rect-preview', childId: active.child.id, rect: active.next, intent: active.type });
    }, 32);
  }
}
function applyLayoutModel(next) {
  if (!next || !next.dock) return;
  model = next; dockLocked = !!(next.dock.config && next.dock.config.locked); applyDockStyle();
  const children = currentChildren(); const byId = new Map(children.map((item) => [item.id, item]));
  grid.querySelectorAll('.dock-slot[data-child-id]').forEach((slot) => {
    const child = byId.get(slot.dataset.childId);
    if (!child) return;
    // 当前手指/鼠标正在调的组件由本地像素位置直接控制，避免异步预览回包把它拉回上一帧。
    if (childInteraction && childInteraction.child.id === child.id) return;
    applySlotRect(slot, rectOf(child, Number(slot.dataset.index) || 0, children.length));
  });
}
function clearDropPreview() {
  dropPreview = null; shell.classList.remove('drop-preview-active', 'drop-preview-rejected');
  const ghost = grid.querySelector('.dock-drop-ghost'); if (ghost) ghost.remove();
  if (model) applyLayoutModel(model);
}
function applyDropPreview(data) {
  if (!data || !data.active) return clearDropPreview();
  dropPreview = data; shell.classList.add('drop-preview-active');
  shell.classList.toggle('drop-preview-rejected', !!data.rejected);
  const layouts = new Map((data.layouts || []).map((item) => [String(item.id), item.rect]));
  grid.querySelectorAll('.dock-slot[data-child-id]').forEach((slot) => {
    const rect = layouts.get(slot.dataset.childId); if (rect) applySlotRect(slot, rect);
  });
  let ghost = grid.querySelector('.dock-drop-ghost');
  if (!ghost) { ghost = document.createElement('div'); ghost.className = 'dock-drop-ghost'; grid.appendChild(ghost); }
  ghost.classList.toggle('rejected', !!data.rejected);
  ghost.textContent = data.rejected
    ? '此组件暂不支持放入组件坞'
    : (data.pending ? `停留片刻以加入：${data.childName || '新组件'}` : `松开以加入：${data.childName || '新组件'}`);
  applySlotRect(ghost, data.rect || { x: .3, y: .3, w: .35, h: .35 });
}
function finishChildInteraction(event) {
  const state = childInteraction;
  if (!state || (event && event.pointerId !== state.pointerId)) return;
  childInteraction = null; state.slot.classList.remove('editing');
  if (childPreviewTimer) { clearTimeout(childPreviewTimer); childPreviewTimer = null; }
  if (preview) return;
  ipcRenderer.send('componentDock:command:' + dockId, { action: 'child-rect', childId: state.child.id, rect: state.next, grow: state.grow, intent: state.type });
}
window.addEventListener('pointermove', updateChildInteraction, true);
window.addEventListener('pointerup', finishChildInteraction, true);
window.addEventListener('pointercancel', finishChildInteraction, true);
async function refresh() {
  if (preview) { model = defaultModel(); render(); return; }
  try {
    model = await ipcRenderer.invoke('componentDock:get:' + dockId);
    if (!model || !model.dock) throw new Error('组件坞数据不可用');
    render();
  } catch (error) {
    showToast('组件坞加载失败，可右键打开编辑页面修复');
  }
}

surface.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.dock-slot')) return;
  event.preventDefault();
  if (!preview) ipcRenderer.send('widgetly-common-menu:' + dockId, {});
});
surface.addEventListener('mousedown', (event) => {
  if (preview || dockLocked || event.button !== 0 || event.target.closest('.dock-slot,button')) return;
  dragging = true;
  ipcRenderer.send('activate');
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (!preview) ipcRenderer.send('drag-end');
});
window.addEventListener('blur', () => {
  if (!dragging) return;
  dragging = false;
  if (!preview) ipcRenderer.send('drag-end');
});
pageBar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (!button || preview) return;
  ipcRenderer.send('componentDock:command:' + dockId, { action: 'page', page: Number(button.dataset.page) });
});
ipcRenderer.on('componentDock:changed:' + dockId, refresh);
ipcRenderer.on('componentDock:layout:' + dockId, (_event, next) => { clearDropPreview(); applyLayoutModel(next); });
ipcRenderer.on('componentDock:drop-preview:' + dockId, (_event, data) => applyDropPreview(data));
ipcRenderer.on('widgetly:background-transparency:' + dockId, (_event, data) => {
  if (!model || !model.dock || !data) return;
  model.dock.config = model.dock.config || {};
  model.dock.config.backgroundTransparency = Number(data.percent);
  applyDockStyle();
});
ipcRenderer.on('widgetly:common-state:' + dockId, (_event, state) => {
  dockLocked = !!(state && state.locked);
  applyDockStyle();
});
ipcRenderer.on('dockgroup:toast:' + dockId, (_event, message) => showToast(message));
// 外层组件坞改变大小时，iframe 的视口会自然跟随 CSS 尺寸变化；不能调用 render()
// 重建全部 iframe，否则天气会重新定位、闹钟/计时器也会产生一次不必要的刷新。
window.addEventListener('resize', () => applyDockStyle());
refresh();
