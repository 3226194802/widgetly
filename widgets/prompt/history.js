const { ipcRenderer } = require('electron');
const instId = new URLSearchParams(location.search).get('inst') || 'prompt-1';
const $ = (id) => document.getElementById(id);
function fmt(iso) { try { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch (_) { return ''; } }
function strengthText(v) { return ['轻度润色', '增强优化', '深度重构'][Math.max(1, Math.min(3, Number(v) || 1)) - 1]; }
function itemButton(text, cls, onClick) { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = text; b.addEventListener('click', onClick); return b; }
async function render() {
  const list = $('list'); list.innerHTML = '';
  let items = [];
  try { items = await ipcRenderer.invoke('prompt:history-get:' + instId); } catch (_) {}
  $('count').textContent = items.length ? `共 ${items.length} 条` : '';
  if (!items.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '还没有优化记录。\n生成提示词后会自动保存在这里。'; list.appendChild(e); return; }
  items.forEach((item) => {
    const row = document.createElement('article'); row.className = 'item';
    const meta = document.createElement('div'); meta.className = 'meta';
    const time = document.createElement('span'); time.textContent = fmt(item.time);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = strengthText(item.strength); meta.append(time, badge);
    const source = document.createElement('div'); source.className = 'source'; source.textContent = item.source || '（无原始内容）';
    const result = document.createElement('div'); result.className = 'result'; result.textContent = item.text || '（无优化结果）';
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(itemButton('继续使用', '', () => ipcRenderer.send('prompt:history-use:' + instId, item.id)), itemButton('删除', 'delete', () => ipcRenderer.send('prompt:history-delete:' + instId, item.id)));
    row.append(meta, source, result, actions); list.appendChild(row);
  });
}
$('closeBtn').addEventListener('click', () => ipcRenderer.send('prompt:history-close:' + instId));
$('clearBtn').addEventListener('click', () => { if (confirm('确定清空全部历史对话吗？')) ipcRenderer.send('prompt:history-clear:' + instId); });
ipcRenderer.on('prompt:history-changed:' + instId, render);
render();
