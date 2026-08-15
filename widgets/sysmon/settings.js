// 系统监测指标设置 —— 渲染进程：按槽位数动态生成下拉（标准 3 槽 / 大号 6 槽），即时保存生效
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'sysmon-1';

const rowsEl = document.getElementById('rows');
const selects = [];

function saveAll() {
  ipcRenderer.send('sysmon:settings-save:' + instId, selects.map((s) => s.value));
}

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('sysmon:settings-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('sysmon:settings-close:' + instId));

(async () => {
  let init = { slots: ['cpu', 'ram', 'gpu'], slotCount: 3, metrics: [] };
  try {
    const c = await ipcRenderer.invoke('sysmon:settings-init:' + instId);
    if (c) init = c;
  } catch (_) {}
  const metrics = init.metrics || [];
  const n = init.slotCount || (init.slots || []).length || 3;
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.textContent = '槽位 ' + (i + 1);
    const sel = document.createElement('select');
    metrics.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.icon + ' ' + m.name;
      sel.appendChild(o);
    });
    const cur = (init.slots || [])[i] || 'cpu';
    sel.value = metrics.some((m) => m.id === cur) ? cur : (metrics[0] ? metrics[0].id : '');
    sel.addEventListener('change', saveAll);
    row.append(lab, sel);
    rowsEl.appendChild(row);
    selects.push(sel);
  }
})();
