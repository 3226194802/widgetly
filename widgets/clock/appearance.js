// 时钟外观调节窗口 —— 渲染进程（数据驱动）
// 标准/小号时钟（kind=gradient）：背景底色 + 4 个数字独立颜色；中号时钟（kind=medium）：背景底色 + 左边填充/右边描边
// 推荐色板 + 调色盘实时生效；数字色的「默认」色板 = 恢复该位默认渐变
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'clock-1';

const BG_PALETTE = ['#ffffff', '#e8ebef', '#f5f1e8', '#141a33', '#232a38', '#2b2623', '#1e2b25', '#3e3128'];
const DIGIT_PALETTE = ['#2B7FFF', '#00C6FF', '#00E5C8', '#3DE57A', '#ffffff', '#1d1d1f', '#e0352b', '#e8930c', '#8b5cf6', '#ff5ca8'];
const HM_PALETTE = ['#ffffff', '#1d1d1f', '#0a5bd3', '#e0352b', '#1a8a4a', '#e8930c', '#8b5cf6', '#0aa8a8'];

let state = { kind: 'gradient', bgColor: null, digitColors: {}, hourColor: '#ffffff', minuteColor: '#ffffff' };

const rowsEl = document.getElementById('rows');
const send = (patch) => ipcRenderer.send('clock:appearance:' + instId, patch);
const norm = (v) => String(v == null ? '' : v).toLowerCase();

// 构建一行：label + 色板 + 调色盘。get() 返回当前值（null/'' 表示默认），set(v) 应用并上报
function makeRow(label, get, set) {
  const row = document.createElement('div');
  row.className = 'row';
  const lbl = document.createElement('span');
  lbl.className = 'label';
  lbl.textContent = label;
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'picker';
  row.append(lbl, swatches, picker);

  function refresh() {
    swatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.val === norm(get())));
  }
  function addSwatch(val, isDefault) {
    const s = document.createElement('div');
    s.className = 'swatch' + (isDefault ? ' def' : '');
    s.dataset.val = norm(val);
    s.style.background = isDefault
      ? 'conic-gradient(#2B7FFF, #00C6FF, #00E5C8, #3DE57A, #2B7FFF)'
      : String(val);
    s.title = isDefault ? '恢复默认' : String(val);
    s.addEventListener('click', () => { set(val); refresh(); });
    swatches.appendChild(s);
  }
  picker.addEventListener('input', (e) => { set(e.target.value); refresh(); });
  return { row, addSwatch, refresh };
}

function build() {
  rowsEl.innerHTML = '';
  const rows = [];

  const bg = makeRow('背景底色', () => state.bgColor, (v) => { state.bgColor = v; send({ bgColor: v }); });
  BG_PALETTE.forEach((c) => bg.addSwatch(c, false));
  rows.push(bg);

  if (state.kind === 'medium') {
    const hour = makeRow('左边数字颜色', () => state.hourColor, (v) => { state.hourColor = v; send({ hourColor: v }); });
    HM_PALETTE.forEach((c) => hour.addSwatch(c, false));
    rows.push(hour);
    const min = makeRow('右边数字描边', () => state.minuteColor, (v) => { state.minuteColor = v; send({ minuteColor: v }); });
    HM_PALETTE.forEach((c) => min.addSwatch(c, false));
    rows.push(min);
  } else {
    const labels = ['数字 1（时十位）', '数字 2（时个位）', '数字 3（分十位）', '数字 4（分个位）'];
    ['h1', 'h2', 'm1', 'm2'].forEach((k, i) => {
      const r = makeRow(labels[i], () => state.digitColors[k] || null, (v) => { state.digitColors[k] = v; send({ digitColors: { [k]: v } }); });
      r.addSwatch(null, true);   // 默认渐变
      DIGIT_PALETTE.forEach((c) => r.addSwatch(c, false));
      rows.push(r);
    });
  }

  rows.forEach((r) => { rowsEl.appendChild(r.row); r.refresh(); });
}

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('clock:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('clock:appearance-close:' + instId));
document.getElementById('resetBtn').addEventListener('click', () => {
  ipcRenderer.send('clock:appearance-reset:' + instId);
  state = { ...state, bgColor: null, digitColors: {}, hourColor: '#ffffff', minuteColor: '#ffffff' };
  build();
});

(async () => {
  try {
    const c = await ipcRenderer.invoke('clock:appearance-init:' + instId);
    if (c) state = { ...state, ...c, digitColors: { ...(c.digitColors || {}) } };
  } catch (_) {}
  build();
})();
