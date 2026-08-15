// 平台选择窗口 —— 列出主流 Agent 平台 + 安装检测状态
const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'monitor-1';

const list = document.getElementById('list');

function render(data) {
  list.innerHTML = '';
  if (!data || !data.agents) return;
  (data.agents || []).forEach((a) => {
    const row = document.createElement('div');
    row.className = 'row' + (a.id === data.active ? ' active' : '');
    row.dataset.id = a.id;

    const ico = document.createElement('span');
    ico.className = 'ico'; ico.textContent = a.icon || '🤖';
    const mid = document.createElement('span');
    mid.className = 'mid';
    const nm = document.createElement('div');
    nm.className = 'nm'; nm.textContent = a.name;
    const dt = document.createElement('div');
    dt.className = 'dt';
    dt.textContent = a.detect && a.detect.found ? (a.detect.detail || '已安装') : (a.detect && a.detect.hint ? a.detect.hint : '未安装');
    mid.append(nm, dt);
    row.title = dt.textContent;   // 悬停显示完整路径/提示
    const st = document.createElement('span');
    st.className = 'st';
    if (a.id === data.active) { st.className = 'st cur'; st.textContent = '当前'; }
    else if (a.detect && a.detect.found) { st.className = 'st ok'; st.textContent = '已安装'; }
    else { st.className = 'st no'; st.textContent = '未找到'; }

    row.append(ico, mid, st);
    row.addEventListener('click', () => {
      ipcRenderer.send('monitor:platform:' + instId, a.id);
      ipcRenderer.send('monitor:platform-close:' + instId);
    });
    list.appendChild(row);
  });
}

document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('monitor:platform-close:' + instId));

(async () => {
  try {
    const data = await ipcRenderer.invoke('monitor:platform-list:' + instId);
    render(data);
  } catch (_) {}
})();
