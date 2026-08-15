// 时钟浮动右键菜单窗口 —— 渲染进程
// 支持普通项（label + 右侧状态）、分隔线、透明度滑杆行（拖动实时上报）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'clock-1';
const menuEl = document.getElementById('menu');
let gen = 0;
let sliderDrag = { on: false, moved: false, startX: 0, rect: null, value: 0 };

ipcRenderer.on('clock:menu-items:' + instId, (_e, data) => {
  if (!data) return;
  gen = data.gen || 0;
  menuEl.innerHTML = '';
  (data.items || []).forEach((it) => {
    if (it.kind === 'sep') {
      const s = document.createElement('div');
      s.className = 'sep';
      menuEl.appendChild(s);
    } else if (it.kind === 'slider') {
      sliderDrag.value = it.value || 0;
      const row = document.createElement('div');
      row.className = 'item slider-row';
      const label = document.createElement('span');
      label.textContent = it.label;
      const track = document.createElement('div');
      track.className = 'slider-track';
      const fill = document.createElement('div');
      fill.className = 'slider-fill';
      const thumb = document.createElement('div');
      thumb.className = 'slider-thumb';
      const val = document.createElement('span');
      val.className = 'slider-val';
      track.append(fill, thumb);
      row.append(label, track, val);
      const paint = () => {
        fill.style.width = sliderDrag.value + '%';
        thumb.style.left = sliderDrag.value + '%';
        val.textContent = sliderDrag.value + '%';
      };
      paint();
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        sliderDrag = { on: true, moved: false, startX: e.clientX, rect: track.getBoundingClientRect(), value: sliderDrag.value };
        setFromX(e.clientX);
      });
      const setFromX = (x) => {
        const r = sliderDrag.rect;
        if (!r || !r.width) return;
        sliderDrag.value = Math.max(0, Math.min(100, Math.round((x - r.left) / r.width * 100)));
        paint();
        ipcRenderer.send('clock:menu-slide:' + instId, { gen, v: sliderDrag.value, done: false });
      };
      document.addEventListener('mousemove', (e) => {
        if (!sliderDrag.on) return;
        if (!sliderDrag.moved && Math.abs(e.clientX - sliderDrag.startX) > 4) sliderDrag.moved = true;
        if (sliderDrag.moved) setFromX(e.clientX);
      });
      document.addEventListener('mouseup', () => {
        if (!sliderDrag.on) return;
        sliderDrag.on = false;
        if (sliderDrag.moved) ipcRenderer.send('clock:menu-slide:' + instId, { gen, v: sliderDrag.value, done: true });
      });
      menuEl.appendChild(row);
    } else {
      const el = document.createElement('div');
      el.className = 'item' + (it.danger ? ' danger' : '');
      const label = document.createElement('span');
      label.textContent = it.label;
      el.appendChild(label);
      if (it.state) {
        const st = document.createElement('span');
        st.className = 'st';
        st.textContent = it.state;
        el.appendChild(st);
      }
      el.addEventListener('click', () => {
        ipcRenderer.send('clock:menu-click:' + instId, { gen, action: it.action, payload: it.payload });
      });
      menuEl.appendChild(el);
    }
  });
  ipcRenderer.send('clock:menu-ready:' + instId, { gen, w: menuEl.offsetWidth, h: menuEl.offsetHeight });
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest || !e.target.closest('.item')) ipcRenderer.send('clock:menu-close:' + instId);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('clock:menu-close:' + instId);
});
