const { ipcRenderer } = require('electron');
const params = new URLSearchParams(location.search);
const instId = params.get('inst') || '';
const menu = document.getElementById('menu');
let generation = 0;

function separator() {
  const el = document.createElement('div');
  el.className = 'sep';
  return el;
}

function sliderRow(item) {
  const el = document.createElement('div');
  el.className = 'slider-item';
  const head = document.createElement('div');
  head.className = 'slider-head';
  const label = document.createElement('span');
  label.textContent = item.label || '背景透明度';
  const value = document.createElement('b');
  const input = document.createElement('input');
  input.type = 'range'; input.min = '0'; input.max = '100'; input.step = '1';
  input.value = String(Math.max(0, Math.min(100, Number(item.value) || 0)));
  const paint = () => {
    value.textContent = `${input.value}%`;
    input.style.setProperty('--range-value', `${input.value}%`);
  };
  input.addEventListener('input', () => {
    paint();
    ipcRenderer.send('widgetly-menu:slide:' + instId, { generation, action: item.action, value: Number(input.value), done: false });
  });
  input.addEventListener('change', () => {
    ipcRenderer.send('widgetly-menu:slide:' + instId, { generation, action: item.action, value: Number(input.value), done: true });
  });
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  head.append(label, value); el.append(head, input); paint();
  return el;
}

function row(item) {
  if (item.kind === 'separator') return separator();
  if (item.kind === 'slider') return sliderRow(item);
  const el = document.createElement('div');
  el.className = 'item' + (item.on ? ' on' : '') + (item.danger ? ' danger' : '');
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = item.toggle && item.on ? '✓' : '';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.label || '';
  el.append(mark, title);
  if (item.state) {
    const state = document.createElement('span'); state.className = 'state'; state.textContent = item.state; el.appendChild(state);
  } else if (/…$/.test(item.label || '')) {
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '›'; el.appendChild(arrow);
  }
  el.addEventListener('click', () => ipcRenderer.send('widgetly-menu:click:' + instId, { generation, action: item.action }));
  return el;
}

function displayShortcut(shortcut) {
  return String(shortcut || '')
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/Command/gi, 'Cmd')
    .replace(/Super/gi, 'Win')
    .split('+')
    .join(' + ');
}

function recoveryHint(shortcut) {
  const el = document.createElement('div');
  el.className = 'recovery-hint';
  el.textContent = shortcut
    ? `穿透后按 ${displayShortcut(shortcut)} 解除`
    : '穿透后可从系统托盘解除';
  return el;
}

ipcRenderer.on('widgetly-menu:data:' + instId, (_event, data) => {
  generation = Number(data && data.generation) || 0;
  menu.innerHTML = '';
  (data.items || []).forEach((item) => menu.appendChild(row(item)));
  menu.appendChild(recoveryHint(data && data.clickThroughShortcut));
  requestAnimationFrame(() => ipcRenderer.send('widgetly-menu:ready:' + instId, {
    generation,
    // 加上 body 的四周留白，避免主进程按菜单自身宽度缩窗后裁掉右边框和阴影。
    width: Math.ceil(menu.getBoundingClientRect().width + 4),
    // Windows 缩放下边框会占用小数像素；额外留 2px，避免内容完整却出现一条伪滚动条。
    height: Math.ceil(menu.scrollHeight + 6),
  }));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') ipcRenderer.send('widgetly-menu:close:' + instId, generation);
});
