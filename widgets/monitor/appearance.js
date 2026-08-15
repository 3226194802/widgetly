// 外观调节窗口 —— 字体颜色 / 柱状图颜色（进度条同步）/ 背景颜色
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'monitor-1';

let appearance = { fontColor: '#f1e8d8', accentColor: '#f0a83a', bgColor: '#3e3128' };

const FONT_COLORS = ['#f1e8d8', '#ffffff', '#e0e8f2', '#f2e2c0', '#f0e0dc', '#d8d2c8'];
const ACCENT_COLORS = ['#f0a83a', '#f5c95c', '#ff8f3d', '#41cf7f', '#41cfc4', '#6aa7ff', '#a78bfa', '#ef6a5e'];
const BG_COLORS = ['#3e3128', '#2b2623', '#232a38', '#1e2b25', '#33202a', '#2e2a2e'];

function buildSwatches(container, list, current, onPick) {
  container.innerHTML = '';
  list.forEach((v) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (v.toLowerCase() === String(current).toLowerCase() ? ' sel' : '');
    s.style.background = v;
    s.addEventListener('click', () => onPick(v));
    container.appendChild(s);
  });
}
function refreshSelection() {
  const cur = (c) => String(c).toLowerCase();
  document.querySelectorAll('#fontSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.fontColor)));
  document.querySelectorAll('#accentSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.accentColor)));
  document.querySelectorAll('#bgSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.bgColor)));
}

function wire(label, containerId, pickerId, key) {
  const container = document.getElementById(containerId);
  const picker = document.getElementById(pickerId);
  buildSwatches(container, key === 'fontColor' ? FONT_COLORS : key === 'accentColor' ? ACCENT_COLORS : BG_COLORS, appearance[key], (v) => {
    appearance[key] = v;
    ipcRenderer.send('monitor:appearance:' + instId, { [key]: v });
    refreshSelection();
  });
  picker.addEventListener('input', (e) => {
    appearance[key] = e.target.value;
    ipcRenderer.send('monitor:appearance:' + instId, { [key]: e.target.value });
    refreshSelection();
  });
}

wire('fontColor', 'fontSwatches', 'fontPicker', 'fontColor');
wire('accentColor', 'accentSwatches', 'accentPicker', 'accentColor');
wire('bgColor', 'bgSwatches', 'bgPicker', 'bgColor');

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('monitor:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('monitor:appearance-close:' + instId));

(async () => {
  try {
    const a = await ipcRenderer.invoke('monitor:appearance-init:' + instId);
    if (a) appearance = a;
  } catch (_) {}
  wire('fontColor', 'fontSwatches', 'fontPicker', 'fontColor');
  wire('accentColor', 'accentSwatches', 'accentPicker', 'accentColor');
  wire('bgColor', 'bgSwatches', 'bgPicker', 'bgColor');
  refreshSelection();
})();
