// 外观调节窗口 —— 曲线颜色 / 进度条颜色 / 字体颜色 / 背景模式 + 背景色
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'memory-1';

let appearance = { curveColor: '#ffd24a', barColor: '#a07fff', fontColor: '#f2eee6', bgMode: 'frosted', bgColor: '#191722' };

const CURVE_COLORS = ['#ffd24a', '#41cfc4', '#6aa7ff', '#a07fff', '#ff8f6a', '#7ee787', '#f06292', '#ffffff'];
const BAR_COLORS = ['#a07fff', '#6aa7ff', '#41cfc4', '#ffd24a', '#ff8f6a', '#7ee787', '#f06292', '#8a8a9a'];
const FONT_COLORS = ['#f2eee6', '#ffffff', '#d8d2e0', '#b0a8c0', '#9aa0b8', '#8a8a9a'];
const BG_COLORS = ['#191722', '#1a1e2e', '#1c2420', '#241a20', '#201c1a', '#101014'];

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
  document.querySelectorAll('#curveSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.curveColor)));
  document.querySelectorAll('#barSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.barColor)));
  document.querySelectorAll('#fontSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.fontColor)));
  document.querySelectorAll('#bgSwatches .swatch').forEach((s) => s.classList.toggle('sel', cur(s.style.background) === cur(appearance.bgColor)));
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('sel', b.dataset.mode === appearance.bgMode));
}
function send(patch) {
  appearance = { ...appearance, ...patch };
  ipcRenderer.send('memory:appearance:' + instId, patch);
  refreshSelection();
}
function wireColor(containerId, pickerId, key, list) {
  buildSwatches(document.getElementById(containerId), list, appearance[key], (v) => {
    appearance[key] = v;
    ipcRenderer.send('memory:appearance:' + instId, { [key]: v });
    refreshSelection();
  });
  document.getElementById(pickerId).addEventListener('input', (e) => {
    appearance[key] = e.target.value;
    ipcRenderer.send('memory:appearance:' + instId, { [key]: e.target.value });
    refreshSelection();
  });
}

// 背景模式（透明 / 默认毛玻璃 / 纯色）
const modesEl = document.getElementById('bgModes');
const MODES = [
  { id: 'transparent', label: '透明' },
  { id: 'frosted', label: '默认毛玻璃' },
  { id: 'solid', label: '纯色' },
];
MODES.forEach((m) => {
  const b = document.createElement('div');
  b.className = 'mode';
  b.dataset.mode = m.id;
  b.textContent = m.label;
  b.addEventListener('click', () => { send({ bgMode: m.id }); });
  modesEl.appendChild(b);
});

wireColor('curveSwatches', 'curvePicker', 'curveColor', CURVE_COLORS);
wireColor('barSwatches', 'barPicker', 'barColor', BAR_COLORS);
wireColor('fontSwatches', 'fontPicker', 'fontColor', FONT_COLORS);
wireColor('bgSwatches', 'bgPicker', 'bgColor', BG_COLORS);

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('memory:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('memory:appearance-close:' + instId));

(async () => {
  try {
    const a = await ipcRenderer.invoke('memory:appearance-init:' + instId);
    if (a) appearance = { ...appearance, ...a };
  } catch (_) {}
  wireColor('curveSwatches', 'curvePicker', 'curveColor', CURVE_COLORS);
  wireColor('barSwatches', 'barPicker', 'barColor', BAR_COLORS);
  wireColor('fontSwatches', 'fontPicker', 'fontColor', FONT_COLORS);
  wireColor('bgSwatches', 'bgPicker', 'bgColor', BG_COLORS);
  refreshSelection();
})();
