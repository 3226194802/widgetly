const { ipcRenderer } = require('electron');
const qs = new URLSearchParams(location.search);
const instId = qs.get('inst') || 'countdown-preview';
const variant = document.body.dataset.variant || 'single';
const isPreview = instId === 'preview';
let state = null;

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function plusDays(n) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return dateKey(d); }
function previewState() {
  const targets = [
    { id: 'demo-new-year', name: 'New Year', date: plusDays(132), color: '#319fe8' },
    { id: 'demo-weekend', name: '星期六', date: plusDays(0), color: '#5776d9' },
    { id: 'demo-release', name: 'iPhone 发布', date: plusDays(6994), color: '#ff9f2e' },
  ];
  return {
    variant, targets, activeId: targets[0].id, slotIds: targets.map((t) => t.id),
    appearance: { bgOpacity: .2, bgColor: '#f7fbff', textColor: '#142033', accentColor: '#319fe8', secondaryColor: '#ff9f2e' },
  };
}
function targetDays(target) {
  if (!target || !target.date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(target.date + 'T00:00:00');
  if (Number.isNaN(end.getTime())) return null;
  return Math.round((end.getTime() - today.getTime()) / 86400000);
}
function todayLabel() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日  ${WEEK[d.getDay()]}`;
}
function byId(id) { return state && state.targets ? state.targets.find((t) => t.id === id) : null; }
function lengthClass(el, text) {
  el.classList.remove('long', 'very-long');
  if (String(text).length >= 6) el.classList.add('very-long');
  else if (String(text).length >= 4) el.classList.add('long');
}
function applyAppearance() {
  const a = (state && state.appearance) || previewState().appearance;
  const root = document.documentElement;
  root.style.setProperty('--bg', a.bgColor || '#f7fbff');
  root.style.setProperty('--text', a.textColor || '#142033');
  root.style.setProperty('--accent', a.accentColor || '#319fe8');
  root.style.setProperty('--secondary', a.secondaryColor || '#ff9f2e');
  root.style.setProperty('--bg-opacity', String(typeof a.bgOpacity === 'number' ? a.bgOpacity : .2));
}
function renderSingle() {
  const target = byId(state.activeId) || (state.targets && state.targets[0]);
  const title = document.getElementById('heroTitle');
  const num = document.getElementById('heroNumber');
  document.getElementById('todayText').textContent = todayLabel();
  if (!target) {
    document.getElementById('heroName').textContent = '添加目标日期';
    document.getElementById('heroStatus').textContent = '';
    num.textContent = '＋'; lengthClass(num, '＋');
    document.getElementById('heroUnit').textContent = '右键设置目标日期';
    title.style.background = '';
    title.style.removeProperty('--target-color');
    return;
  }
  const days = targetDays(target);
  const shown = days == null ? '—' : String(Math.abs(days));
  document.getElementById('heroName').textContent = target.name;
  document.getElementById('heroStatus').textContent = days < 0 ? '已过' : '还有';
  num.textContent = shown; lengthClass(num, shown);
  document.getElementById('heroUnit').textContent = days === 0 ? '就是今天' : (days < 0 ? `已经过去 ${shown} 天` : `距离目标还有 ${shown} 天`);
  title.style.background = '';
  title.style.setProperty('--target-color', target.color || 'rgba(255,255,255,.88)');
}
function renderTriple() {
  document.getElementById('todayText').textContent = todayLabel();
  const rows = [...document.querySelectorAll('.count-row')];
  rows.forEach((row, i) => {
    const target = byId(state.slotIds && state.slotIds[i]) || (state.targets && state.targets[i]);
    const name = row.querySelector('.row-name');
    const num = row.querySelector('.row-number');
    if (!target) {
      name.textContent = '点击选择目标'; num.textContent = '＋'; num.title = '选择要显示的目标日期';
      row.style.setProperty('--row-accent', i === 2 ? 'var(--secondary)' : (i === 1 ? 'color-mix(in srgb,var(--accent) 55%,var(--secondary))' : 'var(--accent)'));
      row.style.setProperty('--target-color', 'var(--row-accent)');
      lengthClass(num, '＋');
      return;
    }
    const days = targetDays(target);
    const shown = days == null ? '—' : (days < 0 ? `-${Math.abs(days)}` : String(days));
    name.textContent = target.name;
    num.textContent = shown;
    num.title = days === 0 ? '就是今天' : (days < 0 ? `已过去 ${Math.abs(days)} 天` : `还有 ${days} 天`);
    row.style.setProperty('--row-accent', i === 2 ? 'var(--secondary)' : (i === 1 ? 'color-mix(in srgb,var(--accent) 55%,var(--secondary))' : 'var(--accent)'));
    row.style.setProperty('--target-color', target.color || 'var(--row-accent)');
    lengthClass(num, shown);
  });
}
function render() {
  if (!state) state = previewState();
  applyAppearance();
  if (variant === 'single') renderSingle(); else renderTriple();
}

const card = document.getElementById('card');
let dragging = false;
card.addEventListener('mousedown', (e) => {
  if (isPreview) return;
  // 未激活窗口第一次右键也必须先拿到焦点，不能等 contextmenu 事件再激活。
  if (e.button === 2) { ipcRenderer.send('activate'); return; }
  if (e.target.closest('button')) return;
  if (e.button === 0) { dragging = true; ipcRenderer.send('drag-start'); }
});
function endDrag() { if (!isPreview && dragging) { dragging = false; ipcRenderer.send('drag-end'); } }
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);
card.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!isPreview) { ipcRenderer.send('activate'); ipcRenderer.send('countdown:menu:' + instId); }
});

const heroTitle = document.getElementById('heroTitle');
if (heroTitle) heroTitle.addEventListener('click', () => { if (!isPreview) ipcRenderer.send('countdown:select:' + instId, -1); });
document.querySelectorAll('.count-row').forEach((row) => row.addEventListener('click', () => {
  if (!isPreview) ipcRenderer.send('countdown:select:' + instId, Number(row.dataset.slot));
}));
const manageBtn = document.getElementById('manageBtn');
if (manageBtn) manageBtn.addEventListener('click', () => { if (!isPreview) ipcRenderer.send('countdown:settings-open:' + instId); });

ipcRenderer.on('countdown:state:' + instId, (_e, next) => { if (next) { state = next; render(); } });
(async () => {
  if (isPreview) state = previewState();
  else {
    try { state = await ipcRenderer.invoke('countdown:init:' + instId); } catch (_) { state = previewState(); }
  }
  render();
  setInterval(render, 60000);
})();
