const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const stamp = new Date().toISOString().replace(/[.:]/g, '-');
const outputRoot = path.resolve(process.argv[2] || path.join('F:\\', `Widgetly-test-minimum-size-${stamp}`));
const profileDir = path.join(outputRoot, 'profile');
const screenDir = path.join(outputRoot, 'screens');
const folderFixture = path.join(outputRoot, 'folder-fixture');

const studioCases = {
  plannerCalendar: [360, 260],
  quadrantTasks: [220, 220],
  miniCalendarGlass: [210, 220],
  flipClock: [190, 104],
  cycleCountdown: [180, 125],
  desktopFolder: [210, 180],
  analogClock: [130, 130],
  digitalClockGlass: [180, 92],
  stickyNote: [190, 140],
  lineWeather: [220, 170],
  desktopSchedule: [210, 150],
  markdownNote: [210, 160],
  desktopCounter: [190, 125],
  classSchedule: [210, 170],
  progressTracker: [210, 150],
  simplePomodoro: [190, 130],
  clockCalendar: [220, 300],
  durationTimer: [220, 130],
  alarmClock: [240, 145],
};

const specialCases = {
  countdownSingle: [160, 166],
  countdownTriple: [160, 166],
  promptOptimizer: [260, 108],
};

const requiredSelectors = {
  plannerCalendar: ['.planner-side', '.planner-main', '.calendar-grid'],
  quadrantTasks: ['.quadrants', '.quadrant'],
  miniCalendarGlass: ['.mini-calendar', '.calendar-grid', '.lunar-switch'],
  flipClock: ['.flip-row', '.flip-group'],
  cycleCountdown: ['.cycle-row', '.cycle-time'],
  desktopFolder: ['.folder-widget', '.folder-command-row', '.file-row'],
  analogClock: ['.dial', '#hourHand', '#minuteHand'],
  digitalClockGlass: ['.desktop-clock-time', '.desktop-clock-date', '.desktop-clock-lunar'],
  stickyNote: ['.sticky', '#stickyText'],
  lineWeather: ['.weather-line', '.weather-chart'],
  desktopSchedule: ['.schedule-row'],
  markdownNote: ['.markdown', '.md-area', '.md-render'],
  desktopCounter: ['.counter-row', '.counter-actions'],
  classSchedule: ['.schedule-row'],
  progressTracker: ['.progress-row', '.progress-track'],
  simplePomodoro: ['.pomodoro-simple', '.timer-value', '.timer-controls'],
  clockCalendar: ['.desktop-clock-time', '.desktop-month-calendar', '.desktop-calendar-grid'],
  durationTimer: ['.duration-titlebar', '.duration-value', '.duration-actions'],
  alarmClock: ['.alarm-idle-head', '.alarm-list', '.alarm-row'],
  countdownSingle: ['.single-content', '.hero-title', '.hero-number', '.today'],
  countdownTriple: ['.triple-content', '.triple-head', '.count-list', '.count-row'],
  promptOptimizer: ['#miniShell', '#promptInput', '#optimizeButton'],
};

const screenshotCases = new Set([
  'plannerCalendar', 'quadrantTasks', 'miniCalendarGlass', 'clockCalendar',
  'desktopFolder', 'lineWeather', 'markdownNote', 'classSchedule',
  'durationTimer', 'alarmClock', 'countdownSingle', 'countdownTriple',
  'promptOptimizer',
]);

class CdpClient {
  constructor(url) {
    this.next = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message));
      else pending.resolve(data.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 12_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const exception = result.exceptionDetails.exception;
      throw new Error((exception && exception.description) || result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result.value;
  }
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  }
  close() {
    try { this.socket.close(); } catch (_) {}
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function isoDate(offset = 0) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function seededConfig(widgetId) {
  const common = { theme: 'dark', bgOpacity: 0.4, accent: '#5caeff', pinned: false, locked: false, clickThrough: false };
  const weekday = new Date().getDay();
  const byWidget = {
    plannerCalendar: {
      tasks: [
        { id: 'task-one', text: '完成最小尺寸回归验证', date: isoDate(0), done: false },
        { id: 'task-two', text: '检查组件内容动态匹配', date: isoDate(0), done: true },
      ],
    },
    quadrantTasks: {
      quadrants: [
        { title: '重要且紧急', color: '#df6673', tasks: [{ id: 'q1', text: '处理发布问题', done: false }] },
        { title: '重要不紧急', color: '#d6a658', tasks: [{ id: 'q2', text: '优化组件排版', done: false }] },
        { title: '紧急不重要', color: '#55aa81', tasks: [{ id: 'q3', text: '整理临时文件', done: false }] },
        { title: '不重要不紧急', color: '#5162ab', tasks: [{ id: 'q4', text: '稍后阅读资讯', done: false }] },
      ],
    },
    miniCalendarGlass: { showLunar: true },
    clockCalendar: { showLunar: true, showSeconds: true, hour12: false },
    flipClock: { showSeconds: true, hour12: false },
    cycleCountdown: {
      cycles: [
        { id: 'cycle-one', name: '距离周末', kind: 'weekly', weekday: 6 },
        { id: 'cycle-two', name: '距离发薪日', kind: 'monthly', day: 15 },
      ],
    },
    desktopFolder: { folder: folderFixture, folderSort: 'name-asc' },
    analogClock: { theme: 'light', showSeconds: true },
    digitalClockGlass: { showSeconds: true, hour12: false, showLunar: true },
    stickyNote: {
      pages: [{ id: 'note-one', name: '工作', text: '检查用户反馈，修复常见问题。\n确保缩小后文字与按钮仍然清晰。' }],
      activePage: 'note-one',
    },
    lineWeather: { city: '北京', autoLocation: false },
    desktopSchedule: {
      events: [
        { id: 'event-one', date: isoDate(1), title: '项目复盘', place: '会议室 A', note: '带上测试记录' },
        { id: 'event-two', date: isoDate(1), title: '版本检查', place: '线上', note: '' },
      ],
    },
    markdownNote: {
      title: 'Markdown 桌面笔记',
      text: '# 最小尺寸测试\n\n**关键文字** 不应被按钮覆盖。\n\n- 页面不可横向溢出\n- 内容区域可正常滚动',
    },
    desktopCounter: {
      counters: [
        { id: 'counter-one', name: '喝水次数', value: 3 },
        { id: 'counter-two', name: '专注次数', value: 8 },
      ],
    },
    classSchedule: {
      courses: [
        { id: 'course-one', weekday, name: '计算机', start: '08:00', end: '09:30', place: '实训楼 307' },
        { id: 'course-two', weekday, name: '英语', start: '10:00', end: '11:20', place: '教学楼 109' },
      ],
    },
    progressTracker: { progresses: [{ id: 'progress-one', name: 'Widgetly 测试', value: 72 }] },
    simplePomodoro: { mode: 'pomodoro', focusMin: 25, breakMin: 5, focusLabel: '最小尺寸验证', running: false, endAt: 0, remaining: 1500, stopwatchSeconds: 0, sessions: {} },
    durationTimer: { label: '当前任务', presets: [5, 15, 25, 45], selectedMinutes: 25, remaining: 1500, running: false, endAt: 0, loop: false, notify: false, history: [] },
    alarmClock: {
      snoozeMin: 10,
      ringingId: '',
      alarmSound: { mode: 'none', filePath: '', fileName: '', volume: 0.85, repeat: true },
      alarms: [{ id: 'alarm-one', time: '07:30', label: '起床', repeat: [1, 2, 3, 4, 5], enabled: true, lastFiredKey: '', snoozeUntil: 0 }],
    },
  };
  return { ...common, ...(byWidget[widgetId] || {}) };
}

function prepareProfile() {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(screenDir, { recursive: true });
  fs.mkdirSync(path.join(folderFixture, '示例子文件夹'), { recursive: true });
  fs.writeFileSync(path.join(folderFixture, '工作报告.txt'), 'Widgetly minimum-size validation fixture.\n', 'utf8');
  fs.writeFileSync(path.join(folderFixture, '组件说明.md'), '# Fixture\n', 'utf8');

  const instances = [];
  let index = 0;
  for (const widgetId of Object.keys(studioCases)) {
    instances.push({
      id: `minimum-${widgetId}`,
      widgetId,
      x: 24 + (index % 5) * 16,
      y: 24 + (index % 4) * 16,
      config: seededConfig(widgetId),
    });
    index += 1;
  }
  instances.push({
    id: 'minimum-countdownSingle',
    widgetId: 'countdownSingle',
    x: 30,
    y: 30,
    config: { width: 160, height: 166, activeId: 'date-one', bgOpacity: 0.2 },
  });
  instances.push({
    id: 'minimum-countdownTriple',
    widgetId: 'countdownTriple',
    x: 46,
    y: 46,
    config: { width: 160, height: 166, slotIds: ['date-one', 'date-two', 'date-three'], bgOpacity: 0.2 },
  });
  instances.push({
    id: 'minimum-promptOptimizer',
    widgetId: 'promptOptimizer',
    x: 62,
    y: 62,
    config: {
      bgOpacity: 0.4,
      strength: 1,
      pinned: false,
      locked: false,
      draft: '请把这段需求优化成清晰、直接、高效的 AI 指令。',
      lastResult: '',
      widgetWidth: 260,
      miniHeight: 108,
      resultHeight: 230,
    },
  });

  const config = {
    theme: 'dark',
    autostart: false,
    openManagerOnStart: false,
    closeToTray: true,
    clickThroughShortcut: 'CommandOrControl+Alt+Shift+W',
    managerOpacity: 0.5,
    pinToDesktop: false,
    countdownTargets: [
      { id: 'date-one', name: '国庆节', date: '2026-10-01', color: '#319fe8' },
      { id: 'date-two', name: '元旦', date: '2027-01-01', color: '#ff9f2e' },
      { id: 'date-three', name: '春节假期', date: '2027-02-06', color: '#8b74e8' },
    ],
    instances,
  };
  fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function checkMainRegistry() {
  const source = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  const found = {};
  for (const [widgetId, expected] of Object.entries(studioCases)) {
    const expression = new RegExp(`\\b${widgetId}:\\s*\\{[^\\r\\n]*?minW:\\s*(\\d+)[^\\r\\n]*?minH:\\s*(\\d+)`);
    const match = source.match(expression);
    assert(match, `${widgetId} 在 main.js 中没有明确的 minW/minH`);
    found[widgetId] = [Number(match[1]), Number(match[2])];
    assert(found[widgetId][0] === expected[0] && found[widgetId][1] === expected[1],
      `${widgetId} main.js 最小尺寸为 ${found[widgetId].join('x')}，预期 ${expected.join('x')}`);
  }
  return found;
}

async function listPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await response.json()).filter((target) => target.type === 'page');
}

async function waitForPage(port, widgetId, timeout = 45_000) {
  const expectedInstance = `minimum-${widgetId}`;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const target = (await listPages(port)).find((candidate) => {
        try {
          const url = new URL(candidate.url);
          return url.searchParams.get('wid') === widgetId
            && url.searchParams.get('inst') === expectedInstance
            && url.searchParams.get('settings') !== '1';
        } catch (_) { return false; }
      });
      if (target) return target;
    } catch (_) {}
    await wait(100);
  }
  throw new Error(`等待 ${widgetId} 窗口超时`);
}

async function waitForReady(client, widgetId) {
  const expression = widgetId === 'promptOptimizer'
    ? `new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.readyState==='complete'&&window.widgetlyPrompt&&document.getElementById('promptInput'))resolve(true);else if(Date.now()-started>10000)resolve(false);else setTimeout(check,50);};check();})`
    : widgetId.startsWith('countdown')
      ? `new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.readyState==='complete'&&document.getElementById('card')&&document.querySelector('${widgetId === 'countdownSingle' ? '.single-content' : '.triple-content'}'))resolve(true);else if(Date.now()-started>10000)resolve(false);else setTimeout(check,50);};check();})`
      : `new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.readyState==='complete'&&typeof cfg==='object'&&Object.keys(cfg).length&&document.getElementById('content')&&document.getElementById('content').children.length)resolve(true);else if(Date.now()-started>10000)resolve(false);else setTimeout(check,50);};check();})`;
  assert(await client.evaluate(expression), `${widgetId} 渲染内容未准备完成`);
}

async function forceBelowMinimum(client, widgetId) {
  if (widgetId !== 'promptOptimizer') {
    await client.evaluate(`require('electron').ipcRenderer.send('resize:${`minimum-${widgetId}`}',{width:48,height:48});true`);
    await wait(360);
    return;
  }
  try {
    const info = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId: info.windowId, bounds: { width: 48, height: 48 } });
    await wait(360);
  } catch (_) {
    // Prompt 窗口启动时已按 260×108 应用真实最小限制；旧 Electron 不支持该 CDP 方法时保留启动尺寸验证。
  }
}

function layoutExpression(widgetId, selectors) {
  return `(() => {
    const required=${JSON.stringify(selectors)};
    const visible=(el)=>{
      if(!el)return false;
      const style=getComputedStyle(el),rect=el.getBoundingClientRect();
      return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0&&rect.width>.5&&rect.height>.5;
    };
    const criticalSelector=[
      'button','input','textarea','select','h1','h2','h3',
      '.planner-date','.calendar-grid','.desktop-calendar-grid','.desktop-clock-time','.desktop-clock-date','.desktop-clock-lunar',
      '.flip-row','.dial','.cycle-time','.folder-command-row','.folder-path','.weather-chart',
      '.md-title','.md-area','.timer-value','.duration-value','.duration-state','.alarm-now','.alarm-list',
      '.hero-number','.hero-unit','.today','.count-list','.term-line','.result-title','.result-text'
    ].join(',');
    const critical=[...new Set([...document.querySelectorAll(criticalSelector)])].filter(visible);
    const clippedByScroll=(el,rect)=>{
      let parent=el.parentElement;
      while(parent&&parent!==document.body&&parent!==document.documentElement){
        const style=getComputedStyle(parent),pr=parent.getBoundingClientRect();
        const scrollable=/(auto|scroll)/.test(style.overflowX+style.overflowY)
          ||parent.matches('.scroll-list,.quadrant-list,.planner-tasks,.md-area,.result-text,.alarm-list,.folder-list');
        if(scrollable&&(rect.right>pr.right+1||rect.bottom>pr.bottom+1||rect.left<pr.left-1||rect.top<pr.top-1))return true;
        parent=parent.parentElement;
      }
      return false;
    };
    const outside=critical.filter((el)=>{
      const r=el.getBoundingClientRect();
      const escaped=r.left<-2||r.top<-2||r.right>innerWidth+2||r.bottom>innerHeight+2;
      return escaped&&!clippedByScroll(el,r);
    }).map((el)=>({tag:el.tagName,cls:String(el.className).slice(0,80),id:el.id,rect:[el.getBoundingClientRect().left,el.getBoundingClientRect().top,el.getBoundingClientRect().right,el.getBoundingClientRect().bottom].map((n)=>Math.round(n))}));
    const contentRect=(el)=>{
      const r=el.getBoundingClientRect(),style=getComputedStyle(el);
      if(!el.matches('input,textarea,select'))return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
      const left=r.left+(parseFloat(style.paddingLeft)||0),right=r.right-(parseFloat(style.paddingRight)||0);
      const top=r.top+(parseFloat(style.paddingTop)||0),bottom=r.bottom-(parseFloat(style.paddingBottom)||0);
      return {left,top,right,bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
    };
    const overlap=[];
    for(let i=0;i<critical.length;i++)for(let j=i+1;j<critical.length;j++){
      const a=critical[i],b=critical[j];
      if(a.contains(b)||b.contains(a))continue;
      if(a.closest('.scroll-list,.quadrant-list,.planner-tasks,.alarm-list,.count-list')===b.closest('.scroll-list,.quadrant-list,.planner-tasks,.alarm-list,.count-list')
          &&a.closest('.scroll-list,.quadrant-list,.planner-tasks,.alarm-list,.count-list'))continue;
      const ar=contentRect(a),br=contentRect(b);
      const w=Math.min(ar.right,br.right)-Math.max(ar.left,br.left),h=Math.min(ar.bottom,br.bottom)-Math.max(ar.top,br.top);
      if(w<=3||h<=3)continue;
      const area=w*h,minArea=Math.min(ar.width*ar.height,br.width*br.height);
      if(minArea>0&&area/minArea>.34)overlap.push({a:a.id||String(a.className).slice(0,60)||a.tagName,b:b.id||String(b.className).slice(0,60)||b.tagName,ratio:Number((area/minArea).toFixed(2))});
    }
    const requiredState=required.map((selector)=>({selector,count:[...document.querySelectorAll(selector)].filter(visible).length}));
    const card=document.getElementById('card')||document.getElementById('miniShell');
    const cardRect=card&&card.getBoundingClientRect();
    return {
      widgetId:${JSON.stringify(widgetId)},
      viewport:[innerWidth,innerHeight],
      document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
      body:[document.body.scrollWidth,document.body.scrollHeight],
      card:cardRect?[Math.round(cardRect.left),Math.round(cardRect.top),Math.round(cardRect.width),Math.round(cardRect.height)]:null,
      required:requiredState,
      outside:outside.slice(0,12),
      overlap:overlap.slice(0,12),
      text:(document.body.innerText||'').trim().slice(0,160),
      formValue:[...document.querySelectorAll('input,textarea,select')].filter(visible).map((el)=>String(el.value||'').trim()).filter(Boolean).join(' ').slice(0,160),
    };
  })()`;
}

async function normalizeTestContent(client, widgetId) {
  if (widgetId === 'lineWeather') {
    await client.evaluate(`weatherData={ok:true,city:'北京',automatic:false,current:26,updatedAt:Date.now(),days:[0,1,2,3].map((offset)=>({date:new Date(Date.now()+offset*86400000).toISOString().slice(0,10),code:offset===3?61:1,high:29-offset,low:18-offset}))};renderWeather();true`);
    await wait(100);
  }
  if (widgetId === 'desktopFolder') {
    await client.evaluate(`new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.querySelector('.file-row'))resolve(true);else if(Date.now()-started>7000)resolve(false);else setTimeout(check,80);};check();})`);
  }
}

async function measureCase(port, widgetId, expected, options = {}) {
  const target = await waitForPage(port, widgetId);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.ready;
  try {
    await waitForReady(client, widgetId);
    await normalizeTestContent(client, widgetId);
    await forceBelowMinimum(client, widgetId);
    await normalizeTestContent(client, widgetId);
    const layout = await client.evaluate(layoutExpression(widgetId, requiredSelectors[widgetId] || []));
    const suffix = options.suffix || 'minimum';
    if (screenshotCases.has(widgetId)) await client.screenshot(path.join(screenDir, `${widgetId}-${suffix}.png`));
    return { widgetId, state: suffix, expected, ...layout };
  } finally {
    client.close();
  }
}

function validateResult(result) {
  const failures = [];
  const [expectedWidth, expectedHeight] = result.expected;
  if (Math.abs(result.viewport[0] - expectedWidth) > 1 || Math.abs(result.viewport[1] - expectedHeight) > 1) {
    failures.push(`实际窗口 ${result.viewport.join('x')}，预期 ${result.expected.join('x')}`);
  }
  if (result.document[0] > result.viewport[0] + 1 || result.document[1] > result.viewport[1] + 1
      || result.body[0] > result.viewport[0] + 1 || result.body[1] > result.viewport[1] + 1) {
    failures.push(`页面溢出 document=${result.document.join('x')} body=${result.body.join('x')}`);
  }
  const missing = result.required.filter((item) => item.count === 0).map((item) => item.selector);
  if (missing.length) failures.push(`缺少或不可见: ${missing.join(', ')}`);
  if (result.outside.length) failures.push(`关键内容越界: ${JSON.stringify(result.outside)}`);
  if (result.overlap.length) failures.push(`关键内容重叠: ${JSON.stringify(result.overlap)}`);
  if (!result.text && !result.formValue) failures.push('窗口没有可见文本');
  return failures;
}

async function quit(port, child) {
  try {
    const target = (await listPages(port)).find((page) => page.url.includes('wid=durationTimer'))
      || (await listPages(port))[0];
    if (target) {
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.ready;
      await client.evaluate(`require('electron').ipcRenderer.send('quit-app');true`);
      client.close();
    }
  } catch (_) {}
  const exited = await Promise.race([child.exitPromise.then(() => true), wait(8000).then(() => false)]);
  if (!exited) child.kill();
}

(async () => {
  assert(fs.existsSync(electronExe), `Electron runtime not found: ${electronExe}`);
  prepareProfile();
  const registry = checkMainRegistry();
  const port = await freePort();
  const isolatedAppData = path.join(profileDir, 'appdata');
  fs.mkdirSync(isolatedAppData, { recursive: true });
  const child = spawn(electronExe, [
    appDir,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--widgetly-test-mode',
  ], {
    cwd: appDir,
    windowsHide: true,
    env: { ...process.env, APPDATA: isolatedAppData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (part) => { logs += part; });
  child.stderr.on('data', (part) => { logs += part; });
  child.exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  const results = [];
  let fatal = null;
  try {
    // 组件错峰创建，先等待最后一个实例，确认所有窗口都已经注册真实最小尺寸。
    await waitForPage(port, 'promptOptimizer');
    for (const [widgetId, expected] of Object.entries(studioCases)) {
      results.push(await measureCase(port, widgetId, expected));
      console.log('MINIMUM_SIZE|' + JSON.stringify(results[results.length - 1]));
    }
    for (const widgetId of ['countdownSingle', 'countdownTriple']) {
      results.push(await measureCase(port, widgetId, specialCases[widgetId]));
      console.log('MINIMUM_SIZE|' + JSON.stringify(results[results.length - 1]));
    }

    const promptMini = await measureCase(port, 'promptOptimizer', specialCases.promptOptimizer, { suffix: 'mini-minimum' });
    results.push(promptMini);
    console.log('MINIMUM_SIZE|' + JSON.stringify(promptMini));

    const promptTarget = await waitForPage(port, 'promptOptimizer');
    const promptClient = new CdpClient(promptTarget.webSocketDebuggerUrl);
    await promptClient.ready;
    await promptClient.evaluate(`applyResult('你是一名高效的软件测试助手。请逐项检查组件在最小尺寸下的排版、按钮可用性和内容完整性，并用清晰的中文列出发现的问题。');true`);
    await wait(500);
    await forceBelowMinimum(promptClient, 'promptOptimizer');
    const promptResult = await promptClient.evaluate(layoutExpression('promptOptimizer', [...requiredSelectors.promptOptimizer, '#resultPanel', '#resultText', '#doneButton']));
    promptResult.widgetId = 'promptOptimizer';
    promptResult.state = 'result-minimum';
    promptResult.expected = [260, 230];
    await promptClient.screenshot(path.join(screenDir, 'promptOptimizer-result-minimum.png'));
    promptClient.close();
    results.push(promptResult);
    console.log('MINIMUM_SIZE|' + JSON.stringify(promptResult));

    const failures = results.flatMap((result) => validateResult(result).map((message) => ({ widgetId: result.widgetId, state: result.state, message })));
    const summary = {
      ok: failures.length === 0,
      createdAt: new Date().toISOString(),
      outputRoot,
      registry,
      tested: results.length,
      failures,
      results,
    };
    fs.writeFileSync(path.join(outputRoot, 'minimum-size-results.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log('MINIMUM_SIZE_SUMMARY|' + JSON.stringify({ ok: summary.ok, tested: summary.tested, failures: summary.failures, outputRoot }));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    fatal = error;
    console.error(error.stack || error);
    fs.writeFileSync(path.join(outputRoot, 'electron-output.log'), logs, 'utf8');
    process.exitCode = 1;
  } finally {
    await quit(port, child);
    if (logs.trim()) fs.writeFileSync(path.join(outputRoot, 'electron-output.log'), logs, 'utf8');
  }
  if (fatal) throw fatal;
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
