// 渐变数字时钟（标准/小/中号）—— 渲染进程：配置、毛玻璃壁纸、时间渲染、主题、拖动
// 右键菜单 = 独立浮动菜单窗口（主进程管理）；透明度滑杆在菜单窗口内拖动，经主进程实时转发
const { ipcRenderer } = require('electron');

// 组件坞适配：从 URL query 获取本实例 id，配置通道按实例隔离
const instId = new URLSearchParams(location.search).get('inst') || 'clock-1';

// 事件日志（写入 widget-debug.log，排查用）
function evt(msg) { ipcRenderer.send('evt', msg); }

(async () => {
  // 预览模式（管理器内 iframe）无实例配置时使用默认值
  let cfg;
  try {
    cfg = await ipcRenderer.invoke('cfg:' + instId);
  } catch (_) {
    cfg = { width: 284, theme: 'auto', subtitle: 'iScreen', hour12: false, showSubtitle: true, veilOpacity: 80 };
  }
  const glass = document.getElementById('glass');
  const ampmEl = document.getElementById('ampm');
  const card = document.querySelector('.card');
  let forcedTheme = null;      // null = 跟随 config.theme
  let currentTimeText = '';

  // ---- 外观颜色（中号时钟专属）：左边数字填充色 + 右边数字描边色，默认白色 ----
  let hourColor = '#ffffff';
  let minuteColor = '#ffffff';
  function applyColors() {
    ['h1', 'h2'].forEach((id) => {
      const el = document.getElementById(id);
      el.style.webkitTextFillColor = hourColor;
      el.style.color = hourColor;
      el.style.backgroundImage = 'none';
    });
    ['m1', 'm2'].forEach((id) => {
      document.getElementById(id).style.webkitTextStrokeColor = minuteColor;
    });
  }

  // ---- 字号：小号 140 窗口 0.24；标准 280 窗口 0.30；中号 clockM 固定 92px（视觉高 92×1.3≈120px）----
  const winW = window.innerWidth;
  const wid = new URLSearchParams(location.search).get('wid');
  const isClockM = instId.startsWith('clockM-') || wid === 'clockM';   // 主页预览也按中号样式渲染
  const fs = isClockM ? 92 : Math.round(winW * (winW < 200 ? 0.24 : 0.30));
  document.documentElement.style.setProperty('--fs', fs + 'px');

  // 中号时钟（clockM 实例）使用 Montserrat Black 字体（CSS 里特调变换避免溢出）+ 外观颜色
  if (isClockM) {
    document.documentElement.classList.add('clockm-font');
    hourColor = cfg.hourColor || '#ffffff';
    minuteColor = cfg.minuteColor || '#ffffff';
    applyColors();
  }

  // ---- 外观：背景底色 + 四个数字独立颜色（可选，覆盖默认渐变；中号时钟仅用背景底色）----
  let bgColor = cfg.bgColor || null;
  let digitColors = { ...(cfg.digitColors || {}) };
  const veilEl = document.querySelector('.veil');
  function applyBgColor() {
    veilEl.style.background = bgColor || '';   // 空串恢复 CSS 默认主题渐变
  }
  function applyDigitColors() {
    ['h1', 'h2', 'm1', 'm2'].forEach((id) => {
      const el = document.getElementById(id);
      const c = digitColors[id];
      if (c) {
        el.style.backgroundImage = 'none';
        el.style.webkitTextFillColor = c;
        el.style.color = c;
        el.style.webkitTextStrokeColor = c;
        el.style.mixBlendMode = 'normal';
      } else {
        el.style.backgroundImage = '';
        el.style.webkitTextFillColor = '';
        el.style.color = '';
        el.style.webkitTextStrokeColor = '';
        el.style.mixBlendMode = '';
      }
    });
  }
  applyBgColor();
  if (!isClockM) applyDigitColors();

  // ---- 主题（auto 跟随系统 / light / dark）----
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = forcedTheme || (cfg.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : cfg.theme);
    document.documentElement.dataset.theme = t;
    return t;
  }
  applyTheme();
  mq.addEventListener('change', () => { if (!forcedTheme && cfg.theme === 'auto') applyTheme(); });

  // ---- 背景透明度（0-100，浮动菜单滑杆调节；值=透明度：100=完全透明、0=完全不透明）----
  let veilVal = (typeof cfg.veilOpacity === 'number' && cfg.veilOpacity >= 0 && cfg.veilOpacity <= 100) ? cfg.veilOpacity : 32;
  function paintVeil() {
    document.documentElement.style.setProperty('--veil-opacity', String((100 - veilVal) / 100));
  }
  paintVeil();

  // ---- 渐变交替顺序：abab=逐位交替，aabb=小时一组/分钟一组 ----
  if (cfg.gradientOrder === 'aabb') {
    document.getElementById('h1').className = 'digit d-a';
    document.getElementById('h2').className = 'digit d-a';
    document.getElementById('m1').className = 'digit d-b';
    document.getElementById('m2').className = 'digit d-b';
  }

  // ---- 毛玻璃：壁纸模糊层只铺在卡片内（卡片外透明，窗口矩形不可见）----
  function applyWallpaper(wp) {
    if (!wp || !cfg.glass) { glass.style.display = 'none'; return; }
    const bg = `url(${wp.dataUrl})`;
    const size = `${wp.w}px ${wp.h}px`;
    const pos = `${wp.posX}px ${wp.posY}px`;
    glass.style.backgroundImage = bg;
    glass.style.backgroundSize = size;
    glass.style.backgroundPosition = pos;
  }
  applyWallpaper(await ipcRenderer.invoke('wallpaper'));
  ipcRenderer.on('wallpaper', (e, wp) => applyWallpaper(wp));
  // 拖动中实时更新壁纸位置（只发坐标，轻量）
  ipcRenderer.on('wallpaper-pos', (e, p) => {
    if (p && cfg.glass) glass.style.backgroundPosition = `${p.posX}px ${p.posY}px`;
  });

  // ---- 时间：12/24 小时制，分钟变化才更新 DOM ----
  const ids = ['h1', 'h2', 'm1', 'm2'];
  let last = '';
  function timeText(d) {
    let h = d.getHours();
    let suffix = '';
    if (cfg.hour12) { suffix = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; }
    const mm = String(d.getMinutes()).padStart(2, '0');
    return {
      digits: String(h).padStart(2, '0') + mm,
      suffix,
      display: cfg.hour12 ? `${h}:${mm} ${suffix}` : `${String(h).padStart(2, '0')}:${mm}`,
    };
  }
  function tick() {
    const t = timeText(new Date());
    if (t.digits === last) return;
    last = t.digits;
    for (let i = 0; i < 4; i++) document.getElementById(ids[i]).textContent = t.digits[i];
    ampmEl.textContent = t.suffix;
    ampmEl.style.display = cfg.hour12 ? '' : 'none';
    currentTimeText = t.display;
  }
  tick();
  setInterval(tick, 1000);

  // ---- 拖动：整卡左键拖动（main 进程轮询鼠标跟随，窗口始终在鼠标下，mouseup 不丢失）----
  card.addEventListener('mousedown', (e) => {
    evt(`[clock] mousedown button=${e.button} x=${Math.round(e.clientX)} y=${Math.round(e.clientY)} w=${window.innerWidth}x${window.innerHeight}`);
    if (e.button === 0) ipcRenderer.send('drag-start');
    if (e.button === 2) ipcRenderer.send('activate'); // 未激活窗口先 focus，保证 contextmenu 触发
  });
  window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'));
  window.addEventListener('blur', () => ipcRenderer.send('drag-end'));
  window.addEventListener('resize', () => {
    evt(`[clock] RESIZE w=${window.innerWidth}x${window.innerHeight}`);
  });

  // ---- 右键：请求浮动菜单（附带当前状态用于菜单显示）----
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ipcRenderer.send('clock:menu:' + instId, {
      hour12: cfg.hour12,
      theme: document.documentElement.dataset.theme,
      veil: veilVal,
    });
  });

  // ---- 浮动菜单动作执行（主进程转发）----
  ipcRenderer.on('clock:menu:' + instId, (_e, { action }) => {
    if (action === 'hour12') {
      cfg.hour12 = !cfg.hour12;
      last = '';
      tick();
      savePrefs();
    } else if (action === 'theme') {
      forcedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      savePrefs();
    } else if (action === 'copy') {
      navigator.clipboard.writeText(currentTimeText || '--:--').catch(() => {});
    }
  });

  // ---- 透明度滑杆（浮动菜单拖动中实时更新，松手保存）----
  ipcRenderer.on('clock:veil:' + instId, (_e, { v, save }) => {
    if (typeof v !== 'number') return;
    veilVal = Math.max(0, Math.min(100, Math.round(v)));
    paintVeil();
    if (save) savePrefs();
  });

  // ---- 外观颜色（外观调节窗口实时推送；按字段更新，互不覆盖）----
  ipcRenderer.on('clock:appearance-color:' + instId, (_e, c) => {
    if (!c) return;
    if (c.bgColor !== undefined) { bgColor = c.bgColor || null; applyBgColor(); }
    if (c.digitColors && typeof c.digitColors === 'object') { Object.assign(digitColors, c.digitColors); applyDigitColors(); }
    if (c.hourColor !== undefined) hourColor = c.hourColor;
    if (c.minuteColor !== undefined) minuteColor = c.minuteColor;
    if (c.hourColor !== undefined || c.minuteColor !== undefined) applyColors();
    savePrefs();
  });

  // ---- 恢复默认配置（外观：背景底色 + 数字色 + 中号时/分色）----
  ipcRenderer.on('clock:appearance-reset:' + instId, () => {
    bgColor = null;
    digitColors = {};
    hourColor = '#ffffff';
    minuteColor = '#ffffff';
    applyBgColor();
    applyDigitColors();
    // 注意：applyColors 是中号时钟(clockM)的时/分色专用；渐变时钟绝不能调用（会把数字改成白色、去掉渐变）
    if (isClockM) applyColors();
    savePrefs();
  });

  // ---- 菜单切换的状态写入 config（重启保持）----
  function savePrefs() {
    const prefs = {
      hour12: cfg.hour12,
      theme: forcedTheme || cfg.theme,
      veilOpacity: veilVal,
      bgColor: bgColor || null,
      digitColors: digitColors || {},
    };
    if (isClockM) { prefs.hourColor = hourColor; prefs.minuteColor = minuteColor; }
    ipcRenderer.send('cfg:save:' + instId, prefs);
  }
})();
