const { ipcRenderer, clipboard } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'prompt-1';
const $ = (id) => document.getElementById(id);
const levels = {
  1: '保留原意，只让表达更自然、清楚。',
  2: '补足必要的目标和输出要求；缺少关键信息时最多问两个问题。',
  3: '重构为直接、完整、可执行的高质量 AI 指令；必要时才提出关键问题。',
};
let strength = 1;
let bgOpacity = .4;
let locked = false;
let mode = 'large';
let result = '';
let resizing = false;
let resizeStart = null;

function setStatus(text, type = '') { const el = $('status'); el.textContent = text || ''; el.className = 'status ' + type; }
function applyOpacity(value) { bgOpacity = Math.max(0, Math.min(1, Number(value))); $('veil').style.opacity = String(bgOpacity); paintOpacity(); }
function chooseLevel(value, persist = true) {
  strength = Math.max(1, Math.min(3, Number(value) || 1));
  document.querySelectorAll('.level').forEach((el) => el.classList.toggle('active', Number(el.dataset.level) === strength));
  $('levelTip').textContent = levels[strength];
  if (persist) ipcRenderer.send('prompt:strength:' + instId, strength);
}
function applyMode(value) {
  mode = ['small', 'medium', 'large'].includes(value) ? value : 'large';
  document.body.dataset.mode = mode;
  $('source').placeholder = mode === 'small'
    ? '粘贴或输入内容…\n按 Ctrl + Enter 开始优化\n右键可设置强度、形态、AI 与历史对话'
    : '粘贴想交给 AI 的话…';
  document.body.classList.toggle('has-result', mode === 'small' && !!result);
}
function paintResult(text) {
  result = text || '';
  $('resultText').textContent = result || '配置 AI 服务后，即可把剪贴板里的想法变成可直接使用的提示词。';
  $('resultBox').classList.toggle('empty', !result);
  $('btnCopy').disabled = !result;
  document.body.classList.toggle('has-result', mode === 'small' && !!result);
}
function paintOpacity() {
  const transparent = Math.round((1 - bgOpacity) * 100);
  $('opFill').style.width = transparent + '%'; $('opThumb').style.left = transparent + '%'; $('opVal').textContent = transparent + '%';
}
function setOpacityFromX(x) {
  const r = $('opSlider').getBoundingClientRect(); if (!r.width) return;
  const transparent = Math.max(0, Math.min(100, Math.round((x - r.left) / r.width * 100)));
  applyOpacity(1 - transparent / 100);
}

document.querySelectorAll('.level').forEach((el) => el.addEventListener('click', () => chooseLevel(el.dataset.level)));
$('btnConfig').addEventListener('click', () => ipcRenderer.send('prompt:configure:' + instId));
$('btnHistory').addEventListener('click', () => ipcRenderer.send('prompt:history-open:' + instId));
$('btnReadClipboard').addEventListener('click', () => {
  try { $('source').value = clipboard.readText() || ''; setStatus($('source').value ? '已读取剪贴板内容' : '剪贴板中没有可读取的文本'); } catch (_) { setStatus('无法读取剪贴板，请手动粘贴', 'error'); }
});
$('btnClear').addEventListener('click', () => { $('source').value = ''; $('context').value = ''; paintResult(''); setStatus('已清空'); });
$('btnCopy').addEventListener('click', () => {
  if (!result) return;
  try { clipboard.writeText(result); setStatus('已复制优化结果', 'ok'); } catch (_) { setStatus('复制失败，请手动复制', 'error'); }
});
async function optimize() {
  const source = $('source').value.trim();
  if (!source) { setStatus('先粘贴或输入需要优化的内容', 'error'); $('source').focus(); return; }
  const button = $('btnOptimize'); button.disabled = true; button.textContent = '正在优化…'; setStatus('正在请求你配置的 AI 服务…');
  try {
    const out = await ipcRenderer.invoke('prompt:optimize:' + instId, { source, context: $('context').value.trim(), level: strength });
    if (!out || !out.ok) { setStatus((out && out.error) || '优化失败，请检查 AI 配置', 'error'); return; }
    paintResult(out.text); setStatus('优化完成', 'ok');
  } catch (_) { setStatus('组件通信异常，请重新打开此组件', 'error'); }
  finally { button.disabled = false; button.textContent = '✦ 开始优化'; }
}
$('btnOptimize').addEventListener('click', optimize);
$('source').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); optimize(); }
});
$('btnDone').addEventListener('click', () => { paintResult(''); setStatus(''); $('source').focus(); });

let opDragging = false, opHideTimer = null;
function setOpacityPanelVisible(visible) { const panel = $('opPanel'); panel.hidden = !visible; panel.style.display = visible ? 'flex' : 'none'; }
function scheduleOpacityHide() { if (opHideTimer) clearTimeout(opHideTimer); opHideTimer = setTimeout(() => setOpacityPanelVisible(false), 2200); }
ipcRenderer.on('show-opacity-panel:' + instId, () => { if (opHideTimer) clearTimeout(opHideTimer); setOpacityPanelVisible(true); paintOpacity(); scheduleOpacityHide(); });
$('opSlider').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); if (opHideTimer) clearTimeout(opHideTimer); opDragging = true; setOpacityFromX(e.clientX); });
document.addEventListener('mousemove', (e) => { if (opDragging) setOpacityFromX(e.clientX); });
document.addEventListener('mouseup', () => { if (!opDragging) return; opDragging = false; ipcRenderer.send('prompt:bg-opacity:' + instId, bgOpacity); scheduleOpacityHide(); });
document.addEventListener('mousedown', (e) => { if (!$('opPanel').hidden && !$('opPanel').contains(e.target)) setOpacityPanelVisible(false); });

// 自绘右下角缩放柄：透明无边框窗口也能直观地自由调节大小。
$('resizeGrip').addEventListener('mousedown', (e) => {
  if (locked) { setStatus('位置已锁定，请右键取消“锁定位置”后调整大小', 'error'); return; }
  e.preventDefault(); e.stopPropagation();
  resizing = true; resizeStart = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight, last: 0 };
});
document.addEventListener('mousemove', (e) => {
  if (!resizing || !resizeStart) return;
  const now = Date.now(); if (now - resizeStart.last < 32) return; resizeStart.last = now;
  ipcRenderer.send('prompt:resize:' + instId, { width: resizeStart.w + e.screenX - resizeStart.x, height: resizeStart.h + e.screenY - resizeStart.y });
});
document.addEventListener('mouseup', () => { resizing = false; resizeStart = null; });

document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0 || locked || resizing) return;
  if (e.target.closest && e.target.closest('textarea, button, .level, .op-panel, .resize-grip, .result-text')) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => { ipcRenderer.send('drag-end'); resizing = false; resizeStart = null; });
// 右键从鼠标按下阶段就主动请求组件菜单。contextmenu 作为键盘菜单键/特殊设备的兜底；
// 250ms 防抖避免同一次右键同时触发两条事件而重复弹菜单。
let lastMenuRequestAt = 0;
function requestWidgetMenu(e) {
  if (e) { e.preventDefault(); e.stopImmediatePropagation(); }
  const now = Date.now();
  if (now - lastMenuRequestAt < 250) return;
  lastMenuRequestAt = now;
  ipcRenderer.send('activate');
  ipcRenderer.send('prompt:menu:' + instId);
}
window.addEventListener('mousedown', (e) => { if (e.button === 2) requestWidgetMenu(e); }, true);
window.addEventListener('contextmenu', requestWidgetMenu, true);
// 防止双击落入 Windows 无边框窗口的原生最大化/还原路径。
window.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
ipcRenderer.on('prompt:state:' + instId, (_e, state) => {
  if (!state) return;
  locked = !!state.locked; applyMode(state.displayMode); applyOpacity(typeof state.bgOpacity === 'number' ? state.bgOpacity : .4); chooseLevel(state.strength || 1, false);
  setStatus(state.ai && state.ai.hasApiKey && state.ai.model ? 'AI 已配置：' + state.ai.model : '尚未配置 AI 服务，点击右上角 ⚙ 开始配置');
});
ipcRenderer.on('prompt:history-load:' + instId, (_e, item) => {
  if (!item) return;
  $('source').value = item.source || '';
  $('context').value = item.context || '';
  chooseLevel(item.strength || 1);
  paintResult('');
  setStatus('已载入历史对话，可继续修改后再次优化', 'ok');
  $('source').focus();
});
(async () => { try { const state = await ipcRenderer.invoke('prompt:init:' + instId); if (state) ipcRenderer.emit('prompt:state:' + instId, null, state); } catch (_) { setStatus('正在等待组件初始化…'); } })();
applyMode('large'); chooseLevel(1, false); applyOpacity(.4); paintResult(''); setOpacityPanelVisible(false);
