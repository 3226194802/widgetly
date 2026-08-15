// 番茄时钟·中长条 —— 渲染进程：左 3/5 事项 + 右 2/5 计时（与方型共用主进程状态机）
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'pomodoroBar-1';
const $ = (id) => document.getElementById(id);

let tasks = [], settings = {}, today = { count: 0 };
let locked = false, selectedTaskId = null, curTaskId = null;
let phase = 'idle', running = false, remainMs = 0, totalMs = 25 * 60000;

function fmtMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// ---------- 状态渲染 ----------
function renderState(data) {
  if (!data) return;
  tasks = data.tasks || [];
  settings = data.settings || {};
  today = data.today || { count: 0 };
  locked = !!data.locked;
  selectedTaskId = data.selectedTaskId || null;
  if (typeof data.bgOpacity === 'number') applyOpacity(data.bgOpacity);
  const st = data.state || {};
  phase = st.phase || 'idle';
  running = !!st.running;
  remainMs = typeof st.remain === 'number' ? st.remain : 0;
  totalMs = st.totalMs || (phase === 'focus' ? settings.focusMin * 60000 : (phase === 'break' ? settings.shortBreakMin * 60000 : remainMs));
  if (st.taskId) curTaskId = st.taskId;

  document.body.dataset.phase = phase;
  document.body.dataset.running = running ? '1' : '0';
  renderList();
  renderTimer();
}

function renderList() {
  const list = $('taskList');
  list.innerHTML = '';
  if (tasks.length === 0) {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:10px;color:var(--text-3);padding:10px 4px;text-align:center;';
    e.textContent = '右键菜单添加事项';
    list.appendChild(e);
    return;
  }
  // 计时中高亮运行任务，否则高亮选中任务
  const activeId = phase !== 'idle' ? curTaskId : selectedTaskId;
  tasks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'bar-row' + (t.done ? ' done' : '') + (t.id === activeId ? ' sel' : '');
    row.dataset.id = t.id;
    const ck = document.createElement('span');
    ck.className = 'bar-ck'; ck.textContent = '✓';
    const txt = document.createElement('span');
    txt.className = 'bar-txt'; txt.textContent = t.text;
    const cnt = document.createElement('span');
    cnt.className = 'bar-cnt'; cnt.textContent = '🍅' + (t.count || 0);
    const play = document.createElement('button');
    play.className = 'bar-play'; play.title = '开始专注';
    play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.4 5.3c0-.9 1-1.45 1.76-.9l8.6 6.05c.68.48.68 1.52 0 2l-8.6 6.05c-.75.55-1.76 0-1.76-.9z"/></svg>';
    row.append(ck, txt, cnt, play);
    list.appendChild(row);
  });
}

function renderTimer() {
  const task = tasks.find(t => t.id === curTaskId);
  const phaseText = phase === 'focus' ? (running ? '专注中' : '已暂停') : phase === 'break' ? (running ? '休息中' : '已暂停') : '待机';
  $('brPhase').textContent = phaseText;
  $('brPhase').style.color = phase === 'idle' ? '' : 'var(--ring-a)';
  $('brDigits').textContent = phase === 'idle' ? fmtMMSS(settings.focusMin * 60000) : fmtMMSS(remainMs);
  $('brTask').textContent = task ? task.text : '—';
  $('brFill').style.width = phase === 'idle' ? '0%' : (totalMs > 0 ? (remainMs / totalMs * 100).toFixed(1) + '%' : '0%');
  $('btnSkip').hidden = phase !== 'break';
  // 番茄色圆圈只在「计时运行中」出现（暂停/待机保持中性）
  $('btnPause').classList.toggle('active', running);
  paintPauseIcon();
}

function paintPauseIcon() {
  const svgPause = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.4" y="5.4" width="3.6" height="13.2" rx="1.2"/><rect x="14" y="5.4" width="3.6" height="13.2" rx="1.2"/></svg>';
  const svgPlay = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.4 5.3c0-.9 1-1.45 1.76-.9l8.6 6.05c.68.48.68 1.52 0 2l-8.6 6.05c-.75.55-1.76 0-1.76-.9z"/></svg>';
  const el = $('btnPause');
  if (phase === 'idle') el.innerHTML = svgPlay;
  else if (running) el.innerHTML = svgPause;
  else el.innerHTML = svgPlay;
  el.title = phase === 'idle' ? '开始专注（先点选事项）' : (running ? '暂停' : '继续');
}

// ---------- 事件：列表 ----------
$('taskList').addEventListener('click', (e) => {
  const row = e.target.closest('.bar-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.bar-play')) {
    ipcRenderer.send('pomodoro:action:' + instId, { type: 'start', taskId: id });
    return;
  }
  if (e.target.closest('.bar-ck')) {
    ipcRenderer.send('pomodoro:action:' + instId, { type: 'toggleDone', taskId: id });
    return;
  }
  curTaskId = id;
  ipcRenderer.send('pomodoro:action:' + instId, { type: 'select', taskId: id });
});
$('taskList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.bar-row');
  if (row) ipcRenderer.send('pomodoro:action:' + instId, { type: 'select', taskId: row.dataset.id });
});

// ---------- 事件：计时按钮 ----------
$('btnPause').addEventListener('click', () => {
  if (phase === 'idle') {
    // 未选中时自动从第一个未完成事项开始（避免点了没反应）
    let t = tasks.find(x => x.id === selectedTaskId);
    if (!t) t = tasks.find(x => !x.done);
    if (t) ipcRenderer.send('pomodoro:action:' + instId, { type: 'start', taskId: t.id });
  } else {
    ipcRenderer.send('pomodoro:action:' + instId, { type: running ? 'pause' : 'resume' });
  }
});
$('btnReset').addEventListener('click', () => ipcRenderer.send('pomodoro:action:' + instId, { type: 'reset' }));
$('btnSkip').addEventListener('click', () => ipcRenderer.send('pomodoro:action:' + instId, { type: 'skip' }));

// ---------- 数据订阅 ----------
ipcRenderer.on('pomodoro:state:' + instId, (_e, d) => renderState(d));
ipcRenderer.on('pomodoro:tick:' + instId, (_e, d) => {
  if (!d) return;
  remainMs = d.remain;
  if (d.total) totalMs = d.total;
  if (phase !== d.phase) { phase = d.phase; document.body.dataset.phase = phase; }
  renderTimer();
});

// ---------- 提示音（与方型一致） ----------
let actx = null;
ipcRenderer.on('pomodoro:bell:' + instId, (_e, type) => {
  try {
    actx = actx || new AudioContext();
    const seq = type === 'focus' ? [880, 1174.66] : [659.25, 880];
    const t0 = actx.currentTime + 0.05;
    seq.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(actx.destination);
      const ts = t0 + i * 0.38;
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.exponentialRampToValueAtTime(0.28, ts + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.5);
      o.start(ts); o.stop(ts + 0.55);
    });
  } catch (_) {}
});

// ---------- 拖动：空白/标题拖，行与按钮不拖（锁定禁拖） ----------
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (locked) return;
  if (e.target.closest && e.target.closest('.bar-row, .bar-play, .bar-ck, .br-btn, #opPanel')) return;
  ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));

// ---------- 右键菜单 ----------
document.addEventListener('contextmenu', (e) => {
  ipcRenderer.send('activate');
  e.preventDefault();
  ipcRenderer.send('pomodoro:menu:' + instId);
});

// ---------- 背景透明度（自绘滑块，与方型一致） ----------
const veilEl = document.getElementById('veil');
let veilVal = 45;
function applyOpacity(alpha) {
  veilVal = Math.round((1 - alpha) * 100);
  veilEl.style.opacity = String(alpha);
  paintPanel();
}
const panel = $('opPanel');
const slider = $('opSlider');
const opFill = $('opFill');
const opThumb = $('opThumb');
const opVal = $('opVal');
let hideTimer = null;
function paintPanel() {
  opFill.style.width = veilVal + '%';
  opThumb.style.left = veilVal + '%';
  opVal.textContent = veilVal + '%';
}
function setFromX(clientX) {
  const r = slider.getBoundingClientRect();
  if (!r.width) return;
  veilVal = Math.max(0, Math.min(100, Math.round((clientX - r.left) / r.width * 100)));
  veilEl.style.opacity = String(1 - veilVal / 100);
  paintPanel();
}
function showPanel() {
  paintPanel();
  panel.hidden = false;
  scheduleHide();
}
function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { panel.hidden = true; }, 2200);
}
ipcRenderer.on('show-opacity-panel:' + instId, showPanel);
let opDragging = false;
slider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  opDragging = true;
  if (hideTimer) clearTimeout(hideTimer);
  setFromX(e.clientX);
});
document.addEventListener('mousemove', (e) => { if (opDragging) setFromX(e.clientX); });
document.addEventListener('mouseup', () => {
  if (!opDragging) return;
  opDragging = false;
  ipcRenderer.send('save-bg-opacity:' + instId, (100 - veilVal) / 100);
  scheduleHide();
});
document.addEventListener('mousedown', (e) => {
  if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
});

ipcRenderer.send('activate');

// 预览模式（管理器内 iframe 无主进程推送）：展示默认示例任务
if (instId === 'preview') {
  renderState({
    tasks: [
      { id: 'p1', text: '写周报', done: false, count: 2 },
      { id: 'p2', text: '整理代码', done: false, count: 1 },
      { id: 'p3', text: '晨间阅读', done: true, count: 0 },
    ],
    settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4 },
    today: { count: 3 },
    locked: false,
    selectedTaskId: null,
    bgOpacity: 0.55,
    state: { phase: 'idle', running: false, round: 0, taskId: null, remain: 0 },
  });
}
