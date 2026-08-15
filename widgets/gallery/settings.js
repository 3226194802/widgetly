// 图库设置窗口 —— 渲染进程（独立于组件窗口，尺寸更大）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'gallery-1';

const folderBtn = document.getElementById('folderBtn');
const folderLabel = document.getElementById('folderLabel');
const durationSelect = document.getElementById('durationSelect');
const orderRandom = document.getElementById('orderRandom');
const orderSeq = document.getElementById('orderSeq');

function applyConfig(cfg) {
  if (!cfg) return;
  if (typeof cfg.duration === 'number' && cfg.duration > 0) durationSelect.value = String(cfg.duration);
  orderRandom.checked = cfg.order !== 'sequence';
  orderSeq.checked = cfg.order === 'sequence';
  folderLabel.textContent = cfg.folder || '未选择文件夹';
}

folderBtn.addEventListener('click', () => ipcRenderer.send('gallery:settings-pick:' + instId));
durationSelect.addEventListener('change', () => {
  ipcRenderer.send('gallery:settings-set:' + instId, { duration: parseInt(durationSelect.value, 10) || 5 });
});
orderRandom.addEventListener('change', () => ipcRenderer.send('gallery:settings-set:' + instId, { order: 'random' }));
orderSeq.addEventListener('change', () => ipcRenderer.send('gallery:settings-set:' + instId, { order: 'sequence' }));
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('gallery:settings-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('gallery:settings-close:' + instId));

ipcRenderer.on('gallery:settings-config:' + instId, (_e, cfg) => applyConfig(cfg));

(async () => {
  try {
    const cfg = await ipcRenderer.invoke('gallery:settings-init:' + instId);
    applyConfig(cfg);
  } catch (_) {}
})();
