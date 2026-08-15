// 天气外观调节 —— 渲染进程：背景颜色 / 字体颜色（实时生效）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'weather-1';

const BG_COLORS = ['#1e212a', '#16305c', '#2b2623', '#1e2b25', '#33202a', '#141a33', '#20242e', '#f7f1e3'];
const FONT_COLORS = ['#f2eee6', '#ffffff', '#e0e8f2', '#f2e2c0', '#f0e0dc', '#1d1d1f', '#4a3728'];

let appearance = { bgColor: '#1e212a', fontColor: '#f2eee6' };
const norm = (v) => String(v == null ? '' : v).toLowerCase();

function wire(key, containerId, pickerId, list) {
  const container = document.getElementById(containerId);
  const picker = document.getElementById(pickerId);
  function refresh() {
    container.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.val === norm(appearance[key])));
  }
  list.forEach((v) => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.dataset.val = norm(v);
    s.style.background = String(v);
    s.title = String(v);
    s.addEventListener('click', () => {
      appearance[key] = v;
      ipcRenderer.send('weather:appearance:' + instId, { [key]: v });
      refresh();
    });
    container.appendChild(s);
  });
  picker.addEventListener('input', (e) => {
    appearance[key] = e.target.value;
    ipcRenderer.send('weather:appearance:' + instId, { [key]: e.target.value });
    refresh();
  });
}

wire('bgColor', 'bgSwatches', 'bgPicker', BG_COLORS);
wire('fontColor', 'fontSwatches', 'fontPicker', FONT_COLORS);

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('weather:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('weather:appearance-close:' + instId));

(async () => {
  try {
    const a = await ipcRenderer.invoke('weather:appearance-init:' + instId);
    if (a) appearance = { ...appearance, ...a };
  } catch (_) {}
  [['bgColor', 'bgSwatches'], ['fontColor', 'fontSwatches']].forEach(([key, id]) => {
    document.getElementById(id).querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.val === norm(appearance[key])));
  });
})();
