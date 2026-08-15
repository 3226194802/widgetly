// 捐助窗口 —— 渲染进程：微信收款二维码 + 选填捐赠信息（昵称/留言，复制后发给作者）
const { ipcRenderer } = require('electron');

const qrImg = document.getElementById('qrImg');
qrImg.addEventListener('error', () => {
  qrImg.style.display = 'none';
  document.getElementById('qrTip').style.display = '';
});
qrImg.src = '../assets/donate-qr.png';

// 复制捐赠信息（选填：昵称 / 留言）
document.getElementById('btnCopy').addEventListener('click', () => {
  const nick = document.getElementById('nickInput').value.trim();
  const msg = document.getElementById('msgInput').value.trim();
  const lines = ['【Widgetly 捐赠信息】'];
  if (nick) lines.push('昵称：' + nick);
  if (msg) lines.push('留言：' + msg);
  if (lines.length === 1) lines.push('（无留言）');
  const text = lines.join('\n');
  try {
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('btnCopy');
      const old = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = old; }, 1500);
    }).catch(() => {});
  } catch (_) {}
});

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('donate-close'));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('donate-close'));
