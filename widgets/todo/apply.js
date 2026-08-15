// 应用待办日期窗口 —— 渲染进程
// 选择多个日期应用此待办；可选「应用到以后每一天」
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'todo-1';

let days = [];
let selected = new Set();
let allDays = false;

const daysEl = document.getElementById('days');
const allRow = document.getElementById('allRow');
const allInput = document.getElementById('allDays');

function render() {
  daysEl.innerHTML = '';
  days.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'day-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(d.key);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(d.key); else selected.delete(d.key);
    });
    const label = document.createElement('span');
    label.textContent = d.label;
    item.append(cb, label);
    item.addEventListener('click', (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      if (cb.checked) selected.add(d.key); else selected.delete(d.key);
    });
    daysEl.appendChild(item);
  });
}

allRow.addEventListener('click', (e) => {
  if (e.target === allInput) return;
  allInput.checked = !allInput.checked;
  allDays = allInput.checked;
});
allInput.addEventListener('change', () => { allDays = allInput.checked; });

document.getElementById('okBtn').addEventListener('click', () => {
  ipcRenderer.send('todo:apply-confirm:' + instId, { dates: Array.from(selected), allDays });
});
document.getElementById('cancelBtn').addEventListener('click', () => ipcRenderer.send('todo:apply-close:' + instId));
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('todo:apply-close:' + instId));

(async () => {
  try {
    const init = await ipcRenderer.invoke('todo:apply-init:' + instId);
    if (init) {
      document.getElementById('todoText').textContent = init.dayMode ? '今日全部待办' : (init.text || '');
      days = init.days || [];
      render();
    }
  } catch (_) {}
})();
