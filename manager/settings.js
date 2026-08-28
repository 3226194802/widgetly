// 设置窗口 —— 渲染进程：开机自启 / 托盘行为 / 固定组件层级
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
bindToggle(document.getElementById('tgCloseToTray'), 'closeToTray:get', 'closeToTray:save');
bindToggle(document.getElementById('tgPin'), 'pinToDesktop:get', 'pinToDesktop:save');

// 开机自启方式下拉
const sel = document.getElementById('selAutostartMethod');
sel.addEventListener('change', () => ipcRenderer.send('autostartMethod:save', sel.value));
(async () => {
  try { sel.value = await ipcRenderer.invoke('autostartMethod:get'); } catch (_) {}
})();

// ---------- 全局解除鼠标穿透快捷键 ----------
const shortcutRecorder = document.getElementById('shortcutRecorder');
const shortcutStatus = document.getElementById('shortcutStatus');
const btnSaveShortcut = document.getElementById('btnSaveShortcut');
const btnResetShortcut = document.getElementById('btnResetShortcut');
let pendingShortcut = 'CommandOrControl+Alt+Shift+W';
let recordingShortcut = false;

function displayShortcut(shortcut) {
  return String(shortcut || '')
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/Command/gi, 'Cmd')
    .replace(/Super/gi, 'Win')
    .split('+')
    .join(' + ');
}

function paintShortcutStatus(message, type = '') {
  shortcutStatus.textContent = message || '';
  shortcutStatus.classList.toggle('success', type === 'success');
  shortcutStatus.classList.toggle('error', type === 'error');
}

function stopShortcutRecording({ restoreText = true } = {}) {
  recordingShortcut = false;
  shortcutRecorder.classList.remove('recording');
  if (restoreText) shortcutRecorder.textContent = displayShortcut(pendingShortcut);
}

function acceleratorKey(event) {
  const code = String(event.code || '');
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) return code;
  const named = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  return named[event.key] || '';
}

shortcutRecorder.addEventListener('click', () => {
  recordingShortcut = true;
  shortcutRecorder.classList.add('recording');
  shortcutRecorder.textContent = '请按新组合键…';
  paintShortcutStatus('录制中：按 Esc 可取消；建议使用两个以上修饰键', '');
  shortcutRecorder.focus();
});

window.addEventListener('keydown', (event) => {
  if (!recordingShortcut) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') {
    stopShortcutRecording();
    paintShortcutStatus('已取消录制，原快捷键未改变');
    return;
  }
  const key = acceleratorKey(event);
  if (!key) return;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('CommandOrControl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  if (!modifiers.length) {
    paintShortcutStatus('请至少同时按住一个 Ctrl、Alt、Shift 或 Win 键', 'error');
    return;
  }
  pendingShortcut = [...modifiers, key].join('+');
  stopShortcutRecording();
  paintShortcutStatus('已录制，点击“保存”后才会生效');
}, true);

window.addEventListener('blur', () => {
  if (!recordingShortcut) return;
  stopShortcutRecording();
  paintShortcutStatus('窗口失去焦点，已取消本次录制');
});

async function applyShortcut(channel) {
  stopShortcutRecording();
  btnSaveShortcut.disabled = true;
  btnResetShortcut.disabled = true;
  paintShortcutStatus('正在验证快捷键是否可用…');
  try {
    const result = await ipcRenderer.invoke(channel, pendingShortcut);
    pendingShortcut = (result && result.configuredShortcut) || pendingShortcut;
    shortcutRecorder.textContent = displayShortcut(pendingShortcut);
    if (result && result.ok) {
      paintShortcutStatus(result.message || '快捷键已保存并生效', 'success');
    } else {
      const fallback = result && result.activeShortcut ? ` 当前仍可用：${displayShortcut(result.activeShortcut)}` : '';
      paintShortcutStatus(((result && result.message) || '快捷键保存失败') + fallback, 'error');
    }
  } catch (_) {
    paintShortcutStatus('保存失败，请稍后重试；原快捷键不会被替换', 'error');
  } finally {
    btnSaveShortcut.disabled = false;
    btnResetShortcut.disabled = false;
  }
}

btnSaveShortcut.addEventListener('click', () => applyShortcut('clickThroughShortcut:save'));
btnResetShortcut.addEventListener('click', async () => {
  try {
    const state = await ipcRenderer.invoke('clickThroughShortcut:get');
    pendingShortcut = (state && state.defaultShortcut) || 'CommandOrControl+Alt+Shift+W';
  } catch (_) {
    pendingShortcut = 'CommandOrControl+Alt+Shift+W';
  }
  shortcutRecorder.textContent = displayShortcut(pendingShortcut);
  applyShortcut('clickThroughShortcut:reset');
});

(async () => {
  try {
    const state = await ipcRenderer.invoke('clickThroughShortcut:get');
    pendingShortcut = (state && state.configuredShortcut) || pendingShortcut;
    shortcutRecorder.textContent = displayShortcut(pendingShortcut);
    if (state && state.registered) {
      paintShortcutStatus(`已生效：${displayShortcut(state.activeShortcut)}`, 'success');
    } else {
      paintShortcutStatus((state && state.message) || '当前快捷键未注册，请重新保存或恢复默认', 'error');
    }
  } catch (_) {
    shortcutRecorder.textContent = displayShortcut(pendingShortcut);
    paintShortcutStatus('读取快捷键失败，请重新打开设置', 'error');
  }
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
