const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'countdown-1';
const ids = ['bgColor', 'textColor', 'accentColor', 'secondaryColor'];
const PRESETS = {
  sky: { bgColor: '#f7fbff', textColor: '#142033', accentColor: '#319fe8', secondaryColor: '#ff9f2e' },
  violet: { bgColor: '#f4f0ff', textColor: '#30264e', accentColor: '#8b74e8', secondaryColor: '#d66ba0' },
  mint: { bgColor: '#edf9f4', textColor: '#183d32', accentColor: '#27b58a', secondaryColor: '#52aee5' },
  peach: { bgColor: '#fff4ee', textColor: '#4a2f28', accentColor: '#f0835a', secondaryColor: '#eab53d' },
  night: { bgColor: '#17233c', textColor: '#f3f6ff', accentColor: '#5faeff', secondaryColor: '#ffac54' },
  rose: { bgColor: '#fff2f6', textColor: '#4f2735', accentColor: '#ef6d86', secondaryColor: '#9b78e8' },
};
let current = { ...PRESETS.sky, bgOpacity: .2 };
function rgba(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(247,251,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
function paint() {
  ids.forEach((id) => { document.getElementById(id).value = current[id]; });
  const transparency = Math.round((1 - (typeof current.bgOpacity === 'number' ? current.bgOpacity : .2)) * 100);
  document.getElementById('transparency').value = transparency;
  document.getElementById('transparencyValue').textContent = transparency + '%';
  const preview = document.getElementById('preview');
  preview.style.setProperty('--bg', current.bgColor); preview.style.setProperty('--text', current.textColor); preview.style.setProperty('--accent', current.accentColor);
  preview.style.background = rgba(current.bgColor, typeof current.bgOpacity === 'number' ? current.bgOpacity : .2);
}
function save() { ipcRenderer.send('countdown:appearance-save:' + instId, current); }
ids.forEach((id) => document.getElementById(id).addEventListener('input', (e) => { current[id] = e.target.value; paint(); save(); }));
document.getElementById('transparency').addEventListener('input', (e) => { current.bgOpacity = 1 - Number(e.target.value) / 100; paint(); save(); });
document.querySelectorAll('.preset').forEach((button) => button.addEventListener('click', () => { current = { ...current, ...PRESETS[button.dataset.preset] }; paint(); save(); }));
document.getElementById('resetBtn').addEventListener('click', () => ipcRenderer.send('countdown:appearance-reset:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('countdown:appearance-close:' + instId));
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('countdown:appearance-close:' + instId));
ipcRenderer.on('countdown:appearance-state:' + instId, (_e, s) => { if (s) { current = { ...current, ...s }; paint(); } });
(async () => { try { const s = await ipcRenderer.invoke('countdown:appearance-init:' + instId); if (s) current = { ...current, ...s }; } catch (_) {} paint(); })();
