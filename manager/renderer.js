// Widgetly 管理器 —— 左侧分类导航 + 搜索过滤 + 原始尺寸预览
const { ipcRenderer } = require('electron');
const grid = document.getElementById('grid');
const nav = document.getElementById('nav');
const searchInput = document.getElementById('searchInput');

let categories = [];
let widgets = [];
let activeCategory = 'all';
let searchQuery = '';
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
  categories.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'nav-item' + (c.id === activeCategory ? ' active' : '');
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
      renderNav();
      applyFilter();
    });
    nav.appendChild(item);
  });
}

// ---------- 卡片（组件按原始尺寸显示，不缩比；iframe 缓存：只创建一次，过滤时仅切换显示） ----------
const itemCache = {};

function makeItem(w) {
  const item = document.createElement('div');
  item.className = 'item';

  // 网格占位：宽 140/280/342 → 1/2/3 列；高 74~180 → 1 行，280~285 → 2 行，500~551 → 4 行
  const cols = w.w <= 150 ? 1 : w.w <= 300 ? 2 : 3;
  const rows = w.h <= 185 ? 1 : w.h <= 300 ? 2 : 4;
  item.style.gridColumn = `span ${cols}`;
  item.style.gridRow = `span ${rows}`;

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
  name.textContent = w.name;

  item.append(box, name);
  item.dataset.wid = w.id;
  item.addEventListener('click', () => {
    item.classList.add('pulse');
    setTimeout(() => item.classList.remove('pulse'), 300);
    ipcRenderer.send('add-widget', w.id);
  });

  // ---------- 拖拽排序：可放入任意空位（鼠标位置决定插入点），非仅与某卡片交换 ----------
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

// 等比缩放预览到格子内（格子尺寸 = span×148 + gap，留 8px 内边距）
function fitScaler(item, w) {
  const { width: iw, height: ih } = item.getBoundingClientRect();
  if (!iw || !ih) return;
  const availW = iw - 10, availH = ih - 26;   // 底部留名字空间
  const s = Math.min(availW / (w.w || 300), availH / (w.h || 150));
  item._scaler.style.transform = `scale(${Math.max(0.2, s)})`;
}
// ResizeObserver：窗口/布局变化时重算缩放
const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  entries.forEach((en) => {
    const item = en.target;
    const w = widgets.find((x) => x.id === item.dataset.wid);
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
  // 组合行内的卡片不参与排序（位置固定），也不作为插入目标
  const cards = [...grid.querySelectorAll('.item')].filter((c) => c.style.display !== 'none' && c.dataset.wid !== dragId && !c.closest('.pair-row'));
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
  widgets.forEach((w) => {
    const item = itemCache[w.id];
    if (!item) return;
    const show = (activeCategory === 'all' || w.category === activeCategory)
      && (!searchQuery || w.name.toLowerCase().includes(searchQuery.toLowerCase()));
    item.style.display = show ? '' : 'none';
  });
  // 显示状态变化后重新观察：视口内可见卡片由 IntersectionObserver 触发排队加载
  if (frameIO) {
    Object.values(itemCache).forEach((item) => {
      const frame = item._frame;
      if (item.style.display !== 'none' && !frame.src && !frame.dataset.src) frameIO.observe(item);
    });
  }
  const anyVisible = widgets.some((w) => itemCache[w.id] && itemCache[w.id].style.display !== 'none');
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
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('manager-close'));

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
  applyFilter();
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
  const ordered = widgets.slice();
  // 组合行：AI 用量监控 + 日历·全景 独占一整行、左右并排（占满 6 列 × 4 行，位置固定不参与排序）
  const PAIR_IDS = ['monitor', 'calendarXL'];
  let pairRow = null;
  ordered.forEach((w, i) => {
    const item = makeItem(w);
    item.style.animationDelay = `${30 + i * 35}ms`;
    itemCache[w.id] = item;
    if (PAIR_IDS.includes(w.id)) {
      item.style.gridColumn = '';   // 清除 3 列跨度，交给 .pair-row 平分宽度
      item.style.gridRow = '';
      item.draggable = false;
      if (!pairRow) {
        pairRow = document.createElement('div');
        pairRow.className = 'pair-row';
        grid.appendChild(pairRow);
      }
      pairRow.appendChild(item);
    } else {
      grid.appendChild(item);
    }
    if (ro) ro.observe(item);
    fitScaler(item, w);
  });
  // 固定左右顺序：AI 用量监控在左、日历·全景在右（与注册/自定义顺序无关）
  if (pairRow) {
    const mon = itemCache['monitor'], xl = itemCache['calendarXL'];
    if (mon && xl) {
      if (pairRow.firstChild !== mon) pairRow.insertBefore(mon, pairRow.firstChild);
      if (pairRow.lastChild !== xl) pairRow.appendChild(xl);
    }
  }
  applyFilter();
  observeFrames();   // 视口内的卡片开始排队加载预览
})();
