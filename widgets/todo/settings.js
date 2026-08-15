// 每日待办设置窗口 —— 渲染进程
// 8 个日期卡片；点击添加、勾选完成、✕ 删除；
// 右键待办 → 浮动菜单窗口（复制模版/删除，跟随鼠标，不被窗口边界裁剪）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'todo-1';

const grid = document.getElementById('grid');
let days = [];

// ---------- 渲染 ----------
function render() {
  grid.innerHTML = '';
  days.forEach((day) => {
    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.date = day.key;

    const title = document.createElement('div');
    title.className = 'day-title';
    title.textContent = day.label;

    // 每个日期卡片右上角的「复制模板」按钮（不依赖右键，稳定可用）
    const copyBtn = document.createElement('div');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '复制模板';
    copyBtn.title = '从其他日期复制待办到本日（覆盖本日待办）';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ipcRenderer.send('activate');
      ipcRenderer.send('todo:menu:' + instId, { from: 'settings-btn', date: day.key });
    });
    const titleRow = document.createElement('div');
    titleRow.className = 'day-title-row';
    titleRow.append(title, copyBtn);

    const list = document.createElement('div');
    list.className = 'day-list';

    if (!day.todos.length) {
      const tip = document.createElement('div');
      tip.className = 'empty-tip';
      tip.textContent = '暂无待办';
      list.appendChild(tip);
    }
    day.todos.forEach((todo, i) => {
      const row = document.createElement('div');
      row.className = 'todo-row' + (todo.done ? ' done' : '');

      const box = document.createElement('span');
      box.className = 'check';
      box.textContent = todo.done ? '✓' : '';

      const text = document.createElement('span');
      text.className = 'todo-text';
      text.textContent = todo.text;

      const del = document.createElement('span');
      del.className = 'todo-del';
      del.textContent = '✕';

      row.append(box, text, del);
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        ipcRenderer.send('todo:toggle:' + instId, { date: day.key, index: i });
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        ipcRenderer.send('todo:remove:' + instId, { date: day.key, index: i });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        ipcRenderer.send('activate');
        ipcRenderer.send('todo:menu:' + instId, { from: 'settings', date: day.key, index: i });
      });
      list.appendChild(row);
    });

    const add = document.createElement('div');
    add.className = 'add-row';
    add.textContent = '+ 添加待办';
    add.addEventListener('click', () => startAdd(card, day.key));

    card.append(titleRow, list, add);
    grid.appendChild(card);
  });
}

// ---------- 添加（内联输入） ----------
function startAdd(card, date) {
  const listEl = card.querySelector('.day-list');
  if (listEl.querySelector('.add-input')) return;
  const input = document.createElement('input');
  input.className = 'add-input';
  input.placeholder = '输入待办，回车保存';
  listEl.appendChild(input);
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (input.value.trim()) ipcRenderer.send('todo:add:' + instId, { date, text: input.value.trim() });
      input.remove();
    }
  });
  input.addEventListener('blur', () => input.remove());
}

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('todo:settings-close:' + instId));
ipcRenderer.on('todo:settings-refresh:' + instId, (_e, d) => { days = d || []; render(); });

// 右键前先激活窗口：未激活窗口第一次右键不触发 contextmenu（Windows 行为，浮动菜单关闭后设置窗口偶发失焦）
document.addEventListener('mousedown', (e) => {
  if (e.button === 2) ipcRenderer.send('activate');
});
document.addEventListener('contextmenu', () => ipcRenderer.send('activate'));

(async () => {
  try {
    const init = await ipcRenderer.invoke('todo:settings-init:' + instId);
    if (init) { days = init.days || []; render(); }
  } catch (_) {}
})();
