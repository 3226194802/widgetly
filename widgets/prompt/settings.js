const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'prompt-1';
const $ = (id) => document.getElementById(id);
function status(text, type = '') { $('status').textContent = text || ''; $('status').className = 'status ' + type; }
(async () => {
  try {
    const c = await ipcRenderer.invoke('prompt:ai-config:' + instId);
    if (!c) return;
    $('baseUrl').value = c.baseUrl || 'https://api.openai.com/v1';
    $('model').value = c.model || '';
    $('strength').value = String(c.strength || 1);
    if (c.hasApiKey) $('keyHint').textContent = '已保存 API Key；留空可继续使用它，重新填写则会替换。';
  } catch (_) { status('无法读取当前配置', 'error'); }
})();
$('strength').addEventListener('change', () => ipcRenderer.send('prompt:strength:' + instId, Number($('strength').value)));
$('closeBtn').addEventListener('click', () => ipcRenderer.send('prompt:settings-close:' + instId));
async function saveConfig(test) {
  const button = test ? $('testSaveBtn') : $('saveBtn');
  const raw = { apiKey: $('apiKey').value, baseUrl: $('baseUrl').value, model: $('model').value, test };
  $('saveBtn').disabled = true; $('testSaveBtn').disabled = true;
  button.textContent = test ? '正在测试连接…' : '正在保存…'; status(test ? '正在连接 AI 服务，请稍候…' : '正在保存本地配置…');
  try {
    const out = await ipcRenderer.invoke('prompt:ai-config-save:' + instId, raw);
    if (!out || !out.ok) { status((out && out.error) || (test ? '测试失败' : '保存失败'), 'error'); return; }
    status(test ? '连接成功，配置已保存。' : '配置已保存。', 'ok');
    $('apiKey').value = '';
    $('keyHint').textContent = '已保存 API Key；留空可继续使用它，重新填写则会替换。';
    setTimeout(() => ipcRenderer.send('prompt:settings-close:' + instId), 700);
  } catch (_) { status('配置窗口通信异常', 'error'); }
  finally { $('saveBtn').disabled = false; $('testSaveBtn').disabled = false; $('saveBtn').textContent = '保存配置'; $('testSaveBtn').textContent = '测试并保存'; }
}
$('saveBtn').addEventListener('click', () => saveConfig(false));
$('testSaveBtn').addEventListener('click', () => saveConfig(true));
