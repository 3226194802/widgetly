// 系统监测组件 —— 渲染进程：3 个圆环指标 + 背景透明度面板 + 外观（底色/字体色/进度条色）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'sysmon-1';

const slotsEl = document.getElementById('slots');
const card = document.getElementById('card');
const SVGNS = 'http://www.w3.org/2000/svg';
const CIRC = 2 * Math.PI * 30;

let locked = false;
let slotEls = [];
let style = { bgColor: '#181a20', bgOpacity: 0.4, fontColor: '#f2eee6', barColor: null };

function hexToRgba(hex, a) {
  const h = String(hex || '#181a20').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a == null ? 1 : a))})`;
}
function applyStyle() {
  card.style.background = hexToRgba(style.bgColor, style.bgOpacity);
  document.documentElement.style.setProperty('--fontc', style.fontColor || '#f2eee6');
}

// ---------- 槽位渲染（一次性构建，平滑更新） ----------
function ensureSlots(n) {
  while (slotEls.length < n) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const lab = document.createElement('div');
    lab.className = 'lab';
    const ico = document.createElement('span');
    ico.className = 'ico';
    const name = document.createElement('span');
    lab.append(ico, name);
    const wrap = document.createElement('div');
    wrap.className = 'ring-wrap';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('viewBox', '0 0 72 72');
    const track = document.createElementNS(SVGNS, 'circle');
    track.setAttribute('class', 'track');
    track.setAttribute('cx', '36'); track.setAttribute('cy', '36'); track.setAttribute('r', '30');
    const prog = document.createElementNS(SVGNS, 'circle');
    prog.setAttribute('class', 'prog');
    prog.setAttribute('cx', '36'); prog.setAttribute('cy', '36'); prog.setAttribute('r', '30');
    prog.setAttribute('stroke-dasharray', CIRC);
    svg.append(track, prog);
    const pct = document.createElement('div');
    pct.className = 'pct';
    wrap.append(svg, pct);
    const note = document.createElement('div');
    note.className = 'note';
    slot.append(lab, wrap, note);
    slotsEl.appendChild(slot);
    slotEls.push({ el: slot, ico, name, prog, pct, note });
  }
  for (let i = n; i < slotEls.length; i++) slotEls[i].el.style.display = 'none';
}

function paint(data) {
  const n = (data || []).length;
  ensureSlots(n);
  // 大号（6 槽位）→ 2 行 × 3 列网格；标准 3 槽位 → 单行
  slotsEl.classList.toggle('grid', n > 3);
  (data || []).forEach((m, i) => {
    const s = slotEls[i];
    if (!s) return;
    s.ico.textContent = m.icon || '';
    s.name.textContent = m.name || '';
    if (m.pct >= 0) {
      const p = Math.max(0, Math.min(100, m.pct));
      s.prog.setAttribute('stroke', style.barColor || m.color || '#6aa7ff');
      s.prog.style.opacity = '1';
      s.prog.setAttribute('stroke-dashoffset', String(CIRC * (1 - p / 100)));
      s.pct.textContent = p + '%';
      s.pct.style.fontSize = '15px';
      s.note.textContent = p >= 85 ? '偏高' : p >= 60 ? '正常偏高' : '正常';
      s.note.style.color = p >= 85 ? '#ff8a7a' : p >= 60 ? '#ffd24a' : '';
    } else {
      s.prog.style.opacity = '0';
      s.pct.textContent = m.text || '—';
      s.pct.style.fontSize = m.text && m.text.length > 6 ? '10.5px' : '13px';
      s.note.textContent = m.name === '运行时长' ? '已运行' : '';
      s.note.style.color = '';
    }
  });
}

ipcRenderer.on('sysmon:data:' + instId, (_e, data) => paint(data));
ipcRenderer.on('sysmon:style:' + instId, (_e, s) => {
  if (s && typeof s === 'object') Object.assign(style, s);
  applyStyle();
});

// 预览模式（管理器内 iframe 无主进程推送）：展示示例指标，避免空白
if (instId === 'preview') {
  const wid = new URLSearchParams(location.search).get('wid') || 'sysmon';
  const sample = (id) => ({
    cpu: { name: 'CPU', icon: '⚙', color: '#5b9dff', pct: 37, text: '' },
    ram: { name: '内存', icon: '🧠', color: '#ffd24a', pct: 62, text: '' },
    gpu: { name: 'GPU', icon: '🎮', color: '#41cfc4', pct: 88, text: '' },
    battery: { name: '电池', icon: '🔋', color: '#ffd24a', pct: 54, text: '' },
    netdown: { name: '下载', icon: '⬇', color: '#41cf7f', pct: -1, text: '1.2M/s' },
    netup: { name: '上传', icon: '⬆', color: '#ff9a5c', pct: -1, text: '256K/s' },
  }[id] || { name: '—', icon: '❔', color: '#888', pct: -1, text: '—' });
  paint(wid === 'sysmonL'
    ? ['cpu', 'ram', 'gpu', 'battery', 'netdown', 'netup'].map(sample)
    : ['cpu', 'ram', 'gpu'].map(sample));
}

// ---------- 背景透明度面板（自绘滑杆：0%=不透明，100%=全透明只剩毛玻璃） ----------
const panel = document.getElementById('opPanel');
const slider = document.getElementById('opSlider');
const opFill = document.getElementById('opFill');
const opThumb = document.getElementById('opThumb');
const opVal = document.getElementById('opVal');
let veilVal = Math.round((1 - style.bgOpacity) * 100);
let hideTimer = null;
function paintPanel() {
  opFill.style.width = veilVal + '%';
  opThumb.style.left = veilVal + '%';
  opVal.textContent = veilVal + '%';
}
function setFromX(clientX) {
  const r = slider.getBoundingClientRect();
  if (!r.width) return;
  veilVal = Math.max(0, Math.min(100, Math.round((clientX - r.left) / r.width * 100)));
  style.bgOpacity = 1 - veilVal / 100;
  applyStyle();
  paintPanel();
}
function showPanel() {
  paintPanel();
  panel.hidden = false;
  scheduleHide();   // 打开后自动计时收起（修复：不拖动滑杆时面板一直不消失）
}
function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { panel.hidden = true; }, 2200);
}
ipcRenderer.on('show-opacity-panel:' + instId, () => {
  veilVal = Math.round((1 - style.bgOpacity) * 100);
  showPanel();
});
let opDragging = false;
slider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  opDragging = true;
  if (hideTimer) clearTimeout(hideTimer);   // 拖动期间不自动收起
  setFromX(e.clientX);
});
document.addEventListener('mousemove', (e) => { if (opDragging) setFromX(e.clientX); });
document.addEventListener('mouseup', () => {
  if (!opDragging) return;
  opDragging = false;
  ipcRenderer.send('save-bg-opacity:' + instId, style.bgOpacity);
  scheduleHide();
});
document.addEventListener('mousedown', (e) => {
  if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
});

// ---------- 设置（选择对象） ----------
document.getElementById('btnSettings').addEventListener('click', () => {
  ipcRenderer.send('sysmon:settings-open:' + instId);
});

// ---------- 拖动（锁定禁拖；面板内不拖） ----------
ipcRenderer.on('lock:' + instId, (_e, on) => { locked = !!on; });
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (locked) return;
  if (e.target.closest && e.target.closest('.gear, .op-panel')) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// ---------- 右键菜单 ----------
// 注意：不能 preventDefault，否则会吞掉主进程的 context-menu 事件导致菜单弹不出来
document.addEventListener('contextmenu', () => {
  ipcRenderer.send('activate');
});

applyStyle();
paintPanel();
