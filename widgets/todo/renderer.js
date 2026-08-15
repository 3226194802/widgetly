// 今日待办组件 —— 渲染进程（主组件）
// 实时毛玻璃背景 + 彩色纽扣勾选框 + 浮动右键菜单（独立窗口，跟随鼠标，不被组件边界裁剪）
const { ipcRenderer } = require('electron');

const instId = new URLSearchParams(location.search).get('inst') || 'todo-1';

let today = null;
let todos = [];
let appearance = { bg: 'white', bgOpacity: 30, fontColor: '#1e2832', fontSize: 12 };
let size = 'medium';

const BTN_COLORS = ['#a8d8ff', '#ffb3b3', '#ffe08a', '#a9e6b8', '#d4bfff', '#ffc9a3', '#d9c4ae'];

const listEl = document.getElementById('list');
const addRow = document.getElementById('addRow');
const titleEl = document.getElementById('title');
const veilEl = document.getElementById('veil');

function applyAppearance() {
  veilEl.style.background = appearance.bg;
  veilEl.style.opacity = String(Math.max(0, Math.min(1, 1 - appearance.bgOpacity / 100)));
  titleEl.style.color = appearance.fontColor;
  listEl.style.color = appearance.fontColor;
  listEl.style.fontSize = appearance.fontSize + 'px';
  addRow.style.fontSize = appearance.fontSize + 'px';
  document.querySelectorAll('.todo-text').forEach((t) => { t.style.color = appearance.fontColor; });
}

function render() {
  listEl.innerHTML = '';
  todos.forEach((todo, i) => {
    const row = document.createElement('div');
    row.className = 'todo-row' + (todo.done ? ' done' : '');
    const color = BTN_COLORS[i % BTN_COLORS.length];
    const check = document.createElement('span');
    check.className = 'check';
    check.style.background = color;
    check.style.setProperty('--glow', color + 'cc');
    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;
    text.style.color = appearance.fontColor;
    row.append(check, text);
    check.addEventListener('click', (e) => { e.stopPropagation(); ipcRenderer.send('todo:toggle:' + instId, { date: today, index: i }); });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ipcRenderer.send('todo:menu:' + instId, { from: 'main', type: 'todo', index: i });
    });
    listEl.appendChild(row);
  });
  applyAppearance();
}

// ---------- 添加待办 ----------
addRow.addEventListener('click', () => startAdd());
function startAdd() {
  if (listEl.querySelector('.add-input')) return;
  const input = document.createElement('input');
  input.className = 'add-input';
  input.style.fontSize = appearance.fontSize + 'px';
  input.placeholder = '输入待办，回车保存';
  listEl.appendChild(input);
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (input.value.trim()) ipcRenderer.send('todo:add:' + instId, { date: today, text: input.value.trim() });
      input.remove();
    }
  });
  input.addEventListener('blur', () => input.remove());
}

// ---------- 浮动右键菜单（请求由主进程开独立菜单窗口） ----------
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest || !e.target.closest('.todo-row')) {
    e.preventDefault();
    ipcRenderer.send('todo:menu:' + instId, { from: 'main', type: 'blank' });
  }
});

// ---------- 数据推送 ----------
ipcRenderer.on('todo:changed:' + instId, (_e, data) => {
  if (!data) return;
  today = data.today;
  todos = data.todos || [];
  appearance = data.appearance || appearance;
  size = data.size || size;
  render();
});

// ---------- 拖动（双击防抖 + 输入框内不拖） ----------
let lastDownTime = 0;
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const now = Date.now();
  if (now - lastDownTime < 320) { lastDownTime = now; return; }   // 间隔双击第二次不拖
  lastDownTime = now;
  if (e.target.closest && e.target.closest('.add-input')) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

(async () => {
  try {
    const init = await ipcRenderer.invoke('todo:init:' + instId);
    if (init) {
      today = init.today;
      todos = init.todos || [];
      appearance = init.appearance || appearance;
      size = init.size || size;
      render();
    }
  } catch (_) {
    // 预览模式（管理器内 iframe 无主进程推送）：展示默认示例事项
    if (instId === 'preview') {
      today = new Date().toISOString().slice(0, 10);
      todos = [
        { text: '背英语单词', done: false },
        { text: '有氧训练', done: false },
        { text: '写周报', done: true },
      ];
      render();
    }
  }
})();
