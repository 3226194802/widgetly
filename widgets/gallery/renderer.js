// 图库组件 —— 渲染进程
// 无缝交叉淡化轮播：双图层 + 预载，新图完全覆盖旧图后才撤旧图 → 全程无黑屏闪烁
const { ipcRenderer } = require('electron');

const instId = new URLSearchParams(location.search).get('inst') || 'gallery-1';

const imgA = document.getElementById('imgA');
const imgB = document.getElementById('imgB');
const placeholder = document.getElementById('placeholder');

let images = [];
let folder = null;
let duration = 5;        // 轮播时长（秒）
let order = 'random';    // random | sequence
let index = 0;
let timer = null;
let locked = false;
let started = false;

let cur = imgA;   // 当前可见层（底层）
let nxt = imgB;   // 待淡入层（顶层，新图淡入覆盖旧图）
const FADE_MS = 500;   // 交叉淡化时长（性能：软件合成下缩短过渡，降低合成峰值）

// 本地路径 → file:// URL（按路径段逐段编码：正确处理中文/空格/#/?，且保留盘符冒号）
function fileUrl(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  const enc = parts.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');
  return 'file:///' + enc;
}

function showPlaceholder() {
  placeholder.style.display = '';
  imgA.style.display = 'none';
  imgB.style.display = 'none';
}

function showImage(p) {
  if (!p) { showPlaceholder(); return; }
  imgA.style.display = 'block';
  imgB.style.display = 'block';

  if (!started) {
    // 首图：占位层保持可见直到图片真正就绪（避免透明窗口短暂空 surface）
    started = true;
    cur.onload = () => {
      cur.onload = null;
      placeholder.style.display = 'none';
      cur.classList.add('show');
    };
    cur.src = fileUrl(p);
    return;
  }
  // 后续：新图淡入覆盖旧图，旧图保持可见直到新图完全覆盖 → 全程无黑屏
  placeholder.style.display = 'none';
  nxt.classList.remove('show');
  nxt.style.zIndex = 2;
  cur.style.zIndex = 1;
  cur.classList.add('show');
  nxt.onload = () => {
    nxt.onload = null;
    nxt.classList.add('show');                 // 新图淡入
    setTimeout(() => {
      cur.classList.remove('show');            // 新图已覆盖，撤掉旧图
      cur.style.zIndex = 1;
      const t = cur; cur = nxt; nxt = t;        // 交换角色
    }, FADE_MS);
  };
  nxt.src = fileUrl(p);
}

function nextImage() {
  if (!images.length) return;
  if (order === 'random') {
    if (images.length === 1) { index = 0; }
    else { let n; do { n = Math.floor(Math.random() * images.length); } while (n === index); index = n; }
  } else {
    index = (index + 1) % images.length;
  }
  showImage(images[index]);
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(nextImage, Math.max(1, duration) * 1000);
}

function applyList(list) {
  images = list || [];
  if (images.length) {
    index = order === 'random' ? Math.floor(Math.random() * images.length) : 0;
    showImage(images[index]);
    startTimer();
  } else {
    if (timer) clearInterval(timer);
    showPlaceholder();
    placeholder.textContent = folder ? '该文件夹没有图片' : '右键设置图库文件夹';
  }
}

ipcRenderer.on('gallery:config:' + instId, (_e, cfg) => {
  if (!cfg) return;
  if (typeof cfg.duration === 'number' && cfg.duration > 0) duration = cfg.duration;
  if (cfg.order === 'random' || cfg.order === 'sequence') order = cfg.order;
  folder = cfg.folder || null;
  if (images.length) startTimer();
});
ipcRenderer.on('gallery:images:' + instId, (_e, list) => applyList(list));
ipcRenderer.on('lock:' + instId, (_e, on) => { locked = !!on; });

// ---------- 拖动（锁定禁拖） ----------
document.addEventListener('mousedown', (e) => {
  ipcRenderer.send('activate');
  if (e.button !== 0) return;
  if (!locked) ipcRenderer.send('drag-start');
});
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
window.addEventListener('blur', () => ipcRenderer.send('drag-end'));
document.addEventListener('contextmenu', () => ipcRenderer.send('activate'));

// ---------- 初始化 ----------
(async () => {
  try {
    const init = await ipcRenderer.invoke('gallery:init:' + instId);
    if (init) {
      folder = init.folder || null;
      duration = (typeof init.duration === 'number' && init.duration > 0) ? init.duration : 5;
      order = init.order === 'sequence' ? 'sequence' : 'random';
      locked = !!init.locked;
      applyList(init.images || []);
    }
  } catch (_) {
    // 管理器预览（inst=preview 无主进程推送）：展示示例图，避免组件坞里的图库预览黑屏
    if (instId === 'preview') applyList(['F:/A组件图片/19406238427730816.jpg']);
    else placeholder.textContent = '右键设置图库文件夹';
  }
})();
