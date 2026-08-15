// 系统监测外观调节 —— 渲染进程：背景颜色 / 字体颜色 / 进度条颜色（实时生效）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'sysmon-1';

const BG_COLORS = ['#181a20', '#232a38', '#2b2623', '#1e2b25', '#33202a', '#141a33', '#20242e'];
const FONT_COLORS = ['#f2eee6', '#ffffff', '#e0e8f2', '#f2e2c0', '#f0e0dc', '#d8d2c8'];
// 进度条颜色第一个为「默认」（多色渐变=按指标各自的颜色），其余为统一单色
const BAR_COLORS = [null, '#5b9dff', '#ffd24a', '#41cfc4', '#41cf7f', '#a07fff', '#ff9a5c', '#ff8a7a'];

let appearance = { bgColor: '#181a20', fontColor: '#f2eee6', barColor: null };
const norm = (v) => String(v == null ? '' : v).toLowerCase();

function wire(key, containerId, pickerId, list) {
  const container = document.getElementById(containerId);
  const picker = document.getElementById(pickerId);
  function refresh() {
    container.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.val === norm(appearance[key])));
  }
  list.forEach((v) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (v == null ? ' def' : '');
    s.dataset.val = norm(v);
    s.style.background = v == null
      ? 'conic-gradient(#5b9dff, #ffd24a, #41cfc4, #a07fff, #5b9dff)'
      : String(v);
    s.title = v == null ? '默认（各指标独立颜色）' : String(v);
    s.addEventListener('click', () => {
      appearance[key] = v;
      ipcRenderer.send('sysmon:appearance:' + instId, { [key]: v });
      refresh();
    });
    container.appendChild(s);
  });
  picker.addEventListener('input', (e) => {
    appearance[key] = e.target.value;
    ipcRenderer.send('sysmon:appearance:' + instId, { [key]: e.target.value });
    refresh();
  });
}

wire('bgColor', 'bgSwatches', 'bgPicker', BG_COLORS);
wire('fontColor', 'fontSwatches', 'fontPicker', FONT_COLORS);
wire('barColor', 'barSwatches', 'barPicker', BAR_COLORS);

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('sysmon:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('sysmon:appearance-close:' + instId));

(async () => {
  try {
    const a = await ipcRenderer.invoke('sysmon:appearance-init:' + instId);
    if (a) appearance = { ...appearance, ...a };
  } catch (_) {}
  // 刷新选中态
  [['bgColor', 'bgSwatches'], ['fontColor', 'fontSwatches'], ['barColor', 'barSwatches']].forEach(([key, id]) => {
    document.getElementById(id).querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.val === norm(appearance[key])));
  });
})();
