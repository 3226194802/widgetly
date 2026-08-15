// 番茄时钟组件 —— 渲染进程：列表/计时双视图 + 悬停浮现按钮 + 鼠标穿透悬停恢复 + 提示音
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'pomodoro-1';
const $ = (id) => document.getElementById(id);

let tasks = [], settings = {}, today = { count: 0 };
let locked = false, selectedTaskId = null;
let phase = 'idle', running = false, remainMs = 0;

const CIRC = 2 * Math.PI * 70;
// ---------- 格式化 ----------
function fmtMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// ---------- 视图 ----------
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

  document.body.dataset.phase = phase;
  document.body.dataset.running = running ? '1' : '0';
  $('todayBadge').textContent = '今日 ' + (today.count || 0) + ' 🍅';

  const inTimer = phase !== 'idle';
  $('listView').style.display = inTimer ? 'none' : '';
  $('footer').style.display = inTimer ? 'none' : '';
  $('timerView').hidden = !inTimer;

  if (inTimer) renderTimer(st);
  else renderList();
}

function renderList() {
  const list = $('taskList');
  list.innerHTML = '';
  const doneCount = tasks.filter(t => t.done).length;
  $('footText').textContent = tasks.length
    ? `已完成 ${doneCount} 个事项 · 今日 ${today.count || 0} 个番茄`
    : '右键菜单添加事项 · 悬停显示计时按钮';

  if (tasks.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '暂无事项，右键菜单「添加事项…」';
    list.appendChild(e);
    return;
  }
  tasks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'row' + (t.done ? ' done' : '') + (t.id === selectedTaskId ? ' sel' : '');
    row.dataset.id = t.id;

    const ck = document.createElement('span');
    ck.className = 'ck';
    ck.textContent = '✓';

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = t.text;

    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = '🍅×' + (t.count || 0);

    const play = document.createElement('button');
    play.className = 'play';
    play.title = '开始专注';
    play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.4 5.3c0-.9 1-1.45 1.76-.9l8.6 6.05c.68.48.68 1.52 0 2l-8.6 6.05c-.75.55-1.76 0-1.76-.9z"/></svg>';

    row.append(ck, txt, cnt, play);
    list.appendChild(row);
  });
}

function renderTimer(st) {
  const task = tasks.find(t => t.id === st.taskId);
  $('taskName').textContent = task ? task.text : '—';
  const phaseText = phase === 'focus' ? (running ? '专注中' : '已暂停') : (running ? '休息中' : '已暂停');
  $('roundInfo').textContent = phaseText + ' · 已完成 ' + ((st.round || 0)) + ' 轮';
  $('btnSkip').hidden = phase !== 'break';
  paintTimer(remainMs, st.totalMs || (phase === 'focus' ? settings.focusMin * 60000 : remainMs));
  paintPauseIcon();
}

function paintTimer(remain, total) {
  $('digits').textContent = fmtMMSS(remain);
  const ratio = total > 0 ? Math.min(1, remain / total) : 0;
  const fg = $('ringFg');
  fg.style.strokeDasharray = CIRC;
  fg.style.strokeDashoffset = CIRC * (1 - ratio);
}
function paintPauseIcon() {
  $('btnPause').innerHTML = running
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.4" y="5.4" width="3.6" height="13.2" rx="1.2"/><rect x="14" y="5.4" width="3.6" height="13.2" rx="1.2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.4 5.3c0-.9 1-1.45 1.76-.9l8.6 6.05c.68.48.68 1.52 0 2l-8.6 6.05c-.75.55-1.76 0-1.76-.9z"/></svg>';
}

// ---------- 事件委托：列表 ----------
$('taskList').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.play')) {
    ipcRenderer.send('pomodoro:action:' + instId, { type: 'start', taskId: id });
    return;
  }
  if (e.target.closest('.ck')) {
    ipcRenderer.send('pomodoro:action:' + instId, { type: 'toggleDone', taskId: id });
    return;
  }
  ipcRenderer.send('pomodoro:action:' + instId, { type: 'select', taskId: id });
});
// 右键列表行 = 选中 + 弹菜单
$('taskList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (row) ipcRenderer.send('pomodoro:action:' + instId, { type: 'select', taskId: row.dataset.id });
});

// ---------- 计时视图按钮 ----------
$('btnPause').addEventListener('click', () => {
  ipcRenderer.send('pomodoro:action:' + instId, { type: running ? 'pause' : 'resume' });
});
$('btnReset').addEventListener('click', () => ipcRenderer.send('pomodoro:action:' + instId, { type: 'reset' }));
$('btnSkip').addEventListener('click', () => ipcRenderer.send('pomodoro:action:' + instId, { type: 'skip' }));

// ---------- 数据订阅 ----------
ipcRenderer.on('pomodoro:state:' + instId, (_e, d) => renderState(d));
ipcRenderer.on('pomodoro:tick:' + instId, (_e, d) => {
  if (!d) return;
  remainMs = d.remain;
  if (phase !== d.phase) { phase = d.phase; document.body.dataset.phase = phase; }
  if (phase !== 'idle') paintTimer(remainMs, d.total || remainMs);
});

// ---------- 提示音（WebAudio 双音钟声，无外部文件） ----------
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

// ---------- 拖动：顶栏/空白拖动；行与按钮不拖（锁定禁拖） ----------
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (locked) return;
  if (e.target.closest && e.target.closest('.row, .play, .ck, .cbtn, .txt, #opPanel')) return;
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

// ---------- 初始化 ----------
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

// ---------- 背景透明度（自绘滑块：0%=罩层全不透明纯色，100%=罩层全透明只剩实时毛玻璃） ----------
const veilEl = document.getElementById('veil');
let veilVal = 45;
function applyOpacity(alpha) {
  // alpha = bgOpacity = 罩层不透明度（0=全透明，1=纯色）
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
