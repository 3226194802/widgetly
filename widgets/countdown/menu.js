const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'countdown-1';
const menu = document.getElementById('menu');
let gen = 0;
let drag = null;

function sendClick(item) {
  ipcRenderer.send('countdown:menu-click:' + instId, { gen, action: item.action, payload: item.payload });
}
ipcRenderer.on('countdown:menu-items:' + instId, (_e, data) => {
  if (!data) return;
  gen = data.gen || 0;
  menu.innerHTML = '';
  (data.items || []).forEach((item) => {
    if (item.kind === 'sep') {
      const el = document.createElement('div'); el.className = 'sep'; menu.appendChild(el); return;
    }
    if (item.kind === 'label') {
      const el = document.createElement('div'); el.className = 'label'; el.textContent = item.label; menu.appendChild(el); return;
    }
    if (item.kind === 'slider') {
      const row = document.createElement('div'); row.className = 'item slider-row';
      const label = document.createElement('span'); label.textContent = item.label;
      const track = document.createElement('div'); track.className = 'slider-track';
      const fill = document.createElement('div'); fill.className = 'slider-fill';
      const thumb = document.createElement('div'); thumb.className = 'slider-thumb';
      const value = document.createElement('span'); value.className = 'slider-val';
      track.append(fill, thumb); row.append(label, track, value);
      let current = Number.isFinite(Number(item.value)) ? Number(item.value) : 70;
      const paint = () => { fill.style.width = current + '%'; thumb.style.left = current + '%'; value.textContent = Math.round(current) + '%'; };
      const setFromX = (x, done) => {
        const r = track.getBoundingClientRect();
        if (!r.width) return;
        current = Math.max(0, Math.min(100, Math.round((x - r.left) / r.width * 100)));
        paint();
        ipcRenderer.send('countdown:menu-slide:' + instId, { gen, v: current, done: !!done });
      };
      track.addEventListener('mousedown', (e) => { e.preventDefault(); drag = { track, setFromX }; setFromX(e.clientX, false); });
      paint(); menu.appendChild(row); return;
    }
    const el = document.createElement('div'); el.className = 'item' + (item.danger ? ' danger' : '');
    const left = document.createElement('span'); left.className = 'left';
    if (item.swatch) { const dot = document.createElement('span'); dot.className = 'swatch'; dot.style.background = item.swatch; left.appendChild(dot); }
    const text = document.createElement('span'); text.textContent = item.label; left.appendChild(text); el.appendChild(left);
    el.addEventListener('click', () => sendClick(item)); menu.appendChild(el);
  });
  ipcRenderer.send('countdown:menu-ready:' + instId, { gen, w: menu.offsetWidth, h: menu.offsetHeight });
});
document.addEventListener('mousemove', (e) => { if (drag) drag.setFromX(e.clientX, false); });
document.addEventListener('mouseup', (e) => { if (drag) { drag.setFromX(e.clientX, true); drag = null; } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ipcRenderer.send('countdown:menu-close:' + instId); });
