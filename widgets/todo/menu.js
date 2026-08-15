// 浮动右键菜单窗口 —— 渲染进程
// 主进程填充菜单项；点击/失焦/ESC 关闭；渲染完成后回报内容尺寸用于定位（避开屏幕边缘）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'todo-1';
const menuEl = document.getElementById('menu');
let gen = 0;

ipcRenderer.on('todo:menu-items:' + instId, (_e, data) => {
  if (!data) return;
  gen = data.gen || 0;
  menuEl.innerHTML = '';
  (data.items || []).forEach((it) => {
    if (it.kind === 'head') {
      const h = document.createElement('div');
      h.className = 'head';
      h.textContent = it.label;
      menuEl.appendChild(h);
    } else if (it.kind === 'sep') {
      const s = document.createElement('div');
      s.className = 'sep';
      menuEl.appendChild(s);
    } else {
      const el = document.createElement('div');
      el.className = 'item' + (it.danger ? ' danger' : '');
      el.textContent = it.label;
      el.addEventListener('click', () => {
        ipcRenderer.send('todo:menu-click:' + instId, { gen, action: it.action, payload: it.payload });
      });
      menuEl.appendChild(el);
    }
  });
  ipcRenderer.send('todo:menu-ready:' + instId, { gen, w: menuEl.offsetWidth, h: menuEl.offsetHeight });
});

// 点击菜单空白处或按 ESC 关闭
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest || !e.target.closest('.item')) ipcRenderer.send('todo:menu-close:' + instId);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('todo:menu-close:' + instId);
});
