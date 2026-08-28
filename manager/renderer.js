// Widgetly 管理器 —— 左侧分类导航 + 搜索过滤 + 原始尺寸预览
const { ipcRenderer } = require('electron');
const grid = document.getElementById('grid');
const nav = document.getElementById('nav');
const searchInput = document.getElementById('searchInput');
const libraryTitle = document.getElementById('libraryTitle');
const resultCount = document.getElementById('resultCount');
const libraryView = document.getElementById('libraryView');
const myWidgetsView = document.getElementById('myWidgetsView');
const mineNav = document.getElementById('mineNav');
const mineNavCount = document.getElementById('mineNavCount');
const myWidgetsGrid = document.getElementById('myWidgetsGrid');
const myWidgetsEmpty = document.getElementById('myWidgetsEmpty');
const myWidgetsSummary = document.getElementById('myWidgetsSummary');
const myWidgetsFootHint = document.getElementById('myWidgetsFootHint');
const manageWidgetsButton = document.getElementById('manageWidgets');
ipcRenderer.invoke('app-version').then((version) => {
  const node = document.querySelector('.foot-ver');
  if (node && version) node.textContent = 'v' + version;
}).catch(() => {});

let categories = [];
let widgets = [];
let activeCategory = 'all';
let searchQuery = '';
let activeView = 'library';
let myWidgetGroups = [];
let managingMyWidgets = false;
let dragId = null;   // 当前正在拖拽排序的组件 id

function filtered() {
  return widgets.filter((w) => {
    if (activeCategory !== 'all' && w.category !== activeCategory) return false;
    if (searchQuery && !w.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
}

// ---------- 分类导航 ----------
function renderNav() {
  nav.innerHTML = '';
  if (mineNav) mineNav.classList.toggle('active', activeView === 'mine');
  categories.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'nav-item' + (activeView === 'library' && c.id === activeCategory ? ' active' : '');
    item.dataset.cat = c.id;

    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.innerHTML = c.icon || '';
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = c.name;

    item.appendChild(icon);
    item.appendChild(label);
    item.addEventListener('click', () => {
      activeCategory = c.id;
      showLibrary();
      renderNav();
      applyFilter();
    });
    nav.appendChild(item);
  });
}

// ---------- 卡片（两级正方形容器；iframe 缓存：只创建一次，过滤时仅切换显示） ----------
const itemCache = {};

// 绝大多数组件使用一行四张的普通正方形；只有信息密度确实高、在小预览里
// 无法辨认的组件使用一行两张的大正方形。组件本身仍按原始比例等比缩放，
// 因此横条、竖条和方形组件都不会被拉伸变形。
const LARGE_SQUARE_IDS = new Set([
  'plannerCalendar',
  'quadrantTasks',
  'clockCalendar',
  'desktopFolder',
  'markdownNote',
  'classSchedule',
  'calendarXL',
  'monitor',
  'miniCalendarGlass',
  'lineWeather',
  'componentDock',
]);

const TILE_ORDER = ['square', 'large-square'];
function tileRank(widget) {
  const index = TILE_ORDER.indexOf(tileFor(widget).name);
  return index < 0 ? TILE_ORDER.length : index;
}

function tileFor(w) {
  return LARGE_SQUARE_IDS.has(w.id)
    ? { cols: 6, name: 'large-square' }
    : { cols: 3, name: 'square' };
}

// CSS Grid 的百分比行高会相对容器高度计算，不能直接拿来做响应式正方形。
// 这里根据网格的真实可用宽度计算单列宽度，再把同一个数值交给纵向轨道；
// 普通卡片横纵各跨 4 格，大卡片横纵各跨 6 格，因此窗口缩放后仍严格等宽等高。
function syncGridUnit() {
  const style = getComputedStyle(grid);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const available = grid.clientWidth - padding - gap * 11;
  if (available > 0) grid.style.setProperty('--grid-unit', `${available / 12}px`);
}
syncGridUnit();
window.addEventListener('resize', () => requestAnimationFrame(syncGridUnit));

function makeItem(w) {
  const item = document.createElement('div');
  const tile = tileFor(w);
  item.className = `item tile-${tile.name}`;
  item.style.setProperty('--tile-cols', String(tile.cols));
  item.style.gridColumn = `span ${tile.cols}`;
  item.style.gridRow = `span ${tile.cols}`;
  item.dataset.tile = tile.name;

  // 预览缩放容器：iframe 保持原始尺寸，由 .scaler 等比缩放到格子内
  const box = document.createElement('div');
  box.className = 'box';
  const scaler = document.createElement('div');
  scaler.className = 'scaler';
  scaler.style.width = (w.w || 300) + 'px';
  scaler.style.height = (w.h || 150) + 'px';

  const frame = document.createElement('iframe');
  frame.className = 'frame';
  frame.setAttribute('scrolling', 'no');
  frame.style.width = (w.w || 300) + 'px';
  frame.style.height = (w.h || 150) + 'px';
  scaler.appendChild(frame);
  box.appendChild(scaler);
  item._frame = frame;
  item._scaler = scaler;

  const name = document.createElement('div');
  name.className = 'name';
  const nameText = document.createElement('strong');
  nameText.textContent = w.name;
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = w.count ? `桌面已有 ${w.count} 个` : '点击添加';
  name.append(nameText, meta);

  item.append(box, name);
  item.dataset.wid = w.id;
  item.addEventListener('click', () => {
    item.classList.add('pulse');
    setTimeout(() => item.classList.remove('pulse'), 300);
    w.count = Number(w.count || 0) + 1;
    meta.textContent = `桌面已有 ${w.count} 个`;
    ipcRenderer.send('add-widget', w.id);
  });

  // ---------- 拖拽排序：只在同尺寸正方形组内调整，防止两种规格再次混排 ----------
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    dragId = w.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', w.id); } catch (_) {}
  });
  item.addEventListener('dragend', () => {
    dragId = null;
    item.classList.remove('dragging');
    clearInsertIndicator();
  });
  return item;
}

// ---------- 我的小组件：按组件类型合并，管理模式下可精确删除某一个桌面实例 ----------
function makeMyWidgetItem(group) {
  const item = document.createElement('article');
  item.className = 'item my-widget-card';
  item.dataset.wid = group.id;
  item._previewWidget = group;

  const box = document.createElement('div');
  box.className = 'box';
  const scaler = document.createElement('div');
  scaler.className = 'scaler';
  scaler.style.width = (group.w || 300) + 'px';
  scaler.style.height = (group.h || 150) + 'px';
  const frame = document.createElement('iframe');
  frame.className = 'frame';
  frame.setAttribute('scrolling', 'no');
  frame.style.width = (group.w || 300) + 'px';
  frame.style.height = (group.h || 150) + 'px';
  scaler.appendChild(frame);
  box.appendChild(scaler);
  item._frame = frame;
  item._scaler = scaler;

  const name = document.createElement('div');
  name.className = 'name';
  const nameText = document.createElement('strong');
  nameText.textContent = group.name;
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = `桌面已有 ${group.count} 个`;
  name.append(nameText, meta);
  item.append(box, name);

  if (group.count > 1) {
    const badge = document.createElement('span');
    badge.className = 'repeat-badge';
    badge.textContent = `×${group.count}`;
    badge.title = `桌面上有 ${group.count} 个“${group.name}”`;
    item.appendChild(badge);
  }

  const manageLayer = document.createElement('div');
  manageLayer.className = 'my-widget-manage-layer';
  const manageTitle = document.createElement('div');
  manageTitle.className = 'my-widget-manage-title';
  manageTitle.textContent = `管理 ${group.name}`;
  const instanceList = document.createElement('div');
  instanceList.className = 'my-widget-instance-list';
  group.instances.forEach((instance, index) => {
    const row = document.createElement('div');
    row.className = 'my-widget-instance';
    const label = document.createElement('span');
    label.textContent = group.count > 1 ? `第 ${index + 1} 个` : '桌面上的此组件';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'my-widget-remove';
    remove.textContent = '删除';
    remove.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const displayName = group.count > 1 ? `${group.name}（第 ${index + 1} 个）` : group.name;
      if (!window.confirm(`确定从桌面删除“${displayName}”吗？`)) return;
      remove.disabled = true;
      try {
        const result = await ipcRenderer.invoke('remove-widget:request', instance.id);
        if (result && result.ok) {
          await Promise.all([refreshMyWidgets(), refreshLibraryCounts()]);
        }
      } finally {
        remove.disabled = false;
      }
    });
    row.append(label, remove);
    instanceList.appendChild(row);
  });
  manageLayer.append(manageTitle, instanceList);
  item.appendChild(manageLayer);
  item.classList.toggle('is-managing', managingMyWidgets);

  loadFrame(item, group);
  requestAnimationFrame(() => fitScaler(item, group));
  if (ro) ro.observe(item);
  return item;
}

function renderMyWidgets() {
  if (!myWidgetsGrid) return;
  if (ro) myWidgetsGrid.querySelectorAll('.my-widget-card').forEach((item) => ro.unobserve(item));
  myWidgetsGrid.innerHTML = '';
  const visibleGroups = myWidgetGroups.filter((group) => !searchQuery || group.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const instanceTotal = myWidgetGroups.reduce((total, group) => total + group.count, 0);
  const visibleTotal = visibleGroups.reduce((total, group) => total + group.count, 0);

  visibleGroups.forEach((group, index) => {
    const item = makeMyWidgetItem(group);
    item.style.animationDelay = `${30 + index * 45}ms`;
    myWidgetsGrid.appendChild(item);
  });
  const hasGroups = visibleGroups.length > 0;
  if (myWidgetsEmpty) {
    myWidgetsEmpty.hidden = hasGroups || searchQuery.length > 0;
    myWidgetsEmpty.classList.toggle('search-empty', !hasGroups && !!searchQuery);
    if (!hasGroups && searchQuery) {
      myWidgetsEmpty.querySelector('strong').textContent = '没有找到相关的小组件';
      myWidgetsEmpty.querySelector('p').textContent = '换一个关键词试试看。';
    } else {
      myWidgetsEmpty.querySelector('strong').textContent = '桌面上还没有小组件';
      myWidgetsEmpty.querySelector('p').textContent = '到“全部组件”中挑选一个添加到桌面吧。';
    }
  }
  if (myWidgetsSummary) {
    myWidgetsSummary.textContent = searchQuery
      ? `找到 ${visibleGroups.length} 类、${visibleTotal} 个桌面组件`
      : (instanceTotal ? `桌面共 ${instanceTotal} 个 · 已合并为 ${myWidgetGroups.length} 类` : '桌面上暂未添加组件');
  }
  if (mineNavCount) {
    mineNavCount.textContent = instanceTotal;
    mineNavCount.hidden = instanceTotal === 0;
  }
  if (myWidgetsFootHint) myWidgetsFootHint.textContent = managingMyWidgets ? '点击“删除”可移除对应的桌面组件' : '相同组件已自动合并显示 · 点击右上角管理';
  if (manageWidgetsButton) {
    manageWidgetsButton.textContent = managingMyWidgets ? '完成管理' : '管理';
    manageWidgetsButton.classList.toggle('is-active', managingMyWidgets);
    manageWidgetsButton.disabled = instanceTotal === 0;
  }
}

async function refreshMyWidgets() {
  try {
    const groups = await ipcRenderer.invoke('my-widgets-list');
    myWidgetGroups = Array.isArray(groups) ? groups : [];
    if (activeView === 'mine') renderMyWidgets();
    else {
      const total = myWidgetGroups.reduce((sum, group) => sum + group.count, 0);
      if (mineNavCount) { mineNavCount.textContent = total; mineNavCount.hidden = total === 0; }
    }
  } catch (_) {
    myWidgetGroups = [];
    if (activeView === 'mine') renderMyWidgets();
  }
}

async function refreshLibraryCounts() {
  try {
    const data = await ipcRenderer.invoke('widgets-list');
    const counts = new Map((data.widgets || []).map((widget) => [widget.id, Number(widget.count || 0)]));
    widgets.forEach((widget) => {
      widget.count = counts.get(widget.id) || 0;
      const item = itemCache[widget.id];
      const meta = item && item.querySelector('.item-meta');
      if (meta) meta.textContent = widget.count ? `桌面已有 ${widget.count} 个` : '点击添加';
    });
  } catch (_) {}
}

function showLibrary() {
  activeView = 'library';
  if (libraryView) libraryView.hidden = false;
  if (myWidgetsView) myWidgetsView.hidden = true;
}

async function showMyWidgets() {
  activeView = 'mine';
  if (libraryView) libraryView.hidden = true;
  if (myWidgetsView) myWidgetsView.hidden = false;
  renderNav();
  await refreshMyWidgets();
}

// 等比缩放预览到正方形预览区内；预览保持组件原始比例，不拉伸、不裁切。
function fitScaler(item, w) {
  const box = item.querySelector('.box');
  const { width: availW, height: availH } = box ? box.getBoundingClientRect() : { width: 0, height: 0 };
  if (!availW || !availH) return;
  const s = Math.min(availW / (w.w || 300), availH / (w.h || 150));
  item._scaler.style.transform = `scale(${Math.max(0.2, s)})`;
}
// ResizeObserver：窗口/布局变化时重算缩放
const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  entries.forEach((en) => {
    const item = en.target;
    const w = item._previewWidget || widgets.find((x) => x.id === item.dataset.wid);
    if (w) fitScaler(item, w);
  });
}) : null;

// 清除插入指示线
function clearInsertIndicator() {
  document.querySelectorAll('.item.insert-before, .item.insert-after').forEach((x) => x.classList.remove('insert-before', 'insert-after'));
}

// 计算插入位置：找鼠标最近的可见卡片，按鼠标在卡片左/右半边判断插到其前/后。
// 空位（大卡片右侧/下方）会命中最近卡片 → 插到其后，从而把小卡片放进空位。
function getInsertTarget(cx, cy) {
  // 只允许同尺寸卡片互相排序，防止普通正方形和大正方形重新混在一起。
  const dragTile = itemCache[dragId] && itemCache[dragId].dataset.tile;
  const cards = [...grid.querySelectorAll('.item')].filter((c) => c.style.display !== 'none' && c.dataset.wid !== dragId && c.dataset.tile === dragTile);
  if (!cards.length) return null;
  let best = null, bestDist = Infinity;
  cards.forEach((c) => {
    const r = c.getBoundingClientRect();
    const midX = r.left + r.width / 2;
    const midY = r.top + r.height / 2;
    const d = Math.hypot(cx - midX, cy - midY);
    if (d < bestDist) { bestDist = d; best = { wid: c.dataset.wid, before: cx < midX }; }
  });
  return best;
}

// 把 fromId 插入到 targetWid 的前/后（数组 + DOM 同步，移动节点保证 iframe 不重载）
function insertWidget(fromId, targetWid, before) {
  if (fromId === targetWid) return;
  const fromIdx = widgets.findIndex((w) => w.id === fromId);
  const toIdx = widgets.findIndex((w) => w.id === targetWid);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = widgets.splice(fromIdx, 1);
  let insertIdx = widgets.findIndex((w) => w.id === targetWid);
  if (!before) insertIdx += 1;
  widgets.splice(insertIdx, 0, moved);
  const fromEl = itemCache[fromId];
  const toEl = itemCache[targetWid];
  if (fromEl && toEl) {
    if (before) grid.insertBefore(fromEl, toEl);
    else grid.insertBefore(fromEl, toEl.nextSibling);
  }
  ipcRenderer.send('widget-order:save', widgets.map((w) => w.id));
}

// 网格级拖放：捕获拖到空位的情况（卡片上的 dragover/drop 会冒泡到这里）
grid.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const t = getInsertTarget(e.clientX, e.clientY);
  clearInsertIndicator();
  if (t && t.wid !== dragId) {
    const el = itemCache[t.wid];
    if (el) el.classList.add(t.before ? 'insert-before' : 'insert-after');
  }
});
grid.addEventListener('drop', (e) => {
  e.preventDefault();
  const t = getInsertTarget(e.clientX, e.clientY);
  clearInsertIndicator();
  if (dragId && t && t.wid !== dragId) insertWidget(dragId, t.wid, t.before);
});

// ---------- 预览 iframe 并发受限加载：卡片外形先出，内容排队填入 ----------
// 问题：一次性加载全部预览 iframe（每个是独立渲染进程）会造成 CPU 峰值卡顿。
// 方案：视口内才进队列 + 同时最多 2 个加载 + 间隔 120ms；卡片有毛玻璃占位壳，
//       外形/名字立即可见，iframe 加载完淡入覆盖，视觉体验无损失。
const frameQueue = [];     // 待加载 {frame, url}
let frameLoading = 0;      // 当前并发数
const FRAME_CONCURRENCY = 2;
const FRAME_GAP_MS = 120;

function pumpFrameQueue() {
  while (frameLoading < FRAME_CONCURRENCY && frameQueue.length) {
    const { frame, item } = frameQueue.shift();
    frameLoading++;
    frame.addEventListener('load', () => {
      item.classList.add('loaded');   // 淡入覆盖占位壳
      frameLoading--;
      pumpFrameQueue();
    }, { once: true });
    frame.addEventListener('error', () => {
      frameLoading--;
      pumpFrameQueue();
    }, { once: true });
    frame.src = frame.dataset.src;
    frame.removeAttribute('data-src');
  }
}

function loadFrame(item, w) {
  const frame = item._frame;
  if (!frame || frame.src || frame.dataset.src) return;
  frame.dataset.src = `../widgets/${w.dir || w.id}/${w.entry}?inst=preview&wid=${w.id}`;
  frameQueue.push({ frame, item });
  pumpFrameQueue();
}

// 视口监听：滚动到视口内才真正加载（懒加载手动实现，比 loading=lazy 更可控）
let frameIO = null;
function observeFrames() {
  if (frameIO || typeof IntersectionObserver !== 'function') return;
  frameIO = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        const item = en.target;
        frameIO.unobserve(item);
        const w = widgets.find((x) => x.id === item.dataset.wid);
        if (w) loadFrame(item, w);
      }
    });
  }, { root: grid, rootMargin: '200px 0px' });
  Object.values(itemCache).forEach((item) => {
    if (!item._frame.src && !item._frame.dataset.src) frameIO.observe(item);
  });
}

function applyFilter() {
  if (activeView !== 'library') {
    renderMyWidgets();
    return;
  }
  widgets.forEach((w) => {
    const item = itemCache[w.id];
    if (!item) return;
    const show = (activeCategory === 'all' || w.category === activeCategory)
      && (!searchQuery || w.name.toLowerCase().includes(searchQuery.toLowerCase()));
    item.style.display = show ? '' : 'none';
  });
  let previousVisibleTile = '';
  [...grid.querySelectorAll('.item')].forEach((item) => {
    if (item.style.display === 'none') { item.classList.remove('group-start'); return; }
    const startsGroup = item.dataset.tile !== previousVisibleTile;
    item.classList.toggle('group-start', startsGroup);
    previousVisibleTile = item.dataset.tile;
  });
  // 显示状态变化后重新观察：视口内可见卡片由 IntersectionObserver 触发排队加载
  if (frameIO) {
    Object.values(itemCache).forEach((item) => {
      const frame = item._frame;
      if (item.style.display !== 'none' && !frame.src && !frame.dataset.src) frameIO.observe(item);
    });
  }
  const anyVisible = widgets.some((w) => itemCache[w.id] && itemCache[w.id].style.display !== 'none');
  const visibleCount = widgets.filter((w) => itemCache[w.id] && itemCache[w.id].style.display !== 'none').length;
  const category = categories.find((item) => item.id === activeCategory);
  if (libraryTitle) libraryTitle.textContent = searchQuery ? '搜索结果' : ((category && category.name) || '全部') + '组件';
  if (resultCount) resultCount.textContent = searchQuery ? `找到 ${visibleCount} 个与“${searchQuery}”相关的组件` : `共 ${visibleCount} 个 · 旧组件与新组件均已保留`;
  let tip = document.getElementById('emptyTip');
  if (!anyVisible) {
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'emptyTip';
      tip.style.cssText = 'grid-column:1/-1;text-align:center;padding:40px 0;color:rgba(255,255,255,0.6);font-size:13px;';
      tip.textContent = '该分类下暂无组件';
      grid.appendChild(tip);
    }
    tip.style.display = '';
  } else if (tip) {
    tip.style.display = 'none';
  }
}

// 添加时的弹跳
const style = document.createElement('style');
style.textContent = `
.item.pulse { animation: pulseItem 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes pulseItem { 0% { transform: scale(1); } 50% { transform: scale(1.04); } 100% { transform: scale(1); } }
`;
document.head.appendChild(style);

// 顶栏按钮
document.getElementById('btnSettings').addEventListener('click', () => ipcRenderer.send('settings-open'));
document.getElementById('btnMinimize').addEventListener('click', () => ipcRenderer.send('manager-minimize'));
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('manager-close'));
// × 的语义随设置开关变化：开启时隐藏到托盘，关闭时彻底退出。
const closeButton = document.getElementById('btnClose');
function paintCloseButton(closeToTray) {
  closeButton.title = closeToTray ? '关闭时最小化到托盘' : '退出软件';
}
(async () => {
  try { paintCloseButton(await ipcRenderer.invoke('closeToTray:get')); } catch (_) { paintCloseButton(true); }
})();
ipcRenderer.on('closeToTray:changed', (_e, on) => paintCloseButton(!!on));

// ---------- 拖动期间关闭毛玻璃（软件渲染下实时模糊会让拖动卡死） ----------
const topbar = document.querySelector('.topbar');
let dragOffTimer = null;
function setDragging(on) {
  document.documentElement.classList.toggle('dragging', on);
}
topbar.addEventListener('mousedown', (e) => {
  // 按钮/滑杆不触发拖动（它们有 no-drag 区，但 mousedown 仍会冒泡到这里，排除掉）
  if (e.target.closest('.tb-btn, .opacity-ctl')) return;
  setDragging(true);
  if (dragOffTimer) clearTimeout(dragOffTimer);
  dragOffTimer = setTimeout(() => setDragging(false), 3000);   // 保险：3 秒后恢复
});
window.addEventListener('mouseup', () => {
  if (dragOffTimer) clearTimeout(dragOffTimer);
  setDragging(false);
});
window.addEventListener('blur', () => {
  if (dragOffTimer) clearTimeout(dragOffTimer);
  setDragging(false);
});

// 搜索
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  if (activeView === 'mine') renderMyWidgets();
  else applyFilter();
});

mineNav.addEventListener('click', () => { showMyWidgets(); });
manageWidgetsButton.addEventListener('click', () => {
  if (!myWidgetGroups.reduce((sum, group) => sum + group.count, 0)) return;
  managingMyWidgets = !managingMyWidgets;
  renderMyWidgets();
});

// ---------- 背景透明度调节（右上角，自绘滑块） ----------
// 控制顶栏/左侧导航的罩层不透明度：0%=不透明浅白（与主页同色），100%=全透明（露出实时模糊桌面）
const opTrack = document.getElementById('opTrack');
const opFill = document.getElementById('opFill');
const opThumb = document.getElementById('opThumb');
const opVal = document.getElementById('opVal');
let appAlpha = 0.5;   // 透明度（0=不透明，1=全透明）

function paintOpacity() {
  const pct = Math.round(appAlpha * 100);
  document.documentElement.style.setProperty('--nav-a', String(1 - appAlpha));
  // 100% 时降低模糊强度（12px → 6px），让桌面更透、透明度更高
  document.documentElement.style.setProperty('--nav-blur', Math.round(12 * (1 - appAlpha) + 6 * appAlpha) + 'px');
  opFill.style.width = pct + '%';
  opThumb.style.left = pct + '%';
  opVal.textContent = pct + '%';
}
function setOpacityFromX(clientX) {
  const r = opTrack.getBoundingClientRect();
  if (!r.width) return;
  const v = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  appAlpha = v;
  paintOpacity();
}
let opDragging = false;
opTrack.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  opDragging = true;
  setOpacityFromX(e.clientX);
});
document.addEventListener('mousemove', (e) => { if (opDragging) setOpacityFromX(e.clientX); });
document.addEventListener('mouseup', () => {
  if (!opDragging) return;
  opDragging = false;
  ipcRenderer.send('manager-opacity:save', appAlpha);
});
(async () => {
  try { appAlpha = await ipcRenderer.invoke('manager-opacity'); } catch (_) {}
  if (typeof appAlpha !== 'number') appAlpha = 0.5;
  paintOpacity();
})();

(async () => {
  const data = await ipcRenderer.invoke('widgets-list');
  categories = data.categories || [];
  widgets = data.widgets || [];
  renderNav();
  // 创建所有卡片（占位壳立即可见），预览内容由视口监听 + 并发队列按需加载
  // 先排普通正方形，再排大正方形；组内保留用户顺序，每组从新行开始。
  const sourceOrder = new Map(widgets.map((widget, index) => [widget.id, index]));
  const ordered = widgets.slice().sort((a, b) => tileRank(a) - tileRank(b) || sourceOrder.get(a.id) - sourceOrder.get(b.id));
  let previousTile = '';
  ordered.forEach((w, i) => {
    const item = makeItem(w);
    const currentTile = item.dataset.tile;
    if (currentTile !== previousTile) item.classList.add('group-start');
    previousTile = currentTile;
    item.style.animationDelay = `${30 + i * 35}ms`;
    itemCache[w.id] = item;
    grid.appendChild(item);
    if (ro) ro.observe(item);
    fitScaler(item, w);
  });
  applyFilter();
  observeFrames();   // 视口内的卡片开始排队加载预览
  refreshMyWidgets();
})();
