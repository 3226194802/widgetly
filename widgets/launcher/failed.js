// 启动失败弹窗
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'launcher-1';
const list = document.getElementById('list');

ipcRenderer.on('launcher:failed:' + instId, (_e, reasons) => {
  list.innerHTML = '';
  (reasons || []).forEach((r) => {
    const p = document.createElement('div');
    p.textContent = r;
    list.appendChild(p);
  });
});
document.getElementById('closeBtn').addEventListener('click', () => window.close());
document.getElementById('okBtn').addEventListener('click', () => window.close());
