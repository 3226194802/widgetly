// AI 用量监控组件 —— 渲染进程（暖深色玻璃拟态版）
const { ipcRenderer } = require('electron');

const instId = new URLSearchParams(location.search).get('inst') || 'monitor-1';
const $ = (id) => document.getElementById(id);
let locked = false;

// ---------- 工具 ----------
function fmtTok(n) {
  if (n == null) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
function fmtUsd(cost) {
  if (cost == null) return '$0';
  if (cost >= 1) return '$' + cost.toFixed(2);
  if (cost >= 0.01) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(4);
}
function fmtRate(r) {
  if (r == null || r <= 0) return '—';
  return fmtUsd(r) + '/k';
}
function fmtAgo(min) {
  if (min == null) return '未知';
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

const animators = new Map();
function tweenTo(el, target, fmt = (v) => fmtTok(v)) {
  const cur = parseFloat(el.dataset.v || '0');
  if (Math.abs(cur - target) < 1 && el.textContent !== fmt(target)) {
    el.textContent = fmt(target); el.dataset.v = target; return;
  }
  const start = cur, dur = 700, t0 = performance.now();
  const old = animators.get(el);
  if (old) cancelAnimationFrame(old);
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = start + (target - start) * eased;
    el.textContent = fmt(v);
    if (p < 1) animators.set(el, requestAnimationFrame(step));
    else { el.dataset.v = target; animators.delete(el); }
  };
  animators.set(el, requestAnimationFrame(step));
}
function flash(el) {
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ---------- 模型主题色轮换（蓝/紫/橙/黄） ----------
const THEMES = [
  { a: '#6aa7ff', b: '#8f7bff', txt: '#cfe0ff' },   // 蓝
  { a: '#a78bfa', b: '#6aa7ff', txt: '#e2d5ff' },   // 紫
  { a: '#f0a83a', b: '#f5c95c', txt: '#ffe3b0' },   // 橙
  { a: '#f5c95c', b: '#f0a83a', txt: '#fff3cf' },   // 黄
];

// ---------- 渲染 ----------
function clearData() {
  $('totalNum').textContent = '--';
  $('totalCost').textContent = '—';
  $('totalCalls').textContent = '—';
  $('todayNum').textContent = '—';
  $('todayCost').textContent = '—';
  $('monthNum').textContent = '—';
  $('monthCost').textContent = '—';
  $('todayFill').style.width = '0%';
  $('monthFill').style.width = '0%';
  $('modelList').innerHTML = '';
  $('chart').innerHTML = '';
  $('trendTotal').innerHTML = '';
}
function render(data) {
  // 平台信息
  if (data && data.platform) {
    $('platformName').textContent = (data.platform.short || 'Agent').toUpperCase();
    document.title = data.platform.name + ' 用量监控';
  }
  if (!data || !data.ok) {
    clearData();
    const err = data && data.error;
    const pname = data && data.platform ? data.platform.name : '该平台';
    const hint = (data && data.hint) || (data && data.platform && data.platform.hint);
    if (err === 'not_found') {
      $('errBanner').textContent = '未找到此软件「' + pname + '」' + (hint ? '：' + hint : '');
    } else if (err === 'no_data') {
      $('errBanner').textContent = '「' + pname + '」' + (hint ? '：' + hint : '：暂无使用记录（本地无用量数据）');
    } else if (err === 'timeout') {
      $('errBanner').textContent = '⚠ ' + (hint || '读取超时，请稍后重试');
    } else {
      $('errBanner').textContent = hint ? '⚠ ' + hint : '⚠ 数据获取失败，等待重试…';
    }
    $('errBanner').hidden = false;
    $('statusBadge').classList.add('idle');
    $('statusText').textContent = err === 'not_found' ? '未安装' : (err === 'no_data' ? '无数据' : '数据异常');
    return;
  }
  $('errBanner').hidden = true;
  $('errBanner').textContent = '';

  const all = data.totals || {};
  const today = data.today || {};
  const month = data.month || {};
  // Token 总量口径：输入 + 缓存读取 + 输出 + 推理（缓存读取是 DSH/Hermes 上下文命中的大头，必须计入）
  const billOf = (x) => (x.input || 0) + (x.cache_read || 0) + (x.output || 0) + (x.reasoning || 0);
  const billedToday = billOf(today);
  const billedMonth = billOf(month);
  const billedAll = billOf(all);

  // 核心概览
  tweenTo($('totalNum'), billedAll);
  flash($('totalNum'));
  const isSub = data.platform && data.platform.pricing === 'subscription';
  const isUnk = data.platform && data.platform.pricing === 'unknown';
  $('totalCost').textContent = isSub ? '订阅制' : (isUnk ? '—' : fmtUsd(all.cost));
  $('totalCalls').textContent = (all.calls || 0).toLocaleString();

  // 今日 / 本月子卡片
  tweenTo($('todayNum'), billedToday);
  $('todayCost').textContent = isSub ? '订阅制' : (isUnk ? '—' : fmtUsd(today.cost));
  tweenTo($('monthNum'), billedMonth);
  $('monthCost').textContent = isSub ? '订阅制' : (isUnk ? '—' : fmtUsd(month.cost));
  const spanMax = Math.max(billedToday, billedMonth, 1);
  $('todayFill').style.width = (billedToday / spanMax * 100).toFixed(1) + '%';
  $('monthFill').style.width = (billedMonth / spanMax * 100).toFixed(1) + '%';

  // 状态标识（24h 内活跃 = 运行中，否则待机）
  const active = (data.active_24h || []).length > 0;
  const badge = $('statusBadge');
  badge.classList.toggle('idle', !active);
  $('statusText').textContent = active ? '运行中' : '待机';

  // 分项用量（按模型）
  const models = data.by_model || [];
  const list = $('modelList');
  list.innerHTML = '';
  const maxB = Math.max(1, ...models.map((m) => billOf(m)));
  models.forEach((m, i) => {
    const th = THEMES[i % THEMES.length];
    const billed = billOf(m);
    const initial = String(m.model || '?').charAt(0).toUpperCase();

    const card = document.createElement('div');
    card.className = 'model-card';

    const ico = document.createElement('div');
    ico.className = 'm-ico';
    ico.style.background = 'radial-gradient(circle at 30% 28%, ' + th.a + ', ' + th.b + ')';
    ico.style.boxShadow = '0 2px 8px rgba(0,0,0,0.35), 0 0 10px ' + th.a + '55';
    ico.textContent = initial;

    const mid = document.createElement('div');
    mid.className = 'm-mid';
    const top = document.createElement('div');
    top.className = 'm-top';
    const name = document.createElement('span');
    name.className = 'm-name'; name.textContent = m.model || '未知模型';
    const tok = document.createElement('span');
    tok.className = 'm-tok'; tok.textContent = fmtTok(billed);
    top.append(name, tok);
    const bar = document.createElement('div');
    bar.className = 'm-bar';
    const fill = document.createElement('div');
    fill.className = 'm-fill';
    fill.style.width = (billed / maxB * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    mid.append(top, bar);

    const right = document.createElement('div');
    right.className = 'm-right';
    const cost = document.createElement('div');
    cost.className = 'm-cost'; cost.textContent = fmtUsd(m.cost);
    const rate = document.createElement('div');
    rate.className = 'm-rate'; rate.textContent = fmtRate(m.rate);
    right.append(cost, rate);

    card.append(ico, mid, right);
    list.appendChild(card);
  });
  if (models.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:10px;color:var(--text-3);padding:8px 4px;';
    empty.textContent = '暂无用量数据';
    list.appendChild(empty);
  }

  // 趋势图（近 7 日）
  const trend = data.trend || [];
  const totalTrend = trend.reduce((s, d) => s + (d.billed || 0), 0);
  $('trendTotal').innerHTML = '合计 <b>' + fmtTok(totalTrend) + '</b>';
  const chart = $('chart');
  chart.innerHTML = '';
  const maxT = Math.max(1, ...trend.map((d) => d.billed || 0));
  trend.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'ch-col' + (i === trend.length - 1 ? ' today' : ' muted');
    const val = document.createElement('div');
    val.className = 'ch-val'; val.textContent = (d.billed || 0) > 0 ? fmtTok(d.billed) : '';
    const wrap = document.createElement('div');
    wrap.className = 'ch-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'ch-bar';
    bar.style.height = Math.max(3, ((d.billed || 0) / maxT * 100)).toFixed(1) + '%';
    wrap.appendChild(bar);
    const date = document.createElement('div');
    date.className = 'ch-date'; date.textContent = d.date || '';
    col.append(val, wrap, date);
    chart.appendChild(col);
  });

  // 底部
  const recent = data.recent;
  if (recent) {
    $('recent').innerHTML = '最近活动：<b>' + fmtAgo(recent.minutes_ago) + '</b> · ' + escapeHtml(prettyTitle(recent.title));
  }
  $('refresh').textContent = (data.fetched_at || '--') + ' 更新';
}

function prettyTitle(t) {
  return (/^\d{8}_\d{6}_/.test(t) ? '当前会话' : t);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 数据订阅 ----------
ipcRenderer.on('usage:' + instId, (_e, data) => render(data));
ipcRenderer.on('monitor:platform:' + instId, (_e, p) => {
  if (p && p.name) {
    $('platformName').textContent = (p.short || 'Agent').toUpperCase();
    document.title = p.name + ' 用量监控';
  }
});

// ---------- 外观调节（字体色/柱状图色/背景色） ----------
ipcRenderer.on('monitor:colors:' + instId, (_e, a) => {
  if (!a) return;
  const root = document.documentElement.style;
  if (a.fontColor) root.setProperty('--fontc', a.fontColor);
  if (a.accentColor) root.setProperty('--accent', a.accentColor);
  if (a.bgColor) root.setProperty('--bgc', a.bgColor);
});

// ---------- 标题栏功能图标 ----------
const stopDrag = (e) => e.stopPropagation();
$('btnPlatform').addEventListener('mousedown', stopDrag);
$('btnPlatform').addEventListener('click', () => ipcRenderer.send('monitor:platform-open:' + instId));
$('btnRefresh').addEventListener('mousedown', stopDrag);
$('btnRefresh').addEventListener('click', () => ipcRenderer.send('monitor:refresh:' + instId));
$('btnSettings').addEventListener('mousedown', stopDrag);
$('btnSettings').addEventListener('click', () => ipcRenderer.send('monitor:menu:' + instId));
$('btnClose').addEventListener('mousedown', stopDrag);
$('btnClose').addEventListener('click', () => ipcRenderer.send('monitor:quit:' + instId));

// ---------- 拖动：整卡左键拖动（锁定时禁拖，按钮/滑杆面板内不拖） ----------
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('#opPanel')) return;
  if (e.target.closest && e.target.closest('.tb-btn')) return;
  if (!locked) ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// 右键前先激活，保证原生 context-menu 触发
document.addEventListener('contextmenu', () => ipcRenderer.send('activate'));

// ---------- 毛玻璃背景（菜单开关；实时 backdrop-filter 模糊 + 暖棕罩，与文件夹组件同款） ----------
const veilEl = document.getElementById('veil');
let glass = false;
ipcRenderer.on('glass:' + instId, (_e, on) => {
  glass = !!on;
  card.classList.toggle('glass-on', glass);
  paintSlider(veilVal);   // 同步滑块：玻璃模式控制罩层，普通模式控制卡片底色
});

// ---------- 背景透明度（自绘滑块：点击 + 拖动） ----------
const card = document.getElementById('card');
const panel = $('opPanel');
const slider = $('opSlider');
const opFill = $('opFill');
const opThumb = $('opThumb');
const opVal = $('opVal');
let hideTimer = null;
let veilVal = 22;   // 透明度百分比（0=不透明，100=全透明）

function paintSlider(v) {
  veilVal = v;
  opFill.style.width = v + '%';
  opThumb.style.left = v + '%';
  opVal.textContent = v + '%';
  if (glass) veilEl.style.opacity = (1 - v / 100).toFixed(3);
  else card.style.setProperty('--bg-a', (1 - v / 100).toFixed(3));
}
function setFromX(clientX) {
  const r = slider.getBoundingClientRect();
  if (!r.width) return;
  const v = Math.max(0, Math.min(100, Math.round((clientX - r.left) / r.width * 100)));
  paintSlider(v);
}
function showPanel() { panel.hidden = false; scheduleHide(); }   // 打开即计时收起
function scheduleHide() { if (hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(() => { panel.hidden = true; }, 2200); }

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
  ipcRenderer.send('save-bg-opacity:' + instId, (100 - veilVal) / 100);
  scheduleHide();
});
ipcRenderer.on('show-opacity-panel:' + instId, () => showPanel());
ipcRenderer.on('bg-opacity:' + instId, (_e, bgAlpha) => {
  const v = Math.round((1 - bgAlpha) * 100);
  paintSlider(v);
});
document.addEventListener('mousedown', (e) => {
  if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
});
