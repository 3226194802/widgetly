// 番茄设置窗口 —— 时长 + 选项
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'pomodoro-1';

let settings = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4, autoNext: false, sound: true };

function buildOpts(containerId, values, unit, current, onPick) {
  const c = document.getElementById(containerId);
  c.innerHTML = '';
  values.forEach((v) => {
    const b = document.createElement('button');
    b.className = 'opt' + (v === current ? ' sel' : '');
    b.textContent = v === 0 ? '关闭' : (v + ' ' + unit);
    b.style.width = 'auto';
    b.style.padding = '4px 9px';
    b.addEventListener('click', () => { onPick(v); refresh(); });
    c.appendChild(b);
  });
}
function refresh() {
  document.querySelectorAll('#focusOpts .opt').forEach((b) => b.classList.toggle('sel', parseInt(b.textContent, 10) === settings.focusMin));
  document.querySelectorAll('#shortOpts .opt').forEach((b) => b.classList.toggle('sel', parseInt(b.textContent, 10) === settings.shortBreakMin));
  document.querySelectorAll('#longOpts .opt').forEach((b) => b.classList.toggle('sel', parseInt(b.textContent, 10) === settings.longBreakMin));
  document.querySelectorAll('#everyOpts .opt').forEach((b) => {
    const v = b.textContent === '关闭' ? 0 : parseInt(b.textContent, 10);
    b.classList.toggle('sel', v === settings.longBreakEvery);
  });
  document.getElementById('autoNext').classList.toggle('sel', settings.autoNext);
  document.getElementById('soundOpt').classList.toggle('sel', settings.sound);
}
function send(patch) {
  settings = { ...settings, ...patch };
  ipcRenderer.send('pomodoro:settings:' + instId, patch);
  refresh();
}

buildOpts('focusOpts', [15, 20, 25, 30, 45, 50, 60], '分', settings.focusMin, (v) => send({ focusMin: v }));
buildOpts('shortOpts', [3, 5, 10], '分', settings.shortBreakMin, (v) => send({ shortBreakMin: v }));
buildOpts('longOpts', [10, 15, 20], '分', settings.longBreakMin, (v) => send({ longBreakMin: v }));
buildOpts('everyOpts', [2, 4, 0], '轮', settings.longBreakEvery, (v) => send({ longBreakEvery: v }));

document.getElementById('autoNext').addEventListener('click', () => send({ autoNext: !settings.autoNext }));
document.getElementById('soundOpt').addEventListener('click', () => send({ sound: !settings.sound }));
document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('pomodoro:settings-close:' + instId));
document.getElementById('doneBtn').addEventListener('click', () => ipcRenderer.send('pomodoro:settings-close:' + instId));

(async () => {
  try {
    const s = await ipcRenderer.invoke('pomodoro:settings-init:' + instId);
    if (s) settings = { ...settings, ...s };
  } catch (_) {}
  buildOpts('focusOpts', [15, 20, 25, 30, 45, 50, 60], '分', settings.focusMin, (v) => send({ focusMin: v }));
  buildOpts('shortOpts', [3, 5, 10], '分', settings.shortBreakMin, (v) => send({ shortBreakMin: v }));
  buildOpts('longOpts', [10, 15, 20], '分', settings.longBreakMin, (v) => send({ longBreakMin: v }));
  buildOpts('everyOpts', [2, 4, 0], '轮', settings.longBreakEvery, (v) => send({ longBreakEvery: v }));
  refresh();
})();
