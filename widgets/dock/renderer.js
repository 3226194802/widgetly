// 文件夹（快捷收纳）组件 —— 渲染进程（Widgetly 适配）
const { ipcRenderer, webUtils } = require('electron');

// 从 URL query 获取本实例 id，配置/数据通道按实例隔离
const instId = new URLSearchParams(location.search).get('inst') || 'dock-1';

function evt(name, extra) {
  ipcRenderer.send('evt', name + (extra ? '|' + extra : ''));
}

const $ = (id) => document.getElementById(id);
const grid = $('grid');
let items = [];
let locked = false;

// ---------- 网格渲染 ----------
// 初始 = 默认排列 4×2（对齐 Widgetly 默认 layout 与预览尺寸 280×148）
let cols = 4, rows = 2, iconSize = 52;
let allItems = [];
function renderGrid() {
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, ${iconSize + 6}px)`;
  grid.style.setProperty('--icon-size', iconSize + 'px');
  const cap = cols * rows;
  grid.innerHTML = '';
  for (let i = 0; i < cap; i++) {
    const it = items[i];
    const cell = document.createElement('div');
    cell.className = 'cell' + (it ? '' : ' empty');
    if (it) {
      const box = document.createElement('div');
      box.className = 'icon-box' + (it.icon ? '' : ' fallback');
      if (it.icon) {
        const img = document.createElement('img');
        img.src = it.icon;
        img.draggable = false;
        box.appendChild(img);
      } else {
        const letter = document.createElement('span');
        letter.className = 'icon-letter';
        letter.textContent = (it.name || '?').charAt(0).toUpperCase();
        box.appendChild(letter);
      }
      cell.appendChild(box);
      cell.dataset.path = it.path;
      cell.title = it.name;
    } else {
      const plus = document.createElement('div');
      plus.className = 'plus';
      plus.textContent = '+';
      cell.appendChild(plus);
    }
    grid.appendChild(cell);
  }
}

// ---------- 点击：打开 / 空格子添加 ----------
let suppressClick = false;
grid.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; return; }
  const cell = e.target.closest('.cell');
  if (!cell) return;
  if (cell.classList.contains('empty')) {
    ipcRenderer.send('add:' + instId);
  } else {
    ipcRenderer.send('launch:' + instId, cell.dataset.path);
  }
});

// ---------- 右键：先激活窗口，再按目标弹不同菜单 ----------
document.addEventListener('contextmenu', (e) => {
  ipcRenderer.send('activate');
  const cell = e.target.closest('.cell');
  if (cell && !cell.classList.contains('empty')) {
    ipcRenderer.send('ctx-target:' + instId, { type: 'grid', path: cell.dataset.path });
  } else {
    ipcRenderer.send('ctx-target:' + instId, { type: 'blank' });
  }
});

// ---------- 拖动：左键移动 >5px 才进入拖动（区分"点击打开"与"拖动窗口"）；锁定时禁拖 ----------
let dragState = { active: false, moved: false, startX: 0, startY: 0 };
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('#opPanel')) return;
  dragState = { active: true, moved: false, startX: e.clientX, startY: e.clientY };
}, true);
document.addEventListener('mousemove', (e) => {
  if (!dragState.active || dragState.moved) return;
  if (Math.abs(e.clientX - dragState.startX) > 5 || Math.abs(e.clientY - dragState.startY) > 5) {
    dragState.moved = true;
    if (!locked) ipcRenderer.send('drag-start');
  }
}, true);
document.addEventListener('mouseup', () => {
  if (dragState.active && dragState.moved) {
    suppressClick = true;
    if (!locked) ipcRenderer.send('drag-end');
  }
  dragState.active = false;
}, true);

// ---------- 拖放添加（HTML5 通道：webUtils 取真实路径） ----------
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = Array.from(e.dataTransfer.files || [])
    .map((f) => { try { return webUtils.getPathForFile(f); } catch (_) { return f.path; } })
    .filter(Boolean);
  if (paths.length) ipcRenderer.send('add-files:' + instId, paths);
});

// ---------- 数据订阅 ----------
ipcRenderer.on('items:' + instId, (_e, list) => {
  allItems = list;
  items = list.slice(0, cols * rows);
  renderGrid();
});
ipcRenderer.on('layout:' + instId, (_e, l, dir) => {
  const prevRows = rows;
  if (l === '3x3') { cols = 3; rows = 3; iconSize = 48; }
  else if (l === '4x2' || l === '4x3' || l === '4x4' || l === '4x5') { cols = 4; rows = parseInt(l.slice(2), 10); iconSize = 52; }
  else if (l === '5x4') { cols = 5; rows = 4; iconSize = 40; }
  else if (l === '5x3') { cols = 5; rows = 3; iconSize = 40; }
  else { cols = 3; rows = 4; iconSize = 62; }
  items = allItems.slice(0, cols * rows);
  renderGrid();
  const g = document.getElementById('grid');
  if (rows !== prevRows) {
    g.classList.remove('slide-down', 'slide-up');
    void g.offsetWidth;
    g.classList.add(dir === 'down' ? 'slide-down' : 'slide-up');
    setTimeout(() => g.classList.remove('slide-down', 'slide-up'), 420);
  }
});
ipcRenderer.on('drag-state:' + instId, (_e, on) => {
  document.getElementById('card').classList.toggle('drag-over', !!on);
});
ipcRenderer.on('lock:' + instId, (_e, on) => { locked = !!on; });
ipcRenderer.on('pin:' + instId, () => {});   // 置顶状态无需在卡片上体现

// ---------- 背景透明度（自绘滑块：点击 + 拖动） ----------
const card = document.getElementById('card');
const panel = $('opPanel');
const slider = $('opSlider');
const opFill = $('opFill');
const opThumb = $('opThumb');
const opVal = $('opVal');
let veilVal = 28;   // 透明度百分比（0=不透明，100=全透明）
function paintSlider(v) {
  veilVal = v;
  opFill.style.width = v + '%';
  opThumb.style.left = v + '%';
  opVal.textContent = v + '%';
  document.querySelector('.veil').style.opacity = (1 - v / 100).toFixed(3);
}
function setFromX(clientX) {
  const r = slider.getBoundingClientRect();
  if (!r.width) return;
  const v = Math.max(0, Math.min(100, Math.round((clientX - r.left) / r.width * 100)));
  paintSlider(v);
}
let opDragging = false;
slider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  opDragging = true;
  setFromX(e.clientX);
});
document.addEventListener('mousemove', (e) => { if (opDragging) setFromX(e.clientX); });
document.addEventListener('mouseup', () => {
  if (!opDragging) return;
  opDragging = false;
  ipcRenderer.send('save-bg-opacity:' + instId, (100 - veilVal) / 100);
});
ipcRenderer.on('show-opacity-panel:' + instId, () => { panel.hidden = false; });
ipcRenderer.on('bg-opacity:' + instId, (_e, bgAlpha) => {
  const v = Math.round((1 - bgAlpha) * 100);
  paintSlider(v);
});

document.addEventListener('mousedown', (e) => {
  if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
});

// 预览模式（无主进程推送）也要渲染空网格
renderGrid();
