// 设置窗口 —— 渲染进程：开机自启 / 启动打开组件坞 / 固定组件层级
const { ipcRenderer } = require('electron');

function bindToggle(el, getCh, saveCh) {
  let on = false;
  el.addEventListener('click', () => {
    on = !on;
    el.classList.toggle('on', on);
    ipcRenderer.send(saveCh, on);
  });
  (async () => {
    try { on = await ipcRenderer.invoke(getCh); } catch (_) {}
    el.classList.toggle('on', !!on);
  })();
}

bindToggle(document.getElementById('tgAutostart'), 'autostart:get', 'autostart:save');
bindToggle(document.getElementById('tgOpenManager'), 'openManagerOnStart:get', 'openManagerOnStart:save');
bindToggle(document.getElementById('tgPin'), 'pinToDesktop:get', 'pinToDesktop:save');

// 开机自启方式下拉
const sel = document.getElementById('selAutostartMethod');
sel.addEventListener('change', () => ipcRenderer.send('autostartMethod:save', sel.value));
(async () => {
  try { sel.value = await ipcRenderer.invoke('autostartMethod:get'); } catch (_) {}
})();

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('settings-close'));

// 捐助窗口
document.getElementById('btnDonate').addEventListener('click', () => ipcRenderer.send('donate-open'));

// 联系渠道复制按钮
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const val = document.getElementById(btn.dataset.copy);
    if (!val) return;
    const text = val.textContent.trim();
    try {
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1200);
      }).catch(() => {});
    } catch (_) {}
  });
});

// ---------- 在线更新 ----------
const updateStatus = document.getElementById('updateStatus');
function paintUpdate(s) {
  if (!s) return;
  updateStatus.innerHTML = '';
  const line = document.createElement('span');
  if (s.state === 'available') {
    line.textContent = '发现新版本 v' + s.version;
    updateStatus.appendChild(line);
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '立即更新';
    btn.addEventListener('click', () => { updateStatus.textContent = '正在下载…'; ipcRenderer.send('update-download'); });
    updateStatus.appendChild(btn);
  } else if (s.state === 'downloading') {
    line.textContent = '正在下载更新 ' + (s.percent || 0) + '%';
    updateStatus.appendChild(line);
  } else if (s.state === 'downloaded') {
    line.textContent = '新版本 v' + s.version + ' 已下载';
    updateStatus.appendChild(line);
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '立即安装重启';
    btn.addEventListener('click', () => ipcRenderer.send('update-install'));
    updateStatus.appendChild(btn);
  } else if (s.state === 'none') {
    line.textContent = '已是最新版本 ✓';
    updateStatus.appendChild(line);
  } else if (s.state === 'error') {
    // 错误信息友好化：网络类错误给中文提示，原始错误折叠为小字详情
    const raw = String(s.message || '');
    const netMsg = /ENOTFOUND|ECONN|ETIMEDOUT|network|socket|connect|ERR_/i.test(raw)
      ? '无法连接更新服务器（网络问题）'
      : (/404|not found/i.test(raw) ? '服务器上未找到更新信息' : '检查更新失败');
    line.textContent = netMsg;
    updateStatus.appendChild(line);
    const detail = document.createElement('span');
    detail.style.cssText = 'font-size:10px;color:rgba(29,29,31,0.4);word-break:break-all;';
    detail.textContent = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
    updateStatus.appendChild(detail);
  }
}
document.getElementById('btnCheckUpdate').addEventListener('click', () => {
  updateStatus.textContent = '正在检查更新…';
  ipcRenderer.send('update-check');
});
// 打开浏览器下载页
document.getElementById('btnDownloadPage').addEventListener('click', () => ipcRenderer.send('open-download-page'));
ipcRenderer.on('update-status', (_e, s) => paintUpdate(s));

// 显示真实版本号
(async () => {
  try {
    const v = await ipcRenderer.invoke('app-version');
    if (v) {
      document.getElementById('verText').textContent = '当前版本 v' + v;
      document.getElementById('ver').textContent = 'v' + v;
    }
  } catch (_) {}
})();
