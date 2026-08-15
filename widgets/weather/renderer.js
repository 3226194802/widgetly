// 天气组件 —— 渲染进程：接收主进程拉取的 Open-Meteo 数据，长条/正方形自适应布局
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'weather-1';

const card = document.getElementById('card');
const el = {
  city: document.getElementById('city'),
  icon: document.getElementById('icon'),
  temp: document.getElementById('temp'),
  desc: document.getElementById('desc'),
  feels: document.getElementById('feels'),
  stHi: document.getElementById('stHi'),
  stLo: document.getElementById('stLo'),
  stHum: document.getElementById('stHum'),
  stWind: document.getElementById('stWind'),
  updated: document.getElementById('updated'),
  refresh: document.getElementById('btnRefresh'),
  foot: document.getElementById('foot'),
};

let locked = false;
let style = { bgColor: '#1e212a', bgOpacity: 0.22, fontColor: '#f2eee6', customized: false };
const SQUARE = window.innerWidth < 200;
card.classList.toggle('sq', SQUARE);

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

// WMO 天气代码 → 图标 + 中文描述
const WMO = {
  0: ['☀️', '晴'], 1: ['🌤️', '少云'], 2: ['⛅', '多云'], 3: ['☁️', '阴'],
  45: ['🌫️', '雾'], 48: ['🌫️', '雾凇'],
  51: ['🌦️', '毛毛雨'], 53: ['🌦️', '毛毛雨'], 55: ['🌧️', '毛毛雨'],
  61: ['🌧️', '小雨'], 63: ['🌧️', '中雨'], 65: ['🌧️', '大雨'],
  66: ['🌧️', '冻雨'], 67: ['🌧️', '冻雨'],
  71: ['🌨️', '小雪'], 73: ['🌨️', '中雪'], 75: ['❄️', '大雪'], 77: ['🌨️', '雪粒'],
  80: ['🌦️', '阵雨'], 81: ['🌧️', '阵雨'], 82: ['⛈️', '强阵雨'],
  85: ['🌨️', '阵雪'], 86: ['❄️', '强阵雪'],
  95: ['⛈️', '雷阵雨'], 96: ['⛈️', '雷雨冰雹'], 99: ['⛈️', '强雷雨冰雹'],
};
function wmo(code) { return WMO[code] || ['🌡️', '未知']; }

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function paint(d) {
  if (!d) return;
  el.refresh.classList.remove('spinning');
  if (!d.ok) {
    el.icon.textContent = '📡';
    el.temp.textContent = '—°';
    el.desc.textContent = d.msg || '网络不可用';
    el.feels.textContent = '';
    el.stHi.textContent = '—'; el.stLo.textContent = '—';
    el.stHum.textContent = '—'; el.stWind.textContent = '—';
    el.updated.textContent = '—';
    return;
  }
  const [ico, name] = wmo(d.code);
  el.city.textContent = d.city || '—';
  el.icon.textContent = ico;
  el.temp.textContent = d.temp + '°';
  el.desc.textContent = name;
  el.feels.textContent = '体感 ' + d.feels + '°';
  el.stHi.textContent = d.tmax + '°';
  el.stLo.textContent = d.tmin + '°';
  el.stHum.textContent = d.humidity + '%';
  el.stWind.textContent = d.wind + ' km/h';
  el.updated.textContent = d.updatedAt ? fmtTime(d.updatedAt) : '—';
}

ipcRenderer.on('weather:data:' + instId, (_e, d) => paint(d));
ipcRenderer.on('weather:loading:' + instId, () => el.refresh.classList.add('spinning'));
ipcRenderer.on('weather:lock:' + instId, (_e, on) => { locked = !!on; });
ipcRenderer.on('weather:style:' + instId, (_e, s) => {
  if (s && typeof s === 'object') Object.assign(style, s);
  applyStyle();
});

// ---------- 背景透明度面板 ----------
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
  ipcRenderer.send('weather:bg-opacity:' + instId, style.bgOpacity);
  scheduleHide();
});
document.addEventListener('mousedown', (e) => {
  if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
});

// ---------- 预览模式（管理器内 iframe 无主进程推送）：自行拉取北京天气展示 ----------
if (instId === 'preview') {
  const https = require('https');
  function getJson(url) {
    return new Promise((resolve) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
  (async () => {
    const geo = await getJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent('北京') + '&count=1&language=zh&format=json');
    const loc = geo && geo.results && geo.results[0];
    if (!loc) { paint({ ok: false, msg: '网络不可用' }); return; }
    const fc = await getJson('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1');
    if (!fc || !fc.current) { paint({ ok: false, msg: '天气数据不可用' }); return; }
    paint({
      ok: true, city: String(loc.name || '北京'), temp: Math.round(fc.current.temperature_2m),
      feels: Math.round(fc.current.apparent_temperature), humidity: Math.round(fc.current.relative_humidity_2m),
      wind: Math.round(fc.current.wind_speed_10m), code: fc.current.weather_code,
      tmax: Math.round(fc.daily.temperature_2m_max[0]), tmin: Math.round(fc.daily.temperature_2m_min[0]), updatedAt: Date.now(),
    });
  })();
}

el.refresh.addEventListener('click', () => ipcRenderer.send('weather:refresh:' + instId));

// ---------- 拖动（锁定禁拖） ----------
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (locked) return;
  if (e.target.closest && e.target.closest('.refresh, .op-panel')) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// ---------- 右键（不 preventDefault，主进程弹菜单） ----------
document.addEventListener('contextmenu', () => ipcRenderer.send('activate'));

applyStyle();
paintPanel();
