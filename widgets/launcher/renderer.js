// DSH 启动器 —— 渲染进程：光环电源键 + 状态 + 主题 + 菜单 + 透明度 + 尺寸
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'launcher-1';

const btn = document.getElementById('btn');
const icon = document.getElementById('icon');
const statusText = document.getElementById('statusText');
const detail = document.getElementById('detail');
const card = document.getElementById('card');
const glass = document.getElementById('glass');
const dot = document.getElementById('dot');

let state = 'idle';
let veil = 0;
let port = 3080;
let dshPath = '';

const STATE_TEXT = { idle: '未启动', starting: '正在启动…', running: '运行中', failed: '启动失败' };
// SVG 图标（fill 跟随主题色 currentColor）
const SVG_ICON = {
  idle: '<svg viewBox="0 0 24 24"><path d="M8.4 5.3c0-.9 1-1.45 1.76-.9l8.6 6.05c.68.48.68 1.52 0 2l-8.6 6.05c-.75.55-1.76 0-1.76-.9z" fill="currentColor"/></svg>',
  running: '<svg viewBox="0 0 24 24"><rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.6" fill="currentColor"/></svg>',
  starting: '<svg class="spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="38 14"/></svg>',
  failed: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M12 7v5.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="16.2" r="1.4" fill="currentColor"/></svg>',
};

function paint() {
  btn.className = 'btn' + (state !== 'idle' ? ' ' + state : '');
  document.body.dataset.state = state;
  icon.innerHTML = SVG_ICON[state] || SVG_ICON.idle;
  btn.title = state === 'running' ? '点击停止' : '一键启动';
  statusText.textContent = STATE_TEXT[state] || '未启动';
  if (state === 'running') detail.textContent = `端口 ${port}`;
  else if (dshPath) detail.textContent = dshPath;
  else detail.textContent = '未配置安装路径';
}
function applyVeil() {
  document.documentElement.style.setProperty('--veil-opacity', String((100 - veil) / 100));
}

// 壁纸
function applyWallpaper(wp) {
  if (!wp) return;
  glass.style.backgroundImage = 'url(' + wp.dataUrl + ')';
  glass.style.backgroundSize = wp.w + 'px ' + wp.h + 'px';
  glass.style.backgroundPosition = wp.posX + 'px ' + wp.posY + 'px';
}
ipcRenderer.invoke('wallpaper').then(applyWallpaper);
ipcRenderer.on('wallpaper', (_e, wp) => applyWallpaper(wp));
ipcRenderer.on('wallpaper-pos', (_e, p) => { if (p) glass.style.backgroundPosition = p.posX + 'px ' + p.posY + 'px'; });

// 按钮点击
btn.addEventListener('click', () => {
  if (state === 'running') ipcRenderer.send('launcher:action:' + instId, 'stop');
  else ipcRenderer.send('launcher:action:' + instId, 'start');
});

// 拖动 + 菜单
card.addEventListener('mousedown', (e) => {
  if (e.button === 0) ipcRenderer.send('drag-start');
  if (e.button === 2) ipcRenderer.send('activate');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));
card.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('launcher:menu:' + instId, { state, veil });
});

// 状态/尺寸/主题/透明度推送
ipcRenderer.on('launcher:status:' + instId, (_e, d) => { if (d) { state = d.state; port = d.port; paint(); } });
ipcRenderer.on('launcher:size:' + instId, (_e, s) => { document.body.dataset.size = s; });
ipcRenderer.on('launcher:theme:' + instId, (_e, t) => { document.body.dataset.theme = t; });
ipcRenderer.on('launcher:veil:' + instId, (_e, d) => {
  if (d && typeof d.v === 'number') {
    veil = Math.max(0, Math.min(100, Math.round(d.v)));
    applyVeil();
    if (d.save) ipcRenderer.send('cfg:save:' + instId, { veilOpacity: veil });
  }
});

(async () => {
  try {
    const init = await ipcRenderer.invoke('launcher:init:' + instId);
    if (init) {
      state = init.state;
      veil = typeof init.veil === 'number' ? init.veil : 0;
      port = init.port;
      dshPath = init.dshPath;
      document.body.dataset.size = init.size;
      document.body.dataset.theme = init.theme || 'light';
    }
  } catch (_) {}
  applyVeil();
  paint();
})();
