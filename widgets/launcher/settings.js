// 启动器设置窗口
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'launcher-1';

const dshPath = document.getElementById('dshPath');
const port = document.getElementById('port');
const apiKey = document.getElementById('apiKey');
const eye = document.getElementById('eye');

eye.addEventListener('click', () => {
  const isPw = apiKey.type === 'password';
  apiKey.type = isPw ? 'text' : 'password';
  eye.textContent = isPw ? '隐藏' : '显示';
});
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('launcher:settings-close:' + instId));
document.getElementById('cancelBtn').addEventListener('click', () => ipcRenderer.send('launcher:settings-close:' + instId));
document.getElementById('saveBtn').addEventListener('click', () => {
  const browser = (document.querySelector('input[name="browser"]:checked') || {}).value || 'default';
  ipcRenderer.send('launcher:settings-save:' + instId, {
    dshPath: dshPath.value,
    port: port.value,
    browser,
    apiKey: apiKey.value,
  });
  ipcRenderer.send('launcher:settings-close:' + instId);
});

(async () => {
  try {
    const c = await ipcRenderer.invoke('launcher:settings-init:' + instId);
    if (c) {
      dshPath.value = c.dshPath || '';
      port.value = c.port || 3080;
      apiKey.value = c.apiKey || '';
      const rb = document.querySelector(`input[name="browser"][value="${c.browser || 'default'}"]`);
      if (rb) rb.checked = true;
    }
  } catch (_) {}
})();
