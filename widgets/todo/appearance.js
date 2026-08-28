// 外观设置窗口 —— 渲染进程（背景透明度统一在组件右键菜单直接调节）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'todo-1';

let appearance = { bg: 'white', bgOpacity: 40, fontColor: '#1e2832', fontSize: 12 };

const BG_GRADIENTS = [
  { name: '白色', v: '#ffffff' },
  { name: '浅蓝', v: '#d6eaff' },
  { name: '浅粉', v: '#ffe3e8' },
  { name: '浅绿', v: '#dcf5e0' },
  { name: '蓝紫', v: 'linear-gradient(135deg,#9ec9ff,#c3b5ff)' },
  { name: '日出', v: 'linear-gradient(135deg,#ffd3a5,#ff9a9e)' },
  { name: '薄荷', v: 'linear-gradient(135deg,#c9f5e2,#a7e3d0)' },
  { name: '晚霞', v: 'linear-gradient(135deg,#fbc2eb,#a6c1ee)' },
  { name: '海洋', v: 'linear-gradient(135deg,#a1c4fd,#c2e9fb)' },
  { name: '夜色', v: 'linear-gradient(135deg,#8ea2c4,#5d6d8f)' },
];
const FONT_COLORS = ['#1e2832', '#ffffff', '#0a5bd3', '#d33', '#1a7f37', '#b25e09', '#8b5cf6', '#666'];

function buildSwatches(container, list, current, onPick) {
  container.innerHTML = '';
  list.forEach((v) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (v === current ? ' sel' : '');
    s.style.background = v;
    s.addEventListener('click', () => onPick(v));
    container.appendChild(s);
  });
}
function refreshSelection() {
  document.querySelectorAll('#bgSwatches .swatch').forEach((s) => s.classList.toggle('sel', s.style.background === appearance.bg));
  document.querySelectorAll('#fontSwatches .swatch').forEach((s) => s.classList.toggle('sel', s.style.background === appearance.fontColor));
  document.querySelectorAll('.size').forEach((b) => b.classList.toggle('sel', parseInt(b.dataset.size, 10) === appearance.fontSize));
}

// 背景色
buildSwatches(document.getElementById('bgSwatches'), BG_GRADIENTS.map((g) => g.v), appearance.bg, (v) => {
  appearance.bg = v;
  ipcRenderer.send('todo:appearance:' + instId, { bg: v });
  refreshSelection();
});
document.getElementById('bgPicker').addEventListener('input', (e) => {
  appearance.bg = e.target.value;
  ipcRenderer.send('todo:appearance:' + instId, { bg: e.target.value });
  refreshSelection();
});

// 字体色
buildSwatches(document.getElementById('fontSwatches'), FONT_COLORS, appearance.fontColor, (v) => {
  appearance.fontColor = v;
  ipcRenderer.send('todo:appearance:' + instId, { fontColor: v });
  refreshSelection();
});
document.getElementById('fontPicker').addEventListener('input', (e) => {
  appearance.fontColor = e.target.value;
  ipcRenderer.send('todo:appearance:' + instId, { fontColor: e.target.value });
  refreshSelection();
});

// 字号（数字选项）
const sizesEl = document.getElementById('fontSizes');
[10, 12, 14, 16, 18, 20].forEach((n) => {
  const b = document.createElement('button');
  b.className = 'size';
  b.dataset.size = String(n);
  b.textContent = String(n);
  b.addEventListener('click', () => {
    appearance.fontSize = n;
    ipcRenderer.send('todo:appearance:' + instId, { fontSize: n });
    refreshSelection();
  });
  sizesEl.appendChild(b);
});

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('todo:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('todo:appearance-close:' + instId));

(async () => {
  try {
    const a = await ipcRenderer.invoke('todo:appearance-init:' + instId);
    if (a) appearance = a;
  } catch (_) {}
  buildSwatches(document.getElementById('bgSwatches'), BG_GRADIENTS.map((g) => g.v), appearance.bg, (v) => {
    appearance.bg = v;
    ipcRenderer.send('todo:appearance:' + instId, { bg: v });
    refreshSelection();
  });
  buildSwatches(document.getElementById('fontSwatches'), FONT_COLORS, appearance.fontColor, (v) => {
    appearance.fontColor = v;
    ipcRenderer.send('todo:appearance:' + instId, { fontColor: v });
    refreshSelection();
  });
  refreshSelection();
})();
