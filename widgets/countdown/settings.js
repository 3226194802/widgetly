const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'countdown-1';
const list = document.getElementById('targetList');
const selectGrid = document.getElementById('selectGrid');
const statusEl = document.getElementById('status');
let state = { variant: 'single', targets: [], activeId: '', slotIds: ['', '', ''] };

function pad(n) { return String(n).padStart(2, '0'); }
function futureDate(days) { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function id() { return `date-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
const COLORS = ['#319fe8', '#ff9f2e', '#8b74e8', '#27b58a', '#ef6d86', '#576de8'];

function renderTargets() {
  list.innerHTML = '';
  if (!state.targets.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '还没有目标日期，点击右上角“添加目标”开始设置。'; list.appendChild(empty);
  }
  state.targets.forEach((target, index) => {
    const row = document.createElement('div'); row.className = 'target'; row.dataset.id = target.id;
    const color = document.createElement('input'); color.type = 'color'; color.value = target.color || COLORS[index % COLORS.length]; color.title = '目标颜色';
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 36; name.placeholder = '目标名称'; name.value = target.name || '';
    const date = document.createElement('input'); date.type = 'date'; date.value = target.date || '';
    const del = document.createElement('button'); del.type = 'button'; del.className = 'delete'; del.title = '删除'; del.textContent = '×';
    color.addEventListener('input', () => { target.color = color.value; });
    name.addEventListener('input', () => { target.name = name.value; });
    date.addEventListener('input', () => { target.date = date.value; });
    del.addEventListener('click', () => { state.targets = state.targets.filter((t) => t.id !== target.id); renderTargets(); renderSelectors(); });
    row.append(color, name, date, del); list.appendChild(row);
  });
}
function options(select, selected) {
  select.innerHTML = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = state.targets.length ? '请选择目标' : '请先添加目标'; select.appendChild(none);
  state.targets.forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = `${t.name || '未命名'} · ${t.date || '未设置日期'}`; select.appendChild(o); });
  select.value = state.targets.some((t) => t.id === selected) ? selected : '';
}
function selector(labelText, selected, onChange) {
  const label = document.createElement('label'); const span = document.createElement('span'); span.textContent = labelText;
  const select = document.createElement('select'); options(select, selected); select.addEventListener('change', () => onChange(select.value));
  label.append(span, select); return label;
}
function renderSelectors() {
  selectGrid.innerHTML = '';
  if (state.variant === 'single') {
    document.getElementById('chooseTitle').textContent = '单目标组件当前显示'; selectGrid.className = 'select-grid single';
    selectGrid.appendChild(selector('显示目标', state.activeId, (v) => { state.activeId = v; }));
  } else {
    document.getElementById('chooseTitle').textContent = '三目标组件的三个位置'; selectGrid.className = 'select-grid';
    for (let i = 0; i < 3; i++) selectGrid.appendChild(selector(`第 ${i + 1} 行`, state.slotIds[i] || '', (v) => { state.slotIds[i] = v; }));
  }
}
document.getElementById('addBtn').addEventListener('click', () => {
  const index = state.targets.length;
  state.targets.push({ id: id(), name: index ? `目标 ${index + 1}` : '我的目标', date: futureDate(30), color: COLORS[index % COLORS.length] });
  renderTargets(); renderSelectors();
  requestAnimationFrame(() => { const rows = list.querySelectorAll('.target'); const input = rows[rows.length - 1] && rows[rows.length - 1].querySelector('input[type="text"]'); if (input) { input.focus(); input.select(); } });
});
document.getElementById('saveBtn').addEventListener('click', async () => {
  const invalid = state.targets.find((t) => !String(t.name || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.date || '')));
  if (invalid) { statusEl.textContent = '请为每个目标填写名称和有效日期'; statusEl.style.color = '#d14650'; return; }
  statusEl.textContent = '正在保存…'; statusEl.style.color = '#718097';
  try {
    const result = await ipcRenderer.invoke('countdown:settings-save:' + instId, { targets: state.targets, activeId: state.activeId, slotIds: state.slotIds });
    if (!result || !result.ok) throw new Error('save failed');
    state = result.state; renderTargets(); renderSelectors();
    statusEl.textContent = `已保存 ${result.count} 个目标日期，并同步到全部倒数日组件`;
    statusEl.style.color = '#25865f';
  } catch (_) { statusEl.textContent = '保存失败，请稍后重试'; statusEl.style.color = '#d14650'; }
});
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('countdown:settings-close:' + instId));
(async () => {
  try { const s = await ipcRenderer.invoke('countdown:settings-init:' + instId); if (s) state = s; } catch (_) {}
  if (!Array.isArray(state.targets)) state.targets = [];
  if (!Array.isArray(state.slotIds)) state.slotIds = ['', '', ''];
  while (state.slotIds.length < 3) state.slotIds.push('');
  renderTargets(); renderSelectors();
})();
