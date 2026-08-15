// 数字时钟（长条/小方/带秒）—— 渲染进程
const { ipcRenderer } = require('electron');
const params = new URLSearchParams(location.search);
const instId = params.get('inst') || 'clock2-1';
const wid = params.get('wid') || 'clock2';   // 管理器预览传 wid，用于判定默认是否带秒

const hmEl = document.getElementById('hm');
const ssEl = document.getElementById('ss');
const ampmEl = document.getElementById('ampm');
const dateEl = document.getElementById('date');
const weekEl = document.getElementById('week');

const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
let cfg = { hour12: false, theme: 'auto', showSeconds: wid === 'clock2Sec' };
let locked = false;
let style = { bgColor: '#1e212a', bgOpacity: 0.22, fontColor: '#f2eee6', customized: false };

const card = document.querySelector('.card');

function hexToRgba(hex, a) {
  const h = String(hex || '#1e212a').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a == null ? 0.22 : a))})`;
}
function applyStyle() {
  if (style.customized) {
    card.style.background = hexToRgba(style.bgColor, style.bgOpacity);
    document.documentElement.style.setProperty('--fontc', style.fontColor || '#f2eee6');
  } else {
    card.style.background = '';
    document.documentElement.style.removeProperty('--fontc');
  }
}

const mq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = cfg.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : cfg.theme;
  document.documentElement.dataset.theme = t;
}
mq.addEventListener('change', applyTheme);

const pad = (n) => String(n).padStart(2, '0');
// 字号按窗口尺寸（小方 140 用 40px，长条 280 用 68px）；小方 12 小时制再缩小，避免溢出
const SQUARE = window.innerWidth < 200;
function updateFs() {
  const base = SQUARE ? 40 : 68;
  const fs = (SQUARE && cfg.hour12) ? 32 : base;
  document.documentElement.style.setProperty('--fs', fs + 'px');
}
function tick() {
  const d = new Date();
  let h = d.getHours();
  let suffix = '';
  if (cfg.hour12) { suffix = h < 12 ? '上午' : '下午'; h = h % 12 || 12; }
  hmEl.textContent = pad(h) + ':' + pad(d.getMinutes());
  ampmEl.textContent = suffix;
  if (cfg.showSeconds) {
    ssEl.style.display = '';
    ssEl.textContent = ':' + pad(d.getSeconds());
  } else {
    ssEl.style.display = 'none';
  }
  const dk = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  if (dateEl.dataset.d !== dk) {
    dateEl.dataset.d = dk;
    dateEl.textContent = dk;
    weekEl.textContent = WEEKS[d.getDay()];
  }
}
tick();
updateFs();
setInterval(tick, 250);

ipcRenderer.on('clock2:cfg:' + instId, (_e, c) => {
  if (!c) return;
  if (typeof c.hour12 === 'boolean') cfg.hour12 = c.hour12;
  if (c.theme) cfg.theme = c.theme;
  if (typeof c.showSeconds === 'boolean') cfg.showSeconds = c.showSeconds;
  if (typeof c.locked === 'boolean') locked = c.locked;
  applyTheme();
  updateFs();
  tick();
});
ipcRenderer.on('clock2:style:' + instId, (_e, s) => {
  if (s && typeof s === 'object') Object.assign(style, s);
  applyStyle();
});

// ---------- 背景透明度面板（自绘滑杆：0%=不透明，100%=全透明） ----------
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
  style.customized = true;
  applyStyle();
  paintPanel();
}
function showPanel() {
  paintPanel();
  panel.hidden = false;
  scheduleHide();
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
  if (hideTimer) clearTimeout(hideTimer);
  setFromX(e.clientX);
});
document.addEventListener('mousemove', (e) => { if (opDragging) setFromX(e.clientX); });
document.addEventListener('mouseup', () => {
  if (!opDragging) return;
  opDragging = false;
  ipcRenderer.send('clock2:bg-opacity:' + instId, style.bgOpacity);
  scheduleHide();
});
document.addEventListener('mousedown', (e) => {
  if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
});

// ---------- 拖动（锁定禁拖） ----------
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (locked) return;
  if (e.target.closest && e.target.closest('.op-panel')) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// ---------- 右键（不 preventDefault，主进程弹菜单） ----------
document.addEventListener('contextmenu', () => ipcRenderer.send('activate'));

applyStyle();
paintPanel();
