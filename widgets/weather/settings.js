// 切换城市 —— 渲染进程：输入或点预设城市，保存后主进程立即刷新天气
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'weather-1';

const input = document.getElementById('cityInput');
const chipsEl = document.getElementById('chips');

function save() {
  const v = input.value.trim();
  if (!v) return;
  ipcRenderer.send('weather:settings-save:' + instId, v);
  ipcRenderer.send('weather:settings-close:' + instId);
}

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('weather:settings-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', save);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

(async () => {
  let init = { city: '北京', presets: [] };
  try {
    const c = await ipcRenderer.invoke('weather:settings-init:' + instId);
    if (c) init = c;
  } catch (_) {}
  input.value = init.city || '';
  (init.presets || []).forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = name;
    chip.addEventListener('click', () => { input.value = name; save(); });
    chipsEl.appendChild(chip);
  });
  input.focus();
  input.select();
})();
