// 日历组件族 —— 共享渲染进程（5 种样式：bar/square/big/xl/mini）
// 外观：背景基色/文字色/高亮色（外观窗口实时调节）；透明度滑块（100%=透出壁纸毛玻璃）；拖动；浮动菜单
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'cal-1';
const STYLE = document.body.dataset.style || 'bar';

const DEFAULTS = {
  bar:    { bg: '#16305c', text: '#ffffff', accent: '#57b7ff' },
  square: { bg: '#f7f1e3', text: '#4a3728', accent: '#d95a3a' },
  big:    { bg: '#f5f1e8', text: '#2b2b2b', accent: '#c83e2a' },
  xl:     { bg: '#141a33', text: '#f2ede4', accent: '#9ec3d9' },
  mini:   { bg: '#ff8a5a', text: '#ffffff', accent: '#ffd9a0' },
  ring:   { bg: '#e5ddf4', text: '#3d3560', accent: '#8f7bd8' },
  mint:   { bg: '#d7efe2', text: '#20543f', accent: '#4cb882' },
};

let cfg = { veilOpacity: 80, bgColor: DEFAULTS[STYLE].bg, textColor: DEFAULTS[STYLE].text, accentColor: DEFAULTS[STYLE].accent };
let now = new Date();
let todayKey = '';

function applyAppearance() {
  const root = document.documentElement;
  root.style.setProperty('--bg', cfg.bgColor);
  root.style.setProperty('--text', cfg.textColor);
  root.style.setProperty('--accent', cfg.accentColor);
  root.style.setProperty('--accent-soft', hexA(cfg.accentColor, 0.8));   // 上层 80% 透明度灰调层（层次感）
  root.style.setProperty('--accent-glow', hexA(cfg.accentColor, 0.35));  // 底层大柔光
  root.style.setProperty('--accent-dim', hexA(cfg.accentColor, 0.16));
  root.style.setProperty('--veil-opacity', String((100 - cfg.veilOpacity) / 100));
  root.style.setProperty('--text-dim', hexA(cfg.textColor, 0.55));
  root.style.setProperty('--text-faint', hexA(cfg.textColor, 0.32));
}
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(0,0,0,' + a + ')';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const fmt = (n) => String(n).padStart(2, '0');
function dateInfo(d) {
  return {
    y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(),
    week: '周' + LUNAR.dayNames[d.getDay()],
    lunar: LUNAR.lunarText(d.getFullYear(), d.getMonth() + 1, d.getDate()),
    moon: LUNAR.moonPhase(d.getFullYear(), d.getMonth() + 1, d.getDate()),
    woy: LUNAR.weekOfYear(d),
  };
}

// ---------- 各样式渲染 ----------
function renderBar() {
  const t = dateInfo(now);
  document.getElementById('bDay').textContent = t.day;
  document.getElementById('bLunar').textContent = t.lunar;
  document.getElementById('bDate').textContent = `${t.y}年${t.m}月${t.day}日 · ${t.week}`;
  const start = new Date(t.y, t.m - 1, t.day).getTime();
  const end = start + 86400000;
  const pct = Math.max(0, Math.min(1, (now.getTime() - start) / (end - start)));
  document.getElementById('bProg').style.width = (pct * 100).toFixed(1) + '%';
  document.getElementById('bPct').textContent = Math.round(pct * 100) + '%';
}
function renderMini() {
  const t = dateInfo(now);
  document.getElementById('mDate').textContent = `${t.m}/${t.day} ${t.week}`;
  document.getElementById('mLunar').textContent = `农历${t.lunar} · 第${t.woy}周`;
}
function renderSquare() {
  const t = dateInfo(now);
  document.getElementById('sTitle').textContent = `${t.y} · ${t.m}月`;
  document.getElementById('sMoon').textContent = t.moon;
  fillGrid('sGrid', now, false);
}
function renderBig() {
  const t = dateInfo(now);
  document.getElementById('gDay').textContent = t.day;
  document.getElementById('gSub').textContent = `${t.y} ${t.m}月 · ${t.lunar}`;
  fillGrid('gGrid', now, false);
}
function renderXL() {
  const t = dateInfo(now);
  document.getElementById('xDay').textContent = t.day;
  document.getElementById('xMeta').textContent = `${t.y}年${t.m}月${t.day}日 · ${t.week} · 农历${t.lunar} · 第${t.woy}周`;
  fillGrid('xGrid', now, true);
  const terms = LUNAR.termsOfMonth(t.y, t.m);
  const tEl = document.getElementById('xTerms');
  tEl.innerHTML = '';
  terms.forEach((tr) => {
    const cap = document.createElement('span');
    cap.className = 'term-cap';
    cap.textContent = `${tr.name} ${tr.day}日`;
    tEl.appendChild(cap);
  });
  if (!terms.length) { const cap = document.createElement('span'); cap.className = 'term-cap'; cap.textContent = '本月无节气'; tEl.appendChild(cap); }
  const start = new Date(t.y, t.m - 1, t.day).getTime();
  const pct = Math.max(0, Math.min(1, (now.getTime() - start) / 86400000));
  document.getElementById('xProg').style.width = (pct * 100).toFixed(1) + '%';
}
function renderRing() {
  const t = dateInfo(now);
  document.getElementById('rWeek').textContent = `第${t.woy}周 · ${t.y}`;
  document.getElementById('rDay').textContent = t.day;
  document.getElementById('rMeta').textContent = `${t.m}月 · ${t.week}`;
  document.getElementById('rLunar').textContent = `农历${t.lunar}`;
  const dots = document.getElementById('rDots');
  if (!dots.childElementCount) {
    const names = ['一', '二', '三', '四', '五', '六', '日'];
    for (let i = 0; i < 7; i++) {
      const d = document.createElement('div');
      d.className = 'dot';
      const num = document.createElement('span');
      num.className = 'dnum';
      num.textContent = i + 1;
      const wd = document.createElement('span');
      wd.className = 'dwd';
      wd.textContent = names[i];
      d.append(num, wd);
      dots.appendChild(d);
    }
  }
  const dow = now.getDay();
  dots.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('today', i === dow));
}

function renderMint() {
  const t = dateInfo(now);
  document.getElementById('tHead').textContent = `${t.m}月 · ${t.y}`;
  document.getElementById('tDay').textContent = t.day;
  document.getElementById('tSub').textContent = `${t.week} · 农历${t.lunar}`;
  const dow = now.getDay();
  const dayInWeek = dow === 0 ? 7 : dow;   // 周一=1 … 周日=7
  document.getElementById('tProg').style.width = (dayInWeek / 7 * 100).toFixed(1) + '%';
  document.getElementById('tProgLabel').textContent = `本周 ${dayInWeek}/7`;
}

// 月历网格：今天 = 底层大柔光圆 + 上层 80% 透明灰调圆 + 上层实心圆（三层层次感）
function fillGrid(gridId, base, withLunar) {
  const grid = document.getElementById(gridId);
  grid.innerHTML = '';
  const y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const cells = 42;
  const tKey = `${y}-${m}-${base.getDate()}`;
  for (let i = 0; i < cells; i++) {
    const d = new Date(y, m, 1 + (i - startDow));
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (d.getMonth() !== m) cell.classList.add('other');
    if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add('wk');
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (k === tKey) cell.classList.add('today');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d.getDate();
    cell.appendChild(num);
    if (withLunar) {
      const lun = document.createElement('span');
      lun.className = 'lun';
      lun.textContent = LUNAR.lunarText(d.getFullYear(), d.getMonth() + 1, d.getDate());
      cell.appendChild(lun);
    }
    grid.appendChild(cell);
  }
}

function render() {
  todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (STYLE === 'bar') renderBar();
  else if (STYLE === 'mini') renderMini();
  else if (STYLE === 'square') renderSquare();
  else if (STYLE === 'big') renderBig();
  else if (STYLE === 'xl') renderXL();
  else if (STYLE === 'ring') renderRing();
  else if (STYLE === 'mint') renderMint();
}

// ---------- 壁纸毛玻璃 ----------
const glass = document.getElementById('glass');
function applyWallpaper(wp) {
  if (!wp) return;
  glass.style.backgroundImage = 'url(' + wp.dataUrl + ')';
  glass.style.backgroundSize = wp.w + 'px ' + wp.h + 'px';
  glass.style.backgroundPosition = wp.posX + 'px ' + wp.posY + 'px';
}
ipcRenderer.invoke('wallpaper').then(applyWallpaper);
ipcRenderer.on('wallpaper', (_e, wp) => applyWallpaper(wp));
ipcRenderer.on('wallpaper-pos', (_e, p) => {
  if (p) glass.style.backgroundPosition = p.posX + 'px ' + p.posY + 'px';
});

// ---------- 拖动 ----------
const card = document.getElementById('card');
card.addEventListener('mousedown', (e) => {
  if (e.button === 0) ipcRenderer.send('drag-start');
  if (e.button === 2) ipcRenderer.send('activate');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// ---------- 浮动菜单 ----------
card.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('cal:menu:' + instId, { veil: cfg.veilOpacity });
});
ipcRenderer.on('cal:veil:' + instId, (_e, { v, save }) => {
  if (typeof v !== 'number') return;
  cfg.veilOpacity = Math.max(0, Math.min(100, Math.round(v)));
  applyAppearance();
  if (save) savePrefs();
});
ipcRenderer.on('cal:appearance-color:' + instId, (_e, c) => {
  if (!c) return;
  if (c.bgColor !== undefined) cfg.bgColor = c.bgColor;
  if (c.textColor !== undefined) cfg.textColor = c.textColor;
  if (c.accentColor !== undefined) cfg.accentColor = c.accentColor;
  applyAppearance();
  savePrefs();
});

function savePrefs() {
  ipcRenderer.send('cfg:save:' + instId, {
    veilOpacity: cfg.veilOpacity,
    bgColor: cfg.bgColor,
    textColor: cfg.textColor,
    accentColor: cfg.accentColor,
  });
}

(async () => {
  try {
    const c = await ipcRenderer.invoke('cfg:' + instId);
    if (c) {
      cfg = {
        veilOpacity: typeof c.veilOpacity === 'number' ? c.veilOpacity : 80,
        bgColor: c.bgColor || DEFAULTS[STYLE].bg,
        textColor: c.textColor || DEFAULTS[STYLE].text,
        accentColor: c.accentColor || DEFAULTS[STYLE].accent,
      };
    }
  } catch (_) {}
  applyAppearance();
  render();
  setInterval(() => {
    const n = new Date();
    const k = `${n.getFullYear()}-${n.getMonth()}-${n.getDate()}`;
    const minuteChanged = n.getMinutes() !== now.getMinutes();
    if (k !== todayKey || (STYLE === 'bar' || STYLE === 'xl') || minuteChanged) { now = n; render(); }
  }, 20000);
})();
