// 日历外观调节窗口 —— 渲染进程：背景/文字/高亮三色（推荐色板 + 调色盘），只发送被修改项
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'cal-1';

// 每个样式一组推荐色（背景/文字/高亮 8 色）
const PALETTES = {
  bg: ['#16305c', '#141a33', '#f7f1e3', '#f5f1e8', '#ff8a5a', '#1c3a6e', '#2f4858', '#3d2b56'],
  text: ['#ffffff', '#f2ede4', '#4a3728', '#2b2b2b', '#1d1d1f', '#e8e0d0', '#ffe8c9', '#c9d6ff'],
  accent: ['#57b7ff', '#9ec3d9', '#d95a3a', '#c83e2a', '#e8c9a0', '#7fd1b9', '#ff9ec4', '#9d8cff'],
};
let colors = { bgColor: '', textColor: '', accentColor: '' };

function buildSwatches(container, list, current, onPick) {
  container.innerHTML = '';
  list.forEach((v) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (v.toLowerCase() === String(current).toLowerCase() ? ' sel' : '');
    s.style.background = v;
    s.addEventListener('click', () => onPick(v));
    container.appendChild(s);
  });
}
function refreshSel() {
  document.querySelectorAll('#bgSwatches .swatch').forEach((s) => s.classList.toggle('sel', s.style.background.toLowerCase() === String(colors.bgColor).toLowerCase()));
  document.querySelectorAll('#textSwatches .swatch').forEach((s) => s.classList.toggle('sel', s.style.background.toLowerCase() === String(colors.textColor).toLowerCase()));
  document.querySelectorAll('#accentSwatches .swatch').forEach((s) => s.classList.toggle('sel', s.style.background.toLowerCase() === String(colors.accentColor).toLowerCase()));
}
const send = (patch) => ipcRenderer.send('cal:appearance:' + instId, patch);
const pickBg = (v) => { colors.bgColor = v; send({ bgColor: v }); refreshSel(); };
const pickText = (v) => { colors.textColor = v; send({ textColor: v }); refreshSel(); };
const pickAccent = (v) => { colors.accentColor = v; send({ accentColor: v }); refreshSel(); };
buildSwatches(document.getElementById('bgSwatches'), PALETTES.bg, colors.bgColor, pickBg);
buildSwatches(document.getElementById('textSwatches'), PALETTES.text, colors.textColor, pickText);
buildSwatches(document.getElementById('accentSwatches'), PALETTES.accent, colors.accentColor, pickAccent);
document.getElementById('bgPicker').addEventListener('input', (e) => { colors.bgColor = e.target.value; send({ bgColor: e.target.value }); refreshSel(); });
document.getElementById('textPicker').addEventListener('input', (e) => { colors.textColor = e.target.value; send({ textColor: e.target.value }); refreshSel(); });
document.getElementById('accentPicker').addEventListener('input', (e) => { colors.accentColor = e.target.value; send({ accentColor: e.target.value }); refreshSel(); });
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('cal:appearance-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('cal:appearance-close:' + instId));

(async () => {
  try {
    const c = await ipcRenderer.invoke('cal:appearance-init:' + instId);
    if (c) {
      colors = {
        bgColor: c.bgColor || PALETTES.bg[0],
        textColor: c.textColor || PALETTES.text[0],
        accentColor: c.accentColor || PALETTES.accent[0],
      };
    } else {
      colors = { bgColor: PALETTES.bg[0], textColor: PALETTES.text[0], accentColor: PALETTES.accent[0] };
    }
  } catch (_) {
    colors = { bgColor: PALETTES.bg[0], textColor: PALETTES.text[0], accentColor: PALETTES.accent[0] };
  }
  buildSwatches(document.getElementById('bgSwatches'), PALETTES.bg, colors.bgColor, pickBg);
  buildSwatches(document.getElementById('textSwatches'), PALETTES.text, colors.textColor, pickText);
  buildSwatches(document.getElementById('accentSwatches'), PALETTES.accent, colors.accentColor, pickAccent);
  refreshSel();
})();
