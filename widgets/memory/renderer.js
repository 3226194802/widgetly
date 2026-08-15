// 内存监控组件 —— 渲染进程：实时内存心电图 + 磁盘存储 + 外观
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'memory-1';
const $ = (id) => document.getElementById(id);

const canvas = $('ecg');
const ctx = canvas.getContext('2d');
const samples = [];        // 滚动内存使用率 %（0-100）
const MAX_SAMPLES = 36;    // ~36 秒窗口

let curveColor = '#ffd24a', barColor = '#a07fff', fontColor = '#f2eee6';

// ---------- 格式化 ----------
function fmtRamGB(bytes) { return (bytes / 1024 ** 3).toFixed(1); }
function fmtDiskGB(bytes) { return String(Math.round(bytes / 1024 ** 3)); }

// ---------- 数据（RAM 1s 实时 + 磁盘 30s，分开发送避免频繁扫盘阻塞主进程） ----------
ipcRenderer.on('memory:ram:' + instId, (_e, d) => {
  if (!d) return;
  const used = d.used || 0, total = d.total || 1;
  const pct = Math.max(0, Math.min(100, (used / total) * 100));

  $('ramPctNum').textContent = String(Math.round(pct));
  $('ramFrac').textContent = fmtRamGB(used) + 'G / ' + fmtRamGB(total) + 'G';

  samples.unshift(pct);   // 最新样本在最前（左侧），曲线从左向右前进
  if (samples.length === 1) {
    // 首帧：用当前值填满整条曲线，避免启动时留白
    while (samples.length < MAX_SAMPLES) samples.unshift(pct);
  } else if (samples.length > MAX_SAMPLES) {
    samples.pop();
  }
  drawEcg();
});

ipcRenderer.on('memory:disks:' + instId, (_e, disks) => {
  renderDisks(disks || []);
});

function renderDisks(disks) {
  const list = $('diskList');
  list.innerHTML = '';
  disks.forEach((dk) => {
    const used = dk.total - dk.free;
    const pct = dk.total > 0 ? Math.max(0, Math.min(100, (used / dk.total) * 100)) : 0;
    const row = document.createElement('div');
    row.className = 'disk-row';

    const letter = document.createElement('span');
    letter.className = 'disk-letter'; letter.textContent = dk.label || (dk.letter + '盘');
    const p = document.createElement('span');
    p.className = 'disk-pct'; p.textContent = Math.round(pct) + '%';
    const bar = document.createElement('div');
    bar.className = 'disk-bar';
    const fill = document.createElement('div');
    fill.className = 'disk-fill'; fill.style.width = pct.toFixed(1) + '%';
    bar.appendChild(fill);
    const frac = document.createElement('span');
    frac.className = 'disk-frac'; frac.textContent = fmtDiskGB(used) + 'G / ' + fmtDiskGB(dk.total) + 'G';

    row.append(letter, p, bar, frac);
    list.appendChild(row);
  });
}

// ---------- 心电图曲线（canvas） ----------
function ensureSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return false;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw; canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return true;
}
function drawEcg() {
  if (!ensureSize()) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  // 浅色背景矩形（定义曲线纵向范围，若隐若现）
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, 0, w, h);
  if (samples.length < 2) return;
  const n = samples.length;
  const stepX = w / (MAX_SAMPLES - 1);
  const startX = (MAX_SAMPLES - n) * stepX;
  const pad = h * 0.14;
  // 纵向自动缩放：按当前窗口内最小/最大值映射，让波动更明显（心电图感）
  const min = Math.min(...samples), max = Math.max(...samples);
  const span = max - min;
  let lo = min, hi = max;
  if (span < 8) { const mid = (lo + hi) / 2; lo = mid - 4; hi = mid + 4; }
  else { const pad = span * 0.18; lo -= pad; hi += pad; }
  const yOf = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
  ctx.strokeStyle = curveColor;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = startX + i * stepX;
    const y = yOf(samples[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // 末端圆点 = 最新样本（在最左侧 samples[0]）
  const lastX = startX;
  const lastY = yOf(samples[0]);
  ctx.fillStyle = curveColor;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

// ---------- 外观 ----------
function applyAppearance(a) {
  if (!a) return;
  const root = document.documentElement.style;
  if (a.curveColor) { curveColor = a.curveColor; root.setProperty('--curve', a.curveColor); }
  if (a.barColor) { barColor = a.barColor; root.setProperty('--bar', a.barColor); }
  if (a.fontColor) { fontColor = a.fontColor; root.setProperty('--fontc', a.fontColor); }
  if (a.bgColor) root.setProperty('--bgc', a.bgColor);
  if (a.bgMode) document.body.dataset.bg = a.bgMode;
  drawEcg();
}
ipcRenderer.on('memory:appearance:' + instId, (_e, a) => applyAppearance(a));
ipcRenderer.invoke('memory:appearance-init:' + instId).then(applyAppearance);

// ---------- 拖动：空白拖（锁定禁拖） ----------
let locked = false;
ipcRenderer.on('memory:lock:' + instId, (_e, on) => { locked = !!on; });
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (locked) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// ---------- 右键菜单 ----------
document.addEventListener('contextmenu', (e) => {
  ipcRenderer.send('activate');
  e.preventDefault();
  ipcRenderer.send('memory:menu:' + instId);
});

window.addEventListener('resize', () => drawEcg());
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => drawEcg()).observe(canvas);
}
drawEcg();
ipcRenderer.send('activate');
