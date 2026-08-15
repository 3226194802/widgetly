// 添加事项浮层 —— 输入 + 添加（Enter 提交 / Esc 取消）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'pomodoro-1';
const input = document.getElementById('input');
const send = (text) => ipcRenderer.send('pomodoro:add:' + instId, { text });
const close = () => ipcRenderer.send('pomodoro:add-close:' + instId);

document.getElementById('addBtn').addEventListener('click', () => { const t = input.value; if (t.trim()) send(t); else close(); });
document.getElementById('cancelBtn').addEventListener('click', close);
document.getElementById('closeBtn').addEventListener('click', close);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const t = input.value; if (t.trim()) send(t); else close(); }
  if (e.key === 'Escape') close();
});
setTimeout(() => { try { input.focus(); } catch (_) {} }, 80);
