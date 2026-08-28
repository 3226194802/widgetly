const { ipcRenderer } = require('electron');
const params = new URLSearchParams(location.search);
const dockId = params.get('inst') || '';
const content = document.getElementById('content');
const names = {
  plannerCalendar: '桌面待办大日历', quadrantTasks: '四象限清单', miniCalendarGlass: '桌面小日历', flipClock: '翻页时钟',
  cycleCountdown: '周期倒数日', desktopFolder: '桌面文件夹', analogClock: '圆盘时钟', digitalClockGlass: '桌面时钟日历·精简',
  stickyNote: '桌面便签', lineWeather: '桌面折线天气', desktopSchedule: '桌面日程', markdownNote: '桌面笔记',
  desktopCounter: '桌面计数器', classSchedule: '桌面课程表', progressTracker: '桌面进度条', simplePomodoro: '简约番茄时钟',
  clockCalendar: '桌面时钟日历·完整', durationTimer: '倒计时工具', alarmClock: '闹钟',
};
let model = null;
function esc(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function clamp(v, min, max, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function nameOf(child) { return child.name || names[child.widgetId] || child.widgetId; }
async function command(payload) {
  const result = await ipcRenderer.invoke('componentDock:command:' + dockId, payload);
  if (result && result.message) flash(result.message);
  await load();
}
let flashTimer;
function flash(text) {
  let node = document.getElementById('flash');
  if (!node) { node = document.createElement('div'); node.id = 'flash'; document.body.appendChild(node); }
  node.textContent = text; node.classList.add('show'); clearTimeout(flashTimer); flashTimer = setTimeout(() => node.classList.remove('show'), 1800);
}
function layoutButton(value, current, label, hint) {
  return `<button class="layout-card ${current === value ? 'active' : ''}" data-layout="${value}"><b>${label}</b><span>${hint}</span></button>`;
}
function render() {
  const dock = model && model.dock || { config: {} };
  const cfg = dock.config || {};
  const children = Array.isArray(model && model.children) ? model.children : [];
  const available = Array.isArray(model && model.available) ? model.available : [];
  const supported = Array.isArray(model && model.supported) ? model.supported : [];
  const transparency = clamp(cfg.backgroundTransparency, 0, 100, 80);
  content.innerHTML = `
    <section class="panel overview">
      <div><span class="eyebrow">融合容器</span><h2>${esc(dock.name || '组件坞')}</h2><p>${children.length} 个子组件 · 可在桌面直接拖动和缩放 · 整体状态由组件坞统一管理</p></div>
      <div class="overview-actions"><button class="outline" data-action="reflow">自动整理空白</button><button class="outline" data-action="dissolve">解散组件坞</button><button class="danger" data-action="delete">删除组件坞</button></div>
    </section>
    <section class="panel">
      <div class="section-title"><div><span class="eyebrow">布局</span><h3>组件如何一起显示</h3></div><span class="muted">缩放时会重新排版，不会把内容当图片拉伸</span></div>
      <div class="layout-grid">
        ${layoutButton('free', cfg.layout || 'free', '自由编排', '保留你在桌面上拖出的每个位置和大小')}
        ${layoutButton('smart', cfg.layout, '智能排列', '自动消除空白，按内容和外框比例重排')}
        ${layoutButton('horizontal', cfg.layout, '横向分栏', '适合时钟 + 日历或天气')}
        ${layoutButton('vertical', cfg.layout, '纵向分栏', '适合日程、倒计时和便签')}
        ${layoutButton('grid', cfg.layout, '2 × 2 网格', '适合四个信息组件')}
        ${layoutButton('pages', cfg.layout, '分页切换', '一页最多显示六个组件')}
      </div>
      <div class="range-grid">
        <label><span>组件坞背景透明度 <b id="transparencyValue">${transparency}%</b></span><input type="range" min="0" max="100" value="${transparency}" data-range="backgroundTransparency"></label>
        <label><span>组件间距 <b id="gapValue">${clamp(cfg.gap, 0, 30, 10)} px</b></span><input type="range" min="0" max="30" value="${clamp(cfg.gap, 0, 30, 10)}" data-range="gap"></label>
        <label><span>四周留白 <b id="paddingValue">${clamp(cfg.padding, 0, 42, 10)} px</b></span><input type="range" min="0" max="42" value="${clamp(cfg.padding, 0, 42, 10)}" data-range="padding"></label>
        <label><span>视觉风格</span><select data-select="style"><option value="unified" ${cfg.style !== 'flat' ? 'selected' : ''}>统一玻璃背景</option><option value="flat" ${cfg.style === 'flat' ? 'selected' : ''}>简约平面背景</option></select></label>
      </div>
    </section>
    <section class="panel">
      <div class="section-title"><div><span class="eyebrow">坞内组件</span><h3>独立设置、排序或移出</h3></div><span class="muted">桌面中悬停子组件可拖动；右下角可调整单个组件大小</span></div>
      <div class="child-list">${children.length ? children.map((child, index) => `
        <article class="child-row ${child.hidden ? 'hidden-row' : ''}">
          <span class="order">${index + 1}</span><div class="child-icon">${esc(child.icon || '◫')}</div>
          <div class="child-copy"><strong>${esc(nameOf(child))}</strong><span>${child.surface === 'card' ? '显示独立卡片背景' : '融入组件坞统一背景'}</span></div>
          <div class="row-actions">
            <button title="上移" data-action="move" data-id="${esc(child.id)}" data-by="-1">↑</button>
            <button title="下移" data-action="move" data-id="${esc(child.id)}" data-by="1">↓</button>
            <button class="wide" data-action="child-settings" data-id="${esc(child.id)}">设置</button>
            <button class="wide" data-action="surface" data-id="${esc(child.id)}">${child.surface === 'card' ? '融入背景' : '独立背景'}</button>
            <button title="移出组件坞" data-action="detach" data-id="${esc(child.id)}">↗</button>
            <button class="remove" title="从组件坞删除" data-action="remove" data-id="${esc(child.id)}">×</button>
          </div>
        </article>`).join('') : '<div class="empty-state">还没有加入组件。可从下方添加新组件，或把已有桌面组件放进这个组件坞。</div>'}</div>
    </section>
    <section class="panel add-panel">
      <div class="section-title"><div><span class="eyebrow">添加</span><h3>放入新的组件</h3></div><span class="muted">首版支持所有 Studio 响应式组件</span></div>
      <div class="add-grid">${supported.map((item) => `<button class="add-card" data-action="add" data-widget="${esc(item.id)}"><span>${esc(item.icon || '◫')}</span><b>${esc(item.name)}</b><small>${item.w} × ${item.h}</small></button>`).join('')}</div>
      ${available.length ? `<div class="existing-head">已有桌面组件</div><div class="existing-list">${available.map((item) => `<button class="existing" data-action="attach" data-id="${esc(item.id)}"><span>${esc(item.icon || '◫')}</span><b>${esc(item.name || names[item.widgetId] || item.widgetId)}</b><small>加入组件坞</small></button>`).join('')}</div>` : ''}
    </section>`;
}
async function load() {
  try { model = await ipcRenderer.invoke('componentDock:get:' + dockId); render(); } catch (_) { content.innerHTML = '<div class="loading">无法读取组件坞，请关闭后重试。</div>'; }
}
content.addEventListener('click', (event) => {
  const layout = event.target.closest('[data-layout]');
  if (layout) return command({ action: 'layout', layout: layout.dataset.layout });
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'delete' && !confirm('删除组件坞及其所有子组件？此操作会删除子组件的数据。')) return;
  if (action === 'remove' && !confirm('从组件坞删除此组件？其数据也会删除。')) return;
  command({ action, childId: button.dataset.id, widgetId: button.dataset.widget, by: Number(button.dataset.by) || 0 });
});
content.addEventListener('input', (event) => {
  const input = event.target.closest('[data-range]');
  if (!input) return;
  const value = Number(input.value);
  const target = document.getElementById(input.dataset.range + 'Value'); if (target) target.textContent = input.dataset.range === 'backgroundTransparency' ? `${value}%` : `${value} px`;
});
content.addEventListener('change', (event) => {
  const range = event.target.closest('[data-range]');
  if (range) return command({ action: 'set', key: range.dataset.range, value: Number(range.value) });
  const select = event.target.closest('[data-select]');
  if (select) command({ action: 'set', key: select.dataset.select, value: select.value });
});
document.getElementById('close').addEventListener('click', () => window.close());
ipcRenderer.on('componentDock:changed:' + dockId, load);
load();
