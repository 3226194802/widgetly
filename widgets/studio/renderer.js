const { ipcRenderer, clipboard } = require('electron');
const { pathToFileURL } = require('url');

const params = new URLSearchParams(location.search);
const instId = params.get('inst') || 'preview';
const widgetId = params.get('wid') || 'miniCalendarGlass';
const preview = instId === 'preview';
const settingsMode = params.get('settings') === '1';
// 组件坞中的 Studio 组件仍使用自身的数据和设置页，但不再拥有独立桌面窗口。
// 因此禁止子组件直接发起窗口拖动，并允许组件坞提供统一背景。
const hostedByDock = params.get('host') === 'componentDock';
const dockSurface = params.get('surface') === 'card' ? 'card' : 'inherit';
const card = document.getElementById('card');
const content = document.getElementById('content');
const editor = document.getElementById('editor');
const editorBody = document.getElementById('editorBody');
const editorTitle = document.getElementById('editorTitle');
const toastNode = document.getElementById('toast');
document.body.classList.toggle('settings-page', settingsMode);
card.classList.toggle('settings-mode', settingsMode);

const NAMES = {
  plannerCalendar: '桌面待办大日历', quadrantTasks: '四象限清单', miniCalendarGlass: '桌面小日历',
  flipClock: '翻页时钟', cycleCountdown: '周期倒数日', desktopFolder: '桌面文件夹', analogClock: '圆盘时钟',
  digitalClockGlass: '桌面时钟日历·精简', stickyNote: '桌面便签', lineWeather: '桌面折线天气', desktopSchedule: '桌面日程',
  markdownNote: '桌面笔记', desktopCounter: '桌面计数器', classSchedule: '桌面课程表',
  progressTracker: '桌面进度条', simplePomodoro: '简约番茄时钟', clockCalendar: '桌面时钟日历·完整',
  durationTimer: '倒计时工具', alarmClock: '闹钟',
};
const WEEK = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
const WEEK_SHORT = ['日','一','二','三','四','五','六'];
const WMO = {
  0:['☀','晴'],1:['🌤','少云'],2:['⛅','多云'],3:['☁','阴'],45:['🌫','雾'],48:['🌫','雾凇'],
  51:['🌦','毛毛雨'],53:['🌦','毛毛雨'],55:['🌧','毛毛雨'],61:['🌧','小雨'],63:['🌧','中雨'],65:['🌧','大雨'],
  71:['🌨','小雪'],73:['🌨','中雪'],75:['❄','大雪'],80:['🌦','阵雨'],81:['🌧','阵雨'],82:['⛈','强阵雨'],
  85:['🌨','阵雪'],86:['❄','强阵雪'],95:['⛈','雷阵雨'],96:['⛈','雷雨冰雹'],99:['⛈','强雷雨冰雹'],
};
let LUNAR_API = window.LUNAR;
if (!LUNAR_API) {
  try {
    const { Solar } = require('../calendar/lunar-lib.js');
    LUNAR_API = {
      toLunar(y,m,d) { const lunar=Solar.fromYmd(y,m,d).getLunar(); return { lYear:lunar.getYear(), lMonth:Math.abs(lunar.getMonth()), lDay:lunar.getDay(), isLeap:lunar.getMonth()<0 }; },
      lunarText(y,m,d) { return Solar.fromYmd(y,m,d).getLunar().getDayInChinese(); },
      termsOfMonth(y,m) { const out=[];const days=new Date(y,m,0).getDate();for(let d=1;d<=days;d++){const name=Solar.fromYmd(y,m,d).getLunar().getJieQi();if(name)out.push({name,day:d});}return out; },
    };
  } catch (_) { LUNAR_API = null; }
}

let cfg = {};
let locked = false;
let monthOffset = 0;
let selectedDate = dateKey(new Date());
let scheduleOffset = 1;
let weatherData = null;
let folderData = null;
let folderQuery = '';
let folderCurrent = '';
let visibleFolderItems = [];
let folderPanel = null;
let folderSortOpen = false;
let markdownPreview = true;
let editDraft = null;
let saveTimer = null;
let toastTimer = null;
let lastFlip = '';
let lastAlarmScanAt = Date.now() - 60_000;
let alarmAudio = null;
let alarmQueue = [];

function uid(prefix = 'item') { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,7); }
function pad(number) { return String(number).padStart(2, '0'); }
function dateKey(date) { return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`; }
function parseDate(value) { const date = new Date(String(value || '') + 'T00:00:00'); return Number.isNaN(date.getTime()) ? new Date() : date; }
function dayStart(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function esc(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function number(value, fallback, min = -Infinity, max = Infinity) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function safeColor(value, fallback) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback; }
function get(id) { return document.getElementById(id); }
const ICONS={
  back:'<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>', external:'<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  refresh:'<svg viewBox="0 0 24 24"><path d="M20 6v5h-5"/><path d="M18.5 15a7 7 0 1 1-.8-7.9L20 11"/></svg>', choose:'<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 12v5M9.5 14.5h5"/></svg>',
  newFolder:'<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 12v5M9.5 14.5h5"/></svg>', search:'<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l4 4"/></svg>',
  sort:'<svg viewBox="0 0 24 24"><path d="M8 6h11M8 12h8M8 18h5"/><path d="M4 5v14M2 17l2 2 2-2"/></svg>', chevron:'<svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg>',
  nameSort:'<svg viewBox="0 0 24 24"><path d="M5 18l4-12 4 12M6.5 14h5"/><path d="M16 7h4l-4 10h4"/></svg>', dateSort:'<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6"/></svg>',
  typeSort:'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>', sizeSort:'<svg viewBox="0 0 24 24"><path d="M5 19L19 5M10 19H5v-5M14 5h5v5"/></svg>',
  more:'<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>', edit:'<svg viewBox="0 0 24 24"><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 7l3 3"/></svg>',
  trash:'<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>', folder:'<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  image:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M4 17l5-5 4 4 2-2 5 4"/></svg>', document:'<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6"/></svg>',
  sheet:'<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6M12 10v8"/></svg>', archive:'<svg viewBox="0 0 24 24"><path d="M5 4h14v5H5zM6 9h12v11H6zM10 13h4"/></svg>',
  media:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>', text:'<svg viewBox="0 0 24 24"><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/></svg>', file:'<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5"/></svg>',
  alarm:'<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2M7 20l-2 2M17 20l2 2M5 5L2 8M19 5l3 3"/></svg>',
  timer:'<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 13l3-3M9 2h6M12 5V2"/></svg>',
  loop:'<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  settings:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></svg>',
  info:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7h.01"/></svg>',
};
function icon(name){return `<span class="ui-icon">${ICONS[name]||ICONS.file}</span>`;}
function lunarInfo(date) {
  try {
    const lunar = LUNAR_API.toLunar(date.getFullYear(), date.getMonth()+1, date.getDate());
    return { ...lunar, text: LUNAR_API.lunarText(date.getFullYear(), date.getMonth()+1, date.getDate()) };
  } catch (_) { return { lMonth:0,lDay:0,text:'' }; }
}
const LUNAR_MONTHS = ['正','二','三','四','五','六','七','八','九','十','冬','腊'];
function fullLunarText(date) {
  const lunar = lunarInfo(date);
  if (!lunar.lMonth || !lunar.text) return '农历日期暂不可用';
  return `农历${lunar.isLeap?'闰':''}${LUNAR_MONTHS[lunar.lMonth-1]||lunar.lMonth}月${lunar.text}`;
}
function lunarOrHoliday(date, termMap) {
  const key = `${date.getMonth()+1}-${date.getDate()}`;
  const solar = {'1-1':'元旦','5-1':'劳动节','5-4':'青年节','10-1':'国庆节'}[key];
  if (solar) return solar;
  const lunar = lunarInfo(date);
  const lk = `${lunar.lMonth}-${lunar.lDay}`;
  const festival = {'1-1':'春节','1-15':'元宵','5-5':'端午','8-15':'中秋'}[lk];
  return festival || (termMap && termMap[date.getDate()]) || lunar.text;
}
function showToast(message) {
  clearTimeout(toastTimer); toastNode.textContent = String(message || ''); toastNode.hidden = false;
  toastTimer = setTimeout(() => { toastNode.hidden = true; }, 2200);
}

function defaults() {
  const today = new Date();
  const todayKey = dateKey(today);
  const tomorrow = dateKey(new Date(today.getFullYear(),today.getMonth(),today.getDate()+1));
  const common = { theme:'dark', bgOpacity:.4, accent:'#5caeff', pinned:false, locked:false, clickThrough:false };
  const map = {
    plannerCalendar: { ...common, tasks: preview ? [
      {id:uid(),text:'完成产品需求梳理',date:todayKey,done:false},{id:uid(),text:'整理项目资料与文件',date:todayKey,done:true},
      {id:uid(),text:'准备明天的工作计划',date:tomorrow,done:false},{id:uid(),text:'更新本周进度',date:tomorrow,done:false},
    ] : [] },
    quadrantTasks: { ...common, quadrants:[
      {title:'重要且紧急',color:'#df6673',tasks:preview?['处理客户工单','准备下午会议材料','解决发布版本问题']:[]},
      {title:'重要不紧急',color:'#d6a658',tasks:preview?['优化业务流程','学习新技能','规划长期目标']:[]},
      {title:'紧急不重要',color:'#55aa81',tasks:preview?['清理无关紧要的文件','接听不重要的电话']:[]},
      {title:'不重要不紧急',color:'#5162ab',tasks:preview?['浏览资讯','过滤无效社交媒体']:[]},
    ].map((q)=>({...q,tasks:q.tasks.map((text)=>({id:uid(),text,done:false}))})) },
    miniCalendarGlass: { ...common, showLunar:true },
    clockCalendar: { ...common, showLunar:true, showSeconds:true, hour12:false },
    flipClock: { ...common, showSeconds:true, hour12:false },
    cycleCountdown: { ...common, cycles:[
      {id:uid(),name:'距离五一劳动节',kind:'yearly',month:5,day:1},
      {id:uid(),name:'距离春节',kind:'lunar',month:1,day:1},
      {id:uid(),name:'距离每月发工资',kind:'monthly',day:15},
      {id:uid(),name:'距离周末',kind:'weekly',weekday:6},
    ] },
    desktopFolder: { ...common, folder:'', folderSort:'name-asc' },
    analogClock: { ...common, theme:'light', showSeconds:true },
    digitalClockGlass: { ...common, showSeconds:true, hour12:false, theme:'dark' },
    stickyNote: { ...common, pages:[{id:uid(),name:'工作',text:preview?'检查用户反馈，修复常见问题。\n\n优化启动速度，减少加载时间。\n\n确保所有接口请求稳定，避免超时。':''},{id:uid(),name:'生活',text:''}], activePage:'' },
    lineWeather: { ...common, city:'北京', autoLocation:true },
    desktopSchedule: { ...common, events: preview ? [
      {id:uid(),date:tomorrow,title:'高数课',place:'教学楼202',note:''},{id:uid(),date:tomorrow,title:'英语课',place:'教学楼109',note:'带耳机'},
      {id:uid(),date:tomorrow,title:'计算机',place:'实训楼307',note:''},
    ] : [] },
    markdownNote: { ...common, title:'Markdown 桌面笔记', text:preview?'正常笔记文本字体效果\n\n**笔记字体加粗**\n\n*笔记语法字体倾斜*\n\n~~笔记语法删除线~~\n\n- 无序列表1\n- 无序列表2\n\n- [x] 笔记事项':'# 我的桌面笔记\n\n开始记录……' },
    desktopCounter: { ...common, counters:[{id:uid(),name:'喝水次数',value:preview?3:0},{id:uid(),name:'走神次数',value:0}] },
    classSchedule: { ...common, courses: preview ? [
      {id:uid(),weekday:today.getDay(),name:'体育',start:'08:00',end:'08:40',place:''},
      {id:uid(),weekday:today.getDay(),name:'政治',start:'08:50',end:'09:30',place:''},
      {id:uid(),weekday:today.getDay(),name:'生物',start:'10:45',end:'12:15',place:''},
      {id:uid(),weekday:today.getDay(),name:'计算机',start:'16:40',end:'17:15',place:''},
    ] : [] },
    progressTracker: { ...common, progresses:[{id:uid(),name:'工作',value:20},{id:uid(),name:'学习',value:preview?91:0}] },
    simplePomodoro: { ...common, mode:'pomodoro', focusMin:25, breakMin:5, focusLabel:'背单词', running:false, endAt:0, remaining:25*60, stopwatchSeconds:0, sessions:{} },
    durationTimer: { ...common, label:'当前任务', presets:[5,15,25,45], selectedMinutes:25, remaining:25*60, running:false, endAt:0, loop:false, notify:true, history:[] },
    alarmClock: { ...common, snoozeMin:10, ringingId:'', alarmSound:{mode:'system',filePath:'',fileName:'',volume:.85,repeat:true}, alarms: preview ? [
      {id:uid('alarm'),time:'07:30',label:'起床',repeat:[1,2,3,4,5],enabled:true,lastFiredKey:''},
      {id:uid('alarm'),time:'09:00',label:'开始工作',repeat:[],enabled:true,lastFiredKey:''},
    ] : [] },
  };
  return map[widgetId] || common;
}

function normalizeConfig(raw) {
  const base = defaults();
  const out = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (widgetId === 'stickyNote') {
    out.pages = Array.isArray(out.pages) && out.pages.length ? out.pages : base.pages;
    if (!out.activePage || !out.pages.some((page)=>page.id===out.activePage)) out.activePage = out.pages[0].id;
  }
  ['tasks','cycles','events','counters','courses','progresses','alarms','history'].forEach((key)=>{ if (key in base && !Array.isArray(out[key])) out[key]=base[key]; });
  if (widgetId === 'durationTimer') {
    out.presets = Array.isArray(out.presets) && out.presets.length ? out.presets.map((value)=>number(value,25,1,720)).slice(0,6) : base.presets;
    out.selectedMinutes = number(out.selectedMinutes,out.presets[0]||25,1,720);
    out.remaining = number(out.remaining,out.selectedMinutes*60,0,2592000);
  }
  if (widgetId === 'alarmClock') {
    out.alarmSound = {
      mode: 'system', filePath: '', fileName: '', volume: .85, repeat: true,
      ...(out.alarmSound && typeof out.alarmSound === 'object' ? out.alarmSound : {}),
    };
    if (!['system','custom','none'].includes(out.alarmSound.mode)) out.alarmSound.mode = 'system';
    out.alarmSound.volume = number(out.alarmSound.volume,.85,0,1);
    out.alarmSound.repeat = out.alarmSound.repeat !== false;
  }
  if (widgetId === 'quadrantTasks' && (!Array.isArray(out.quadrants)||out.quadrants.length!==4)) out.quadrants=base.quadrants;
  return out;
}

function applyStyle() {
  const opacity = number(cfg.bgOpacity,.4,0,1);
  const effectiveOpacity = hostedByDock && dockSurface === 'inherit' ? 0 : opacity;
  card.style.setProperty('--bg-alpha',String(effectiveOpacity));
  card.style.setProperty('--ambient-alpha',String(hostedByDock && dockSurface === 'inherit' ? 0 : Math.min(.22,opacity*.425)));
  card.style.setProperty('--accent',safeColor(cfg.accent,'#5caeff'));
  card.style.setProperty('--accent-2',cfg.theme==='light'?'#7ab4f3':'#8178f2');
  card.classList.toggle('light',cfg.theme==='light');
  card.classList.toggle('surface-owned',widgetId==='durationTimer'||widgetId==='alarmClock');
  card.classList.toggle('background-clear',opacity<=.001);
}
function save(partial = null, immediate = true) {
  if (partial && typeof partial === 'object') cfg = { ...cfg, ...partial };
  applyStyle();
  if (preview) return;
  const commit = () => ipcRenderer.send('cfg:save:' + instId, cfg);
  clearTimeout(saveTimer);
  if (immediate) commit(); else saveTimer=setTimeout(commit,320);
}

function monthData(offset = monthOffset) {
  const now = new Date();
  const focus = new Date(now.getFullYear(),now.getMonth()+offset,1);
  const first = new Date(focus.getFullYear(),focus.getMonth(),1);
  const start = new Date(first.getFullYear(),first.getMonth(),1-first.getDay());
  const terms = {};
  try { (LUNAR_API.termsOfMonth(focus.getFullYear(),focus.getMonth()+1)||[]).forEach((item)=>{terms[item.day]=item.name;}); } catch (_) {}
  const cells=[];
  for(let i=0;i<42;i++){
    const date=new Date(start.getFullYear(),start.getMonth(),start.getDate()+i);
    cells.push({date,key:dateKey(date),out:date.getMonth()!==focus.getMonth(),today:dateKey(date)===dateKey(now),label:lunarOrHoliday(date,date.getMonth()===focus.getMonth()?terms:null)});
  }
  return { focus, cells, terms };
}
function calendarCells(data, planner = false, showLunar = true) {
  return data.cells.map((cell)=>{
    const dayTasks = planner ? (cfg.tasks||[]).filter((task)=>task.date===cell.key) : [];
    const lunar = fullLunarText(cell.date);
    return `<div class="cal-day${cell.out?' out':''}${cell.today?' today':''}${selectedDate===cell.key?' selected':''}" data-date="${cell.key}" data-lunar="${esc(lunar)}" title="${esc(lunar)}"><span class="cal-num">${cell.date.getDate()}</span>${showLunar?`<span class="cal-lunar">${esc(cell.label)}</span>`:''}${dayTasks[0]?`<span class="cal-task-label">${esc(dayTasks[0].text)}</span>`:''}${dayTasks.length?`<span class="cal-dots">${'<i></i>'.repeat(Math.min(3,dayTasks.length))}</span>`:''}</div>`;
  }).join('');
}
function desktopClockCalendarCells(data) {
  const specialLabels = new Set(['元旦','春节','元宵','劳动节','青年节','端午','中秋','国庆节']);
  return data.cells.map((cell)=>{
    const lunar = fullLunarText(cell.date);
    const special = !cell.out && specialLabels.has(cell.label);
    return `<div class="desk-cal-day${cell.out?' out':''}${cell.today?' today':''}${selectedDate===cell.key?' selected':''}" data-date="${cell.key}" data-lunar="${esc(lunar)}" title="${esc(lunar)}"><span>${cell.date.getDate()}</span>${special?`<i title="${esc(cell.label)}">★</i>`:''}</div>`;
  }).join('');
}
function monthHeader(data, compact = false, lunarToggle = false) {
  const title = `${data.focus.getFullYear()}年${data.focus.getMonth()+1}月`;
  if (!compact) return `<div class="month-head"><h3>${title}</h3><div class="month-nav"><button data-action="month-prev">上月</button><button data-action="month-today">今天</button><button data-action="month-next">下月</button></div></div>`;
  return `<div class="month-head compact"><h3>${title}</h3><div class="month-nav">${lunarToggle?`<button class="lunar-switch${cfg.showLunar!==false?' active':''}" data-action="lunar-toggle" title="${cfg.showLunar!==false?'隐藏农历':'显示农历'}">农</button>`:''}<button data-action="month-prev" title="上月">‹</button><button data-action="month-today" title="回到今天">今</button><button data-action="month-next" title="下月">›</button></div></div>`;
}

function renderPlanner() {
  const data=monthData();
  const selected=parseDate(selectedDate);
  const tasks=(cfg.tasks||[]).filter((task)=>task.date===selectedDate);
  content.innerHTML=`<div class="planner">
    <aside class="planner-side"><span class="eyebrow">待办 · 完成</span><div><h2>${selected.getMonth()+1}月${selected.getDate()}日</h2><div class="planner-date">${WEEK[selected.getDay()]} · ${esc(lunarOrHoliday(selected,{}))}</div></div>
      <div class="planner-tasks">${tasks.length?tasks.map((task)=>`<div class="planner-task${task.done?' done':''}" data-action="task-toggle" data-id="${task.id}"><div><div class="task-name ellipsis">${esc(task.text)}</div><div class="task-meta">${task.done?'已完成':'待完成'} · ${task.date}</div></div><span class="task-chip">${task.done?'完成':'待办'}</span></div>`).join(''):'<div class="empty">这一天还没有待办<br>在下方快速添加</div>'}</div>
      <div class="quick-add"><input id="plannerQuick" placeholder="输入待办，按回车添加"><button data-action="task-add">＋</button></div>
    </aside><section class="planner-main">${monthHeader(data)}<div class="weekday-row">${WEEK_SHORT.map((day)=>`<span>${day}</span>`).join('')}</div><div class="calendar-grid">${calendarCells(data,true)}</div></section>
  </div>`;
}

function renderQuadrants() {
  content.innerHTML=`<div class="quadrants">${cfg.quadrants.map((quad,index)=>`<section class="quadrant" style="--quad:${safeColor(quad.color,'#5caeff')}"><div class="quadrant-head"><div class="quadrant-title"><span>${esc(quad.title)}</span><span>${(quad.tasks||[]).filter(t=>!t.done).length}</span></div><input class="quadrant-input" data-quad-input="${index}" placeholder="输入后回车添加新事项"></div><div class="quadrant-list">${(quad.tasks||[]).map((task)=>`<div class="quadrant-task${task.done?' done':''}" data-action="quad-toggle" data-q="${index}" data-id="${task.id}"><span class="ellipsis">${esc(task.text)}</span><button data-action="quad-delete" data-q="${index}" data-id="${task.id}">×</button></div>`).join('')}</div></section>`).join('')}</div>`;
}
function renderMiniCalendar() {
  const data=monthData();
  const terms=Object.entries(data.terms).map(([day,name])=>`${day}日 ${name}`).join(' · ');
  const selected=parseDate(selectedDate);
  content.innerHTML=`<div class="mini-calendar">${monthHeader(data,true,true)}<div class="weekday-row">${WEEK_SHORT.map((d)=>`<span>${d}</span>`).join('')}</div><div class="calendar-grid">${calendarCells(data,false,cfg.showLunar!==false)}</div><div class="term-line"><span>${fullLunarText(selected)}</span><i>·</i><span>${terms||'本月节气加载中'}</span></div></div>`;
}
function renderClockCalendar() {
  const data=monthData();
  content.innerHTML=`<div class="desktop-clock-widget is-complete">
    <header class="desktop-clock-title"><span class="desktop-clock-star">☆</span><span>— 桌面时钟日历 —</span><span aria-hidden="true"></span></header>
    <section class="desktop-clock-readout">
      <div class="desktop-clock-time"><span id="comboTime">--:--:--</span><small id="comboSuffix"></small></div>
      <div class="desktop-clock-date"><span class="desktop-clock-mark">▣</span><span id="comboDate"></span></div>
      <div class="desktop-clock-lunar" id="comboLunar"></div>
    </section>
    <div class="desktop-clock-divider"></div>
    <section class="desktop-month-calendar">
      <div class="desktop-weekdays">${WEEK_SHORT.map((d)=>`<span>${d}</span>`).join('')}</div>
      <div class="desktop-calendar-grid">${desktopClockCalendarCells(data)}</div>
    </section>
  </div>`;
  paintClock();
}
function renderFlip() {
  content.innerHTML=`<div class="flip-clock"><div class="flip-row" id="flipRow"></div><div class="clock-caption">FLIP CLOCK · ${WEEK[new Date().getDay()]}</div></div>`;
  paintClock();
}
function renderAnalog() {
  let ticks='',nums='';
  for(let i=0;i<60;i++){const a=i*6*Math.PI/180,outer=47,inner=i%5===0?42:44.5;const x1=50+inner*Math.sin(a),y1=50-inner*Math.cos(a),x2=50+outer*Math.sin(a),y2=50-outer*Math.cos(a);ticks+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="tick${i%5===0?' major':''}"/>`;}
  for(let n=1;n<=12;n++){const a=n*30*Math.PI/180,x=50+36.5*Math.sin(a),y=50-36.5*Math.cos(a)+1.7;nums+=`<text class="dial-num" x="${x}" y="${y}" text-anchor="middle">${n}</text>`;}
  content.innerHTML=`<div class="analog"><svg class="dial" viewBox="0 0 100 100">${ticks}${nums}<line class="hand hour-hand" id="hourHand" x1="50" y1="50" x2="50" y2="28"/><line class="hand minute-hand" id="minuteHand" x1="50" y1="50" x2="50" y2="18"/><line class="hand second-hand" id="secondHand" x1="50" y1="55" x2="50" y2="15"/><circle class="pin" cx="50" cy="50" r="3.2"/></svg></div>`;
  paintClock();
}
function renderDigital() {
  content.innerHTML=`<div class="desktop-clock-widget is-compact">
    <header class="desktop-clock-title"><span class="desktop-clock-star">☆</span><span>— 桌面时钟日历 —</span><span aria-hidden="true"></span></header>
    <section class="desktop-clock-readout">
      <div class="desktop-clock-time"><span id="digitalTime">--:--:--</span><small id="digitalSuffix"></small></div>
      <div class="desktop-clock-date"><span class="desktop-clock-mark">▣</span><span id="digitalDate"></span></div>
      <div class="desktop-clock-lunar" id="digitalLunar"></div>
    </section>
  </div>`;
  paintClock();
}
function paintClock() {
  const now=new Date();
  let hour=now.getHours();
  const suffix=cfg.hour12?(hour>=12?' 下午':' 上午'):'';
  if(cfg.hour12) hour=hour%12||12;
  const pieces=[pad(hour),pad(now.getMinutes())]; if(cfg.showSeconds!==false) pieces.push(pad(now.getSeconds()));
  if(widgetId==='flipClock'){
    const value=pieces.join(':');
    if(value===lastFlip)return;
    const previous=lastFlip?lastFlip.split(':'):[];
    const groups=pieces.map((piece,g)=>`<span class="flip-group${g===2?' seconds-group':''}">${piece.split('').map((digit,i)=>{const old=previous[g]&&previous[g][i]||digit,animate=g===2&&old!==digit;return `<span class="flip-digit${animate?' flip':''}" data-old="${old}"><span>${digit}</span><i></i></span>`;}).join('')}</span>${g<pieces.length-1?`<span class="colon${g===1?' seconds-colon':''}">:</span>`:''}`).join('');
    lastFlip=value;
    const row=get('flipRow'); if(row)row.innerHTML=groups;
  } else if(widgetId==='digitalClockGlass'){
    const node=get('digitalTime'); if(node)node.textContent=pieces.join(':');
    const suffixNode=get('digitalSuffix'); if(suffixNode)suffixNode.textContent=suffix.trim();
    const date=get('digitalDate'); if(date)date.textContent=`${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
    const lunar=get('digitalLunar'); if(lunar){lunar.textContent=fullLunarText(now);lunar.hidden=cfg.showLunar===false;}
  } else if(widgetId==='clockCalendar'){
    const node=get('comboTime'); if(node)node.textContent=pieces.join(':');
    const suffixNode=get('comboSuffix'); if(suffixNode)suffixNode.textContent=suffix.trim();
    const date=get('comboDate'); if(date)date.textContent=`${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
    const lunar=get('comboLunar'); if(lunar){lunar.textContent=fullLunarText(now);lunar.hidden=cfg.showLunar===false;}
  } else if(widgetId==='analogClock'){
    const sec=now.getSeconds()+now.getMilliseconds()/1000,min=now.getMinutes()+sec/60,h=now.getHours()%12+min/60;
    if(get('secondHand'))get('secondHand').setAttribute('transform',`rotate(${sec*6} 50 50)`);
    if(get('minuteHand'))get('minuteHand').setAttribute('transform',`rotate(${min*6} 50 50)`);
    if(get('hourHand'))get('hourHand').setAttribute('transform',`rotate(${h*30} 50 50)`);
  }
}

function nextOccurrence(item, from = new Date()) {
  const base=dayStart(from); let target=null;
  if(item.kind==='weekly'){
    const wanted=number(item.weekday,6,0,6); let diff=(wanted-base.getDay()+7)%7; if(diff===0&&from>base)diff=7;
    target=new Date(base.getFullYear(),base.getMonth(),base.getDate()+diff);
  } else if(item.kind==='monthly'){
    const day=number(item.day,1,1,31); target=new Date(base.getFullYear(),base.getMonth(),Math.min(day,new Date(base.getFullYear(),base.getMonth()+1,0).getDate()));
    if(target<base)target=new Date(base.getFullYear(),base.getMonth()+1,Math.min(day,new Date(base.getFullYear(),base.getMonth()+2,0).getDate()));
  } else if(item.kind==='lunar'){
    for(let i=0;i<430;i++){const candidate=new Date(base.getFullYear(),base.getMonth(),base.getDate()+i);const l=lunarInfo(candidate);if(l.lMonth===number(item.month,1)&&l.lDay===number(item.day,1)){target=candidate;break;}}
  } else {
    target=new Date(base.getFullYear(),number(item.month,1)-1,number(item.day,1)); if(target<base)target=new Date(base.getFullYear()+1,number(item.month,1)-1,number(item.day,1));
  }
  return target||base;
}
function durationText(target) {
  let seconds=Math.max(0,Math.floor((target-Date.now())/1000));
  const days=Math.floor(seconds/86400); seconds%=86400; const hours=Math.floor(seconds/3600); seconds%=3600; const minutes=Math.floor(seconds/60); seconds%=60;
  return `${days} 天 ${hours} 时 ${minutes} 分 ${seconds} 秒`;
}
function renderCycles() {
  content.innerHTML=`<div class="list-widget"><div class="list-head"><div><h3>周期倒数日</h3><p>自动滚动到下一次周期 · 精确到秒</p></div><button class="icon-btn" data-action="open-editor">＋</button></div><div class="scroll-list">${(cfg.cycles||[]).map((item)=>`<div class="cycle-row"><div class="cycle-name">${esc(item.name)}</div><div class="cycle-time" data-cycle="${item.id}">${durationText(nextOccurrence(item))}</div></div>`).join('')||'<div class="empty">还没有周期目标</div>'}</div></div>`;
}
function paintCycles(){(cfg.cycles||[]).forEach((item)=>{const node=content.querySelector(`[data-cycle="${CSS.escape(item.id)}"]`);if(node)node.textContent=durationText(nextOccurrence(item));});}

function fileIcon(type){return icon({folder:'folder',image:'image',document:'document',sheet:'sheet',archive:'archive',media:'media',text:'text',file:'file'}[type]||'file');}
const FOLDER_SORTS=[
  {value:'name-asc',icon:'nameSort',label:'名称 A—Z'},{value:'name-desc',icon:'nameSort',label:'名称 Z—A'},
  {value:'date-desc',icon:'dateSort',label:'最新修改'},{value:'date-asc',icon:'dateSort',label:'最早修改'},
  {value:'type-asc',icon:'typeSort',label:'文件类型'},{value:'size-desc',icon:'sizeSort',label:'文件大小'},
];
function sortFolderItems(items){
  const mode=String(cfg.folderSort||'name-asc'),[key,direction]=mode.split('-'),sign=direction==='desc'?-1:1;
  return [...items].sort((a,b)=>{
    const folderOrder=Number(b.isDirectory)-Number(a.isDirectory);if(folderOrder)return folderOrder;
    let result=0;
    if(key==='date')result=number(a.modifiedAt,0)-number(b.modifiedAt,0);
    else if(key==='size')result=number(a.size,0)-number(b.size,0);
    else if(key==='type')result=String(a.type||'').localeCompare(String(b.type||''),'zh-CN');
    else result=String(a.name||'').localeCompare(String(b.name||''),'zh-CN',{numeric:true,sensitivity:'base'});
    return result*sign||String(a.name||'').localeCompare(String(b.name||''),'zh-CN',{numeric:true,sensitivity:'base'});
  });
}
function folderPanelHtml(){
  if(!folderPanel)return '';
  const item=folderPanel.item||{};
  if(folderPanel.type==='menu')return `<div class="folder-panel"><div class="folder-panel-head"><div><small>项目操作</small><strong>${esc(item.name||'')}</strong></div><button data-action="folder-panel-close">×</button></div><div class="folder-panel-actions"><button data-action="file-open-system">${icon('external')}<span>用 Windows 打开</span></button><button data-action="file-rename">${icon('edit')}<span>重命名</span></button><button class="danger" data-action="file-trash">${icon('trash')}<span>移至回收站</span></button></div></div>`;
  const create=folderPanel.type==='create';
  return `<div class="folder-panel"><div class="folder-panel-head"><div><small>${create?'新建内容':'修改名称'}</small><strong>${create?'新建文件夹':esc(item.name||'')}</strong></div><button data-action="folder-panel-close">×</button></div><div class="folder-name-editor"><input id="folderNameInput" value="${create?'新建文件夹':esc(item.name||'')}" maxlength="120" placeholder="输入名称"><button class="primary" data-action="${create?'folder-create-submit':'file-rename-submit'}">确认</button></div><p>名称不能包含 &lt; &gt; : " / \\ | ? * 等字符</p></div>`;
}
function folderSortHtml(){
  if(!folderSortOpen)return '';
  return `<div class="folder-sort-popover">${FOLDER_SORTS.map((option)=>`<button class="${option.value===(cfg.folderSort||'name-asc')?'active':''}" data-action="folder-sort-apply" data-value="${option.value}">${icon(option.icon)}<span>${option.label}</span><i>${option.value===(cfg.folderSort||'name-asc')?'✓':''}</i></button>`).join('')}</div>`;
}
function renderFolder(){
  visibleFolderItems=folderData&&folderData.ok?sortFolderItems(folderData.items.filter((item)=>!folderQuery||item.name.toLowerCase().includes(folderQuery.toLowerCase()))):[];
  const items=visibleFolderItems;
  const currentPath=(folderData&&folderData.folder)||cfg.folder||'尚未选择文件夹';
  const locationLabel=folderData&&folderData.relative?`所选文件夹  /  ${folderData.relative.split(/[\\/]/).join('  /  ')}`:'所选文件夹';
  content.innerHTML=`<div class="list-widget folder-widget"><div class="folder-header"><div class="list-head"><div class="folder-heading"><span class="eyebrow">${esc(locationLabel)}</span><h3>桌面文件夹</h3><p class="folder-path" title="${esc(currentPath)}">${esc(currentPath)}</p></div><div class="folder-tools">${folderData&&folderData.canGoBack?`<button class="icon-btn" data-action="folder-back" title="返回上一级">${icon('back')}</button>`:''}<button class="icon-btn" data-action="folder-open-current" title="在资源管理器中打开">${icon('external')}</button><button class="icon-btn" data-action="folder-refresh" title="刷新">${icon('refresh')}</button><button class="icon-btn" data-action="folder-choose" title="更换文件夹">${icon('choose')}</button></div></div><div class="folder-command-row"><div class="folder-search-wrap">${icon('search')}<input class="folder-search" id="folderSearch" value="${esc(folderQuery)}" placeholder="搜索当前文件夹"></div><button class="folder-sort" data-action="folder-sort-toggle" title="选择排序方式">${icon('sort')}<span>排序</span>${icon('chevron')}</button><button class="folder-create" data-action="folder-create" title="新建文件夹">${icon('newFolder')}<span>新建</span></button>${folderSortHtml()}</div><div class="folder-count">当前显示 ${items.length} 项 · 单击打开，更多操作点右侧按钮</div></div><div class="scroll-list folder-list">${items.map((item,index)=>`<div class="file-row" data-action="file-open" data-index="${index}" tabindex="0" title="${item.isDirectory?'单击进入文件夹':'单击用默认程序打开'}"><span class="file-icon ${item.type}">${fileIcon(item.type)}</span><span class="file-copy"><strong class="file-name">${esc(item.name)}</strong><small>${item.isDirectory?'文件夹':formatBytes(item.size)||'文件'}</small></span><button class="file-open-btn" data-action="file-more" data-index="${index}" title="更多操作">${icon('more')}</button></div>`).join('')||(folderData&&folderData.message?`<div class="empty">${esc(folderData.message)}<br>右键打开设置选择文件夹</div>`:'<div class="empty">这个文件夹是空的<br>点击“新建”创建文件夹</div>')}</div>${folderPanelHtml()}</div>`;
  if(folderPanel&&(folderPanel.type==='create'||folderPanel.type==='rename'))setTimeout(()=>{const input=get('folderNameInput');if(input){input.focus();input.select();}},0);
}
function formatBytes(bytes){if(!bytes)return '';if(bytes<1024)return bytes+' B';if(bytes<1048576)return Math.round(bytes/1024)+' KB';return (bytes/1048576).toFixed(1)+' MB';}
async function loadFolder(requestedFolder=folderCurrent){
  if(preview){folderData={ok:true,folder:'桌面文件',items:[{name:'历代版本',type:'folder',isDirectory:true,size:0,path:''},{name:'工作报告.txt',type:'text',size:12500,path:''},{name:'开发需求.xlsx',type:'sheet',size:42500,path:''},{name:'桌面壁纸.jpg',type:'image',size:2400000,path:''},{name:'版本功能.zip',type:'archive',size:960000,path:''}]};renderFolder();return;}
  folderData=await ipcRenderer.invoke('studio:folder-list:'+instId,requestedFolder||'');
  if(folderData&&folderData.ok){folderCurrent=folderData.folder;folderPanel=null;}
  else if(folderData&&folderData.message)showToast(folderData.message);
  renderFolder();
}
async function openFolderItem(item,forceSystem=false){
  if(!item||preview)return;
  if(item.isDirectory&&!forceSystem){folderQuery='';await loadFolder(item.path);return;}
  const result=await ipcRenderer.invoke('studio:open-path:'+instId,item.path);
  if(result&&!result.ok)showToast(result.message||'无法打开该项目');
}
async function createFolder(){
  const input=get('folderNameInput'),name=input&&input.value.trim();if(!name)return showToast('请输入文件夹名称');
  const result=await ipcRenderer.invoke('studio:create-folder:'+instId,folderCurrent||cfg.folder,name);
  if(result&&result.ok){folderPanel=null;showToast('文件夹已创建');await loadFolder();}else showToast(result&&result.message||'新建文件夹失败');
}
async function renameFolderItem(){
  const item=folderPanel&&folderPanel.item,input=get('folderNameInput'),name=input&&input.value.trim();if(!item||!name)return showToast('请输入新名称');
  const result=await ipcRenderer.invoke('studio:rename-path:'+instId,item.path,name);
  if(result&&result.ok){folderPanel=null;showToast('名称已更新');await loadFolder();}else showToast(result&&result.message||'重命名失败');
}
async function trashFolderItem(){
  const item=folderPanel&&folderPanel.item;if(!item)return;
  const result=await ipcRenderer.invoke('studio:trash-path:'+instId,item.path);
  if(result&&result.ok){folderPanel=null;showToast('已移至回收站');await loadFolder();}else if(result&&!result.canceled)showToast(result.message||'无法移至回收站');
}

function activePage(){return (cfg.pages||[]).find((page)=>page.id===cfg.activePage)||(cfg.pages||[])[0];}
function renderSticky(){const page=activePage();const text=page?page.text:'';content.innerHTML=`<div class="sticky"><div class="sticky-top"><span>字数 ${text.length} / 10000</span><button class="icon-btn" data-action="sticky-add">＋</button></div><div class="sticky-tabs">${(cfg.pages||[]).map((p)=>`<button class="sticky-tab${p.id===cfg.activePage?' active':''}" data-action="sticky-page" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div><textarea id="stickyText" maxlength="10000" placeholder="写下此刻需要记住的事情……">${esc(text)}</textarea></div>`;}

function sampleWeather(){const d=new Date();return {ok:true,city:'北京',automatic:true,updatedAt:Date.now()-120000,days:[0,1,2,3].map((n)=>({date:dateKey(new Date(d.getFullYear(),d.getMonth(),d.getDate()+n)),code:n===3?61:2,high:24-n,low:13+(n===2?2:0)}))};}
function renderWeather(){
  const data=weatherData&&weatherData.ok?weatherData:sampleWeather(); const all=data.days.flatMap((d)=>[d.high,d.low]); const max=Math.max(...all)+2,min=Math.min(...all)-2,range=Math.max(1,max-min);
  const points=(key)=>data.days.map((d,i)=>`${10+i*26.66},${12+(max-d[key])/range*64}`).join(' ');
  const labels=(key,low=false)=>data.days.map((d,i)=>{const y=12+(max-d[key])/range*64;return `<span class="weather-label${low?' low':''}" style="left:${10+i*26.66}%;top:${y}%">${d[key]}°</span>`;}).join('');
  content.innerHTML=`<div class="weather-line"><div class="weather-status"><span>更新于 ${data.updatedAt?Math.max(0,Math.round((Date.now()-data.updatedAt)/60000))+' 分钟前':'刚刚'} · ${esc(data.city||cfg.city)}${data.automatic?' · 自动定位':''}</span><button class="icon-btn" data-action="weather-refresh">↻</button></div><div class="weather-days">${data.days.map((day,i)=>{const date=parseDate(day.date);const info=WMO[day.code]||['◌','未知'];return `<div class="weather-day"><strong>${pad(date.getMonth()+1)}/${pad(date.getDate())}</strong><span>${i===0?'今天':WEEK[date.getDay()].replace('星期','周')}</span><span class="weather-icon">${info[0]}</span></div>`;}).join('')}</div><div class="weather-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${points('high')}" fill="none" stroke="currentColor" stroke-width="1.2" vector-effect="non-scaling-stroke"/>${data.days.map((d,i)=>{const y=12+(max-d.high)/range*64;return `<circle cx="${10+i*26.66}" cy="${y}" r="1.7" fill="currentColor"/>`;}).join('')}<polyline points="${points('low')}" fill="none" stroke="currentColor" stroke-opacity=".72" stroke-width="1.2" vector-effect="non-scaling-stroke"/>${data.days.map((d,i)=>{const y=12+(max-d.low)/range*64;return `<circle cx="${10+i*26.66}" cy="${y}" r="1.7" fill="currentColor"/>`;}).join('')}</svg>${labels('high')}${labels('low',true)}</div></div>`;
}
async function loadWeather(){if(preview){weatherData=sampleWeather();renderWeather();return;}content.innerHTML='<div class="empty">正在定位并获取四日天气……</div>';weatherData=await ipcRenderer.invoke('studio:weather:'+instId,{city:cfg.city||'北京',autoLocation:cfg.autoLocation!==false});if(!weatherData.ok)showToast(weatherData.message||'天气加载失败');renderWeather();}

function renderSchedule(){
  const now=new Date(),date=new Date(now.getFullYear(),now.getMonth(),now.getDate()+scheduleOffset),key=dateKey(date); const list=(cfg.events||[]).filter((event)=>event.date===key).sort((a,b)=>String(a.time||'').localeCompare(String(b.time||'')));
  content.innerHTML=`<div class="list-widget"><div class="list-head"><div><h3>${scheduleOffset===0?'今天':scheduleOffset===1?'一天后':scheduleOffset===-1?'昨天':Math.abs(scheduleOffset)+'天'+(scheduleOffset>0?'后':'前')} · ${WEEK[date.getDay()].replace('星期','周')}</h3><p>${key} · ${lunarOrHoliday(date,{})}</p></div><div class="month-nav"><button data-action="schedule-prev">‹</button><button data-action="schedule-next">›</button><button data-action="open-editor">＋</button></div></div><div class="scroll-list">${list.map((event,index)=>`<div class="schedule-row"><strong class="ellipsis">${index+1}. ${esc(event.title)}</strong><span class="schedule-place ellipsis">${esc(event.place||event.time||'')}</span><span class="schedule-note">${esc(event.note||'')}</span></div>`).join('')||'<div class="empty">这一天没有日程<br>点击右上角添加</div>'}</div></div>`;
}

function markdown(text){
  const escaped=esc(text); const lines=escaped.split(/\r?\n/); let inList=false,out='';
  for(let line of lines){
    if(/^###\s+/.test(line)){if(inList){out+='</ul>';inList=false;}out+='<h3>'+inlineMd(line.replace(/^###\s+/,''))+'</h3>';}
    else if(/^##\s+/.test(line)){if(inList){out+='</ul>';inList=false;}out+='<h2>'+inlineMd(line.replace(/^##\s+/,''))+'</h2>';}
    else if(/^#\s+/.test(line)){if(inList){out+='</ul>';inList=false;}out+='<h1>'+inlineMd(line.replace(/^#\s+/,''))+'</h1>';}
    else if(/^&gt;\s+/.test(line)){if(inList){out+='</ul>';inList=false;}out+='<blockquote>'+inlineMd(line.replace(/^&gt;\s+/,''))+'</blockquote>';}
    else if(/^[-*]\s+/.test(line)){if(!inList){out+='<ul>';inList=true;}out+='<li>'+inlineMd(line.replace(/^[-*]\s+/,''))+'</li>';}
    else {if(inList){out+='</ul>';inList=false;}out+=line?'<p>'+inlineMd(line)+'</p>':'<br>';}
  }
  if(inList)out+='</ul>';return out;
}
function inlineMd(text){return text.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/~~(.+?)~~/g,'<s>$1</s>').replace(/`(.+?)`/g,'<code>$1</code>').replace(/^\[x\]\s*/i,'☑ ').replace(/^\[ \]\s*/,'☐ ');}
function renderMarkdown(){content.innerHTML=`<div class="markdown"><div class="md-toolbar"><span>修改于：刚刚 · ${cfg.text.length} 字</span><div><button class="icon-btn" data-action="md-toggle">${markdownPreview?'✎':'◉'}</button></div></div><h3 class="md-title">${esc(cfg.title||'Markdown 桌面笔记')}</h3><div class="md-area">${markdownPreview?`<div class="md-render">${markdown(cfg.text||'')}</div>`:`<textarea id="mdText" placeholder="使用 Markdown 开始记录……">${esc(cfg.text||'')}</textarea>`}</div></div>`;}

function renderCounters(){content.innerHTML=`<div class="list-widget"><div class="list-head"><div><h3>桌面计数器</h3><p>点击即可记录，数据自动保存</p></div><button class="icon-btn" data-action="open-editor">⚙</button></div><div class="scroll-list">${(cfg.counters||[]).map((item)=>`<div class="counter-row"><div class="counter-title"><span>${esc(item.name)}</span><strong>${number(item.value,0)}</strong></div><div class="counter-actions"><button data-action="counter-reset" data-id="${item.id}">↻</button><button data-action="counter-add" data-id="${item.id}">＋1</button><button data-action="counter-sub" data-id="${item.id}">－1</button></div></div>`).join('')}</div></div>`;}

function timeMinutes(value){const parts=String(value||'00:00').split(':').map(Number);return (parts[0]||0)*60+(parts[1]||0);}
function renderClasses(){
  const now=new Date(),weekday=now.getDay(),minutes=now.getHours()*60+now.getMinutes(); const courses=(cfg.courses||[]).filter(c=>Number(c.weekday)===weekday).sort((a,b)=>timeMinutes(a.start)-timeMinutes(b.start));
  let current=null;courses.forEach(c=>{if(minutes>=timeMinutes(c.start)&&minutes<timeMinutes(c.end))current=c;});
  const next=courses.find(c=>minutes<timeMinutes(c.start));
  content.innerHTML=`<div class="list-widget"><div class="list-head"><div><h3>${WEEK[weekday]} ${now.getMonth()+1}月${now.getDate()}日</h3><p>${current?timeMinutes(current.end)-minutes+' 分钟后下课':next?next.start+' 上课':'今日课程已结束'}</p></div><button class="icon-btn" data-action="open-editor">＋</button></div><div class="scroll-list">${courses.map((course)=>`<div class="schedule-row${current&&current.id===course.id?' current':''}"><strong>${esc(course.name)}</strong><span>${esc(course.start)}-${esc(course.end)}</span><span class="schedule-note">${current&&current.id===course.id?'进行中…':esc(course.place||'')}</span></div>`).join('')||'<div class="empty">今天没有课程<br>点击右上角添加课程</div>'}</div></div>`;
}
function autoProgress(){
  const now=new Date(),yearStart=new Date(now.getFullYear(),0,1),yearEnd=new Date(now.getFullYear()+1,0,1),monthStart=new Date(now.getFullYear(),now.getMonth(),1),monthEnd=new Date(now.getFullYear(),now.getMonth()+1,1);
  const monday=new Date(now);monday.setDate(now.getDate()-((now.getDay()+6)%7));monday.setHours(0,0,0,0);const weekEnd=new Date(monday);weekEnd.setDate(monday.getDate()+7);
  const dayStartTime=new Date(now.getFullYear(),now.getMonth(),now.getDate()),dayEnd=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  const pct=(a,b)=>Math.max(0,Math.min(100,(now-a)/(b-a)*100));
  const dayOfYear=Math.floor((dayStartTime-yearStart)/86400000)+1;
  return [{name:`${now.getFullYear()}年第${dayOfYear}天，年进度`,value:pct(yearStart,yearEnd)},{name:`今年第${now.getMonth()+1}个月，本月进度`,value:pct(monthStart,monthEnd)},{name:`本周进度`,value:pct(monday,weekEnd)},{name:'今天进度',value:pct(dayStartTime,dayEnd)}];
}
function renderProgress(){const rows=[...autoProgress(),...(cfg.progresses||[])];content.innerHTML=`<div class="list-widget"><div class="list-head"><div><h3>进度提醒</h3><p>把时间与目标变成看得见的刻度</p></div><button class="icon-btn" data-action="open-editor">＋</button></div><div class="scroll-list">${rows.map((item)=>`<div class="progress-row"><div class="progress-copy"><span class="ellipsis">${esc(item.name)}</span><strong>${Math.round(number(item.value,0,0,100))}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${number(item.value,0,0,100)}%"></div></div></div>`).join('')}</div></div>`;}

function pomoRemaining(){if(cfg.mode==='stopwatch')return number(cfg.stopwatchSeconds,0,0,1e8)+(cfg.running?Math.floor((Date.now()-number(cfg.startedAt,Date.now()))/1000):0);if(cfg.running&&cfg.endAt)return Math.max(0,Math.ceil((cfg.endAt-Date.now())/1000));return number(cfg.remaining,number(cfg.focusMin,25)*60,0,86400);}
function renderPomodoro(){const sec=pomoRemaining();content.innerHTML=`<div class="pomodoro-simple"><div class="mode-tabs"><button class="${cfg.mode!=='stopwatch'?'active':''}" data-action="pomo-mode" data-mode="pomodoro">番茄钟</button><button class="${cfg.mode==='stopwatch'?'active':''}" data-action="pomo-mode" data-mode="stopwatch">秒表</button></div><div class="timer-value" id="timerValue">${formatTimer(sec)}</div><div class="timer-controls"><button class="primary" data-action="pomo-toggle">${cfg.running?'Ⅱ':'▶'}</button><button data-action="pomo-reset">↻</button><button data-action="open-editor">⚙</button></div><div class="timer-focus">专注于：${esc(cfg.focusLabel||'未设置')}</div></div>`;}
function formatTimer(seconds){seconds=Math.max(0,Math.floor(seconds));const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return h>0?`${pad(h)}:${pad(m)}:${pad(s)}`:`${pad(m)}:${pad(s)}`;}
function paintPomodoro(){const sec=pomoRemaining(),node=get('timerValue');if(node)node.textContent=formatTimer(sec);if(cfg.mode!=='stopwatch'&&cfg.running&&sec<=0){cfg.running=false;cfg.remaining=number(cfg.breakMin,5)*60;cfg.endAt=0;const key=dateKey(new Date());cfg.sessions[key]=number(cfg.sessions[key],0)+1;save();renderPomodoro();showToast('本轮专注完成，休息一下吧');}}

function notifyUser(title,body,options={}){
  if(preview)return;
  ipcRenderer.send('studio:notify:'+instId,{title,body,...options});
}
function timerRemaining(){return cfg.running&&cfg.endAt?Math.max(0,Math.ceil((cfg.endAt-Date.now())/1000)):number(cfg.remaining,number(cfg.selectedMinutes,25)*60,0,2592000);}
function formatDurationTimer(seconds){seconds=Math.max(0,Math.floor(seconds));const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return `${pad(h)}:${pad(m)}:${pad(s)}`;}
function renderDurationTimer(){
  const remaining=timerRemaining();
  const selectedSeconds=number(cfg.selectedMinutes,25)*60;
  const state=cfg.running?'正在倒计时':remaining===0?'本轮已完成':remaining<selectedSeconds?'已暂停':'准备开始';
  const toggleText=cfg.running?'暂停':remaining<selectedSeconds&&remaining>0?'继续':'开始';
  content.innerHTML=`<div class="duration-timer">
    <header class="duration-titlebar">
      <div class="duration-title-copy"><strong>倒计时工具</strong><small>${esc(cfg.label||'当前任务')}</small></div>
      <div class="duration-tools">
        <label class="duration-preset" title="选择倒计时时长">${icon('timer')}<select id="durationPresetSelect">${(cfg.presets||[]).slice(0,6).map((minutes)=>`<option value="${number(minutes,25,1,720)}"${number(minutes,0)===number(cfg.selectedMinutes,0)?' selected':''}>${minutes} 分钟</option>`).join('')}</select></label>
        <button class="duration-tool${cfg.loop?' active':''}" data-action="timer-loop" title="${cfg.loop?'关闭循环':'开启循环'}">${icon('loop')}</button>
        <button class="duration-tool" data-action="open-editor" title="倒计时设置">${icon('settings')}</button>
        <button class="duration-tool info-tool" data-action="timer-info" title="使用说明">${icon('info')}</button>
      </div>
    </header>
    <section class="duration-workspace">
      <div class="duration-value" id="durationValue">${formatDurationTimer(remaining)}</div>
      <div class="duration-actions"><button class="duration-toggle" data-action="timer-toggle">${toggleText}</button><button class="duration-stop" data-action="timer-reset">停止</button></div>
      <div class="duration-state"><span id="durationState">${state}</span><i>·</i><span>${cfg.loop?'循环已开启':'单次倒计时'}</span></div>
    </section>
  </div>`;
}
function finishDurationTimer(){
  const finishedMinutes=number(cfg.selectedMinutes,25,1,720);
  cfg.history=[{at:Date.now(),minutes:finishedMinutes,label:cfg.label||'当前任务'},...(cfg.history||[])].slice(0,12);
  if(cfg.notify!==false)notifyUser('倒计时完成',`${cfg.label||'当前任务'} · ${finishedMinutes} 分钟`);
  if(cfg.loop){cfg.running=true;cfg.remaining=finishedMinutes*60;cfg.endAt=Date.now()+cfg.remaining*1000;}
  else {cfg.running=false;cfg.remaining=0;cfg.endAt=0;}
  save();renderDurationTimer();
}
function paintDurationTimer(){
  const remaining=timerRemaining(),node=get('durationValue'),state=get('durationState');
  if(node)node.textContent=formatDurationTimer(remaining);
  if(state)state.textContent=cfg.running?'正在倒计时':remaining===0?'本轮已完成':remaining<number(cfg.selectedMinutes,25)*60?'已暂停':'准备开始';
  if(cfg.running&&remaining<=0)finishDurationTimer();
}

function alarmSoundConfig(value=cfg.alarmSound){
  const sound={mode:'system',filePath:'',fileName:'',volume:.85,repeat:true,...(value&&typeof value==='object'?value:{})};
  if(!['system','custom','none'].includes(sound.mode))sound.mode='system';
  sound.volume=number(sound.volume,.85,0,1);sound.repeat=sound.repeat!==false;
  return sound;
}
function stopAlarmSound(){
  if(alarmAudio){try{alarmAudio.pause();alarmAudio.currentTime=0;}catch(_){}alarmAudio=null;}
  if(!preview)ipcRenderer.send('studio:alarm-system-stop:'+instId);
}
function startAlarmSound(){
  stopAlarmSound();
  const sound=alarmSoundConfig();
  if(preview||sound.mode==='none')return;
  if(sound.mode==='custom'&&sound.filePath){
    let fellBack=false;
    const fallback=()=>{if(fellBack)return;fellBack=true;if(alarmAudio){try{alarmAudio.pause();}catch(_){}alarmAudio=null;}ipcRenderer.send('studio:alarm-system-start:'+instId,{repeat:sound.repeat});};
    try{
      const audio=new Audio(pathToFileURL(sound.filePath).href);alarmAudio=audio;audio.loop=sound.repeat;audio.volume=sound.volume;
      audio.addEventListener('error',fallback,{once:true});
      const playing=audio.play();if(playing&&typeof playing.catch==='function')playing.catch(fallback);
      return;
    }catch(_){fallback();return;}
  }
  ipcRenderer.send('studio:alarm-system-start:'+instId,{repeat:sound.repeat});
}
function startNextQueuedAlarm(){
  if(cfg.ringingId)return;
  while(alarmQueue.length){
    const queued=alarmQueue.shift(),alarm=(cfg.alarms||[]).find((item)=>item.id===queued.id);
    if(alarm){fireAlarm(alarm,queued.key,true);return;}
  }
}

function alarmRepeatText(alarm){
  const repeat=Array.isArray(alarm.repeat)?alarm.repeat:[];
  if(!repeat.length)return '仅一次';
  if(repeat.length===7)return '每天';
  if(repeat.join(',')==='1,2,3,4,5')return '工作日';
  if(repeat.join(',')==='0,6')return '周末';
  return repeat.map((day)=>WEEK_SHORT[day]).join('、');
}
function alarmTarget(alarm,from=new Date()){
  if(alarm.snoozeUntil&&number(alarm.snoozeUntil,0)>from.getTime())return new Date(number(alarm.snoozeUntil,0));
  const [hour,minute]=String(alarm.time||'07:30').split(':').map(Number),repeat=Array.isArray(alarm.repeat)?alarm.repeat:[];
  for(let offset=0;offset<8;offset++){
    const target=new Date(from.getFullYear(),from.getMonth(),from.getDate()+offset,hour||0,minute||0,0,0);
    if(target<=from)continue;
    if(!repeat.length||repeat.includes(target.getDay()))return target;
  }
  return null;
}
function nextEnabledAlarm(){
  const now=Date.now();
  return (cfg.alarms||[]).filter((alarm)=>alarm.enabled||number(alarm.snoozeUntil,0)>now).map((alarm)=>({alarm,target:alarmTarget(alarm)})).filter((item)=>item.target).sort((a,b)=>a.target-b.target)[0]||null;
}
function nextAlarmText(){
  const next=nextEnabledAlarm();if(!next)return '没有启用的闹钟';
  const now=new Date(),target=next.target,delta=Math.round((dayStart(target)-dayStart(now))/86400000);
  const day=delta===0?'今天':delta===1?'明天':WEEK[target.getDay()];
  return `${day} ${pad(target.getHours())}:${pad(target.getMinutes())} · ${next.alarm.label||'闹钟'}`;
}
function renderAlarm(){
  const now=new Date(),ringing=(cfg.alarms||[]).find((alarm)=>alarm.id===cfg.ringingId)||(preview?(cfg.alarms||[])[0]:null);
  const snooze=number(cfg.snoozeMin,10,1,60),snoozeValues=[5,10,15,30];
  if(!snoozeValues.includes(snooze))snoozeValues.push(snooze);snoozeValues.sort((a,b)=>a-b);
  const alert=`<div class="alarm-dialog">
    <div class="alarm-alert-head"><span class="alarm-symbol">${icon('alarm')}</span><div><strong>闹钟</strong><small>${esc(ringing&&ringing.label||'时间到了')}</small><b>${esc(ringing&&ringing.time||`${pad(now.getHours())}:${pad(now.getMinutes())}`)}</b></div></div>
    <label class="alarm-snooze-select"><span>推迟时间</span><select id="alarmSnoozeSelect">${snoozeValues.map((minutes)=>`<option value="${minutes}"${minutes===snooze?' selected':''}>${minutes} 分钟</option>`).join('')}</select></label>
    <div class="alarm-alert-actions"><button class="alarm-delay" data-action="alarm-snooze">推迟</button><button class="alarm-cancel" data-action="alarm-dismiss">取消</button></div>
  </div>`;
  content.innerHTML=`<div class="alarm-widget${ringing?' is-ringing':''}">${ringing?alert:`
    <div class="alarm-idle-head"><span class="alarm-symbol">${icon('alarm')}</span><div><strong>闹钟</strong><div class="alarm-now" id="alarmNow">${pad(now.getHours())}:${pad(now.getMinutes())}<small>:${pad(now.getSeconds())}</small></div><p id="nextAlarm">${esc(nextAlarmText())}</p></div><button class="alarm-add" data-action="open-editor" title="添加或管理闹钟">＋</button></div>
    <div class="alarm-list">${(cfg.alarms||[]).slice(0,3).map((alarm)=>`<button class="alarm-row${alarm.enabled?' enabled':''}" data-action="alarm-toggle" data-id="${alarm.id}"><span>${esc(alarm.time||'--:--')}</span><i><strong>${esc(alarm.label||'闹钟')}</strong><small>${esc(alarmRepeatText(alarm))}</small></i><b>${alarm.enabled?'开':'关'}</b></button>`).join('')||'<div class="empty">还没有闹钟<br>点击右上角添加</div>'}</div>`}</div>`;
}
function fireAlarm(alarm,key,fromQueue=false){
  if(!fromQueue&&cfg.ringingId&&cfg.ringingId!==alarm.id){
    if(!alarmQueue.some((item)=>item.id===alarm.id&&item.key===key))alarmQueue.push({id:alarm.id,key});
    alarm.lastFiredKey=key;save();return;
  }
  alarm.lastFiredKey=key;
  if(!Array.isArray(alarm.repeat)||!alarm.repeat.length)alarm.enabled=false;
  cfg.ringingId=alarm.id;save();
  startAlarmSound();
  notifyUser(alarm.label||'Widgetly 闹钟',`${alarm.time||''} · 时间到了`,{soundHandled:true});
  renderAlarm();
}
function paintAlarm(){
  const now=new Date(),scanTo=now.getTime(),scanFrom=Math.max(lastAlarmScanAt,scanTo-10*60_000);lastAlarmScanAt=scanTo;
  const node=get('alarmNow');if(node)node.innerHTML=`${pad(now.getHours())}:${pad(now.getMinutes())}<small>:${pad(now.getSeconds())}</small>`;
  const next=get('nextAlarm');if(next)next.textContent=nextAlarmText();
  for(const alarm of cfg.alarms||[]){
    const snoozeAt=number(alarm.snoozeUntil,0);
    if(snoozeAt&&snoozeAt<=scanTo){
      const key='snooze-'+snoozeAt;alarm.snoozeUntil=0;if(alarm.lastFiredKey!==key)fireAlarm(alarm,key);
      continue;
    }
    if(!alarm.enabled)continue;
    const repeat=Array.isArray(alarm.repeat)?alarm.repeat:[];
    const parts=String(alarm.time||'').split(':').map(Number);if(parts.length<2||!Number.isFinite(parts[0])||!Number.isFinite(parts[1]))continue;
    const scheduled=new Date(now.getFullYear(),now.getMonth(),now.getDate(),parts[0],parts[1],0,0),scheduledAt=scheduled.getTime();
    const key=`${dateKey(scheduled)}-${pad(parts[0])}:${pad(parts[1])}`;
    if(scheduledAt>scanFrom&&scheduledAt<=scanTo&&(!repeat.length||repeat.includes(scheduled.getDay()))&&alarm.lastFiredKey!==key)fireAlarm(alarm,key);
  }
  startNextQueuedAlarm();
}

function render() {
  applyStyle(); content.className='content '+widgetId;
  if(widgetId==='plannerCalendar')renderPlanner();
  else if(widgetId==='quadrantTasks')renderQuadrants();
  else if(widgetId==='miniCalendarGlass')renderMiniCalendar();
  else if(widgetId==='flipClock')renderFlip();
  else if(widgetId==='cycleCountdown')renderCycles();
  else if(widgetId==='desktopFolder')renderFolder();
  else if(widgetId==='analogClock')renderAnalog();
  else if(widgetId==='digitalClockGlass')renderDigital();
  else if(widgetId==='stickyNote')renderSticky();
  else if(widgetId==='lineWeather')renderWeather();
  else if(widgetId==='desktopSchedule')renderSchedule();
  else if(widgetId==='markdownNote')renderMarkdown();
  else if(widgetId==='desktopCounter')renderCounters();
  else if(widgetId==='classSchedule')renderClasses();
  else if(widgetId==='progressTracker')renderProgress();
  else if(widgetId==='simplePomodoro')renderPomodoro();
  else if(widgetId==='clockCalendar')renderClockCalendar();
  else if(widgetId==='durationTimer')renderDurationTimer();
  else if(widgetId==='alarmClock')renderAlarm();
  else content.innerHTML='<div class="empty">组件正在准备中</div>';
}

function commonEditor() {
  return `<div class="form-section">统一外观</div><div class="form-grid">
    <div class="form-field"><label>显示主题</label><select id="editTheme"><option value="dark"${cfg.theme!=='light'?' selected':''}>深色玻璃</option><option value="light"${cfg.theme==='light'?' selected':''}>浅色玻璃</option></select></div>
    <div class="form-field"><label>强调颜色</label><input id="editAccent" type="color" value="${safeColor(cfg.accent,'#5caeff')}"></div>
  </div>`;
}
function editRows(items, formatter, kind){return `<div class="edit-list">${items.map((item,index)=>`<div class="edit-row"><span>${formatter(item,index)}</span><button data-edit-del="${kind}" data-index="${index}">×</button></div>`).join('')}</div>`;}
function renderEditor() {
  editorTitle.textContent=NAMES[widgetId]+'设置';
  let html=commonEditor();
  if(widgetId==='plannerCalendar')html+=`<div class="form-section">待办事项</div><div class="form-grid"><div class="form-field full"><label>待办内容</label><input id="newTaskText" placeholder="例如：完成项目周报"></div><div class="form-field"><label>日期</label><input id="newTaskDate" type="date" value="${selectedDate}"></div><div class="form-field"><label>&nbsp;</label><button class="form-btn primary" data-edit-add="task">添加待办</button></div></div>${editRows(editDraft.tasks||[],(x)=>`${esc(x.date)} · ${esc(x.text)}`,'task')}`;
  else if(widgetId==='quadrantTasks')html+=`<div class="form-section">象限名称与颜色</div><div class="form-grid">${editDraft.quadrants.map((q,i)=>`<div class="form-field"><label>象限 ${i+1}</label><input data-quad-title="${i}" value="${esc(q.title)}"></div><div class="form-field"><label>颜色</label><input data-quad-color="${i}" type="color" value="${safeColor(q.color,'#5caeff')}"></div>`).join('')}</div>`;
  else if(['flipClock','digitalClockGlass','analogClock','clockCalendar'].includes(widgetId))html+=`<div class="form-section">时钟显示</div><div class="form-grid"><div class="form-field"><label>时间制式</label><select id="editHour12"><option value="0"${!cfg.hour12?' selected':''}>24 小时</option><option value="1"${cfg.hour12?' selected':''}>12 小时</option></select></div><div class="form-field"><label>秒钟</label><select id="editSeconds"><option value="1"${cfg.showSeconds!==false?' selected':''}>显示</option><option value="0"${cfg.showSeconds===false?' selected':''}>隐藏</option></select></div>${widgetId==='clockCalendar'?`<div class="form-field full"><label>日历农历</label><select id="editShowLunar"><option value="1"${cfg.showLunar!==false?' selected':''}>显示（日期悬停仍可查看完整农历）</option><option value="0"${cfg.showLunar===false?' selected':''}>隐藏日格农历</option></select></div>`:''}</div>`;
  else if(widgetId==='miniCalendarGlass')html+=`<div class="form-section">日历显示</div><div class="form-grid"><div class="form-field full"><label>日格农历</label><select id="editShowLunar"><option value="1"${cfg.showLunar!==false?' selected':''}>显示</option><option value="0"${cfg.showLunar===false?' selected':''}>隐藏（悬停日期仍可查看）</option></select></div></div>`;
  else if(widgetId==='cycleCountdown')html+=`<div class="form-section">周期目标</div><div class="form-grid"><div class="form-field full"><label>名称</label><input id="newCycleName" placeholder="例如：距离发薪日"></div><div class="form-field"><label>周期</label><select id="newCycleKind"><option value="yearly">每年</option><option value="monthly">每月</option><option value="weekly">每周</option><option value="lunar">农历每年</option></select></div><div class="form-field"><label>月 / 星期</label><input id="newCycleMonth" type="number" min="1" max="12" value="1"></div><div class="form-field"><label>日</label><input id="newCycleDay" type="number" min="1" max="31" value="1"></div><div class="form-field"><label>&nbsp;</label><button class="form-btn primary" data-edit-add="cycle">添加周期</button></div></div>${editRows(editDraft.cycles||[],(x)=>esc(x.name),'cycle')}`;
  else if(widgetId==='desktopFolder')html+=`<div class="form-section">显示文件夹</div><div class="form-grid"><div class="form-field full"><label>当前路径</label><input value="${esc(cfg.folder||'尚未选择')}" readonly></div><div class="form-field full"><button class="form-btn primary" data-edit-add="folder">选择文件夹</button></div></div>`;
  else if(widgetId==='stickyNote')html+=`<div class="form-section">便签页面</div><div class="form-grid"><div class="form-field"><label>新页面名称</label><input id="newPageName" placeholder="例如：灵感"></div><div class="form-field"><label>&nbsp;</label><button class="form-btn primary" data-edit-add="page">添加页面</button></div></div>${editRows(editDraft.pages||[],(x)=>esc(x.name),'page')}`;
  else if(widgetId==='lineWeather')html+=`<div class="form-section">天气位置</div><div class="form-grid"><div class="form-field full"><label>定位方式</label><select id="editAutoLocation"><option value="1"${cfg.autoLocation!==false?' selected':''}>自动定位当前城市（推荐）</option><option value="0"${cfg.autoLocation===false?' selected':''}>手动指定城市</option></select></div><div class="form-field full"><label>手动城市 / 自动定位失败时的备用城市</label><input id="editCity" value="${esc(cfg.city||'北京')}" placeholder="北京"></div><div class="form-field full"><label>提示</label><input value="自动定位按网络位置判断，使用 VPN 时可切换手动城市" readonly></div></div>`;
  else if(widgetId==='desktopSchedule')html+=`<div class="form-section">日程项目</div><div class="form-grid"><div class="form-field"><label>日期</label><input id="newEventDate" type="date" value="${dateKey(new Date())}"></div><div class="form-field"><label>时间</label><input id="newEventTime" type="time" value="09:00"></div><div class="form-field full"><label>日程名称</label><input id="newEventTitle" placeholder="例如：项目会议"></div><div class="form-field"><label>地点</label><input id="newEventPlace" placeholder="会议室"></div><div class="form-field"><label>备注</label><input id="newEventNote" placeholder="携带材料"></div><div class="form-field full"><button class="form-btn primary" data-edit-add="event">添加日程</button></div></div>${editRows(editDraft.events||[],(x)=>`${esc(x.date)} ${esc(x.time||'')} · ${esc(x.title)}`,'event')}`;
  else if(widgetId==='markdownNote')html+=`<div class="form-section">笔记信息</div><div class="form-grid"><div class="form-field full"><label>笔记标题</label><input id="editNoteTitle" value="${esc(cfg.title||'')}"></div><div class="form-field full"><button class="form-btn soft" data-edit-add="copy-note">复制全部 Markdown</button></div></div>`;
  else if(widgetId==='desktopCounter')html+=`<div class="form-section">计数项目</div><div class="form-grid"><div class="form-field"><label>项目名称</label><input id="newCounterName" placeholder="例如：喝水次数"></div><div class="form-field"><label>&nbsp;</label><button class="form-btn primary" data-edit-add="counter">添加项目</button></div></div>${editRows(editDraft.counters||[],(x)=>`${esc(x.name)}：${number(x.value,0)}`,'counter')}`;
  else if(widgetId==='classSchedule')html+=`<div class="form-section">课程安排</div><div class="form-grid"><div class="form-field"><label>星期</label><select id="newCourseWeek">${WEEK.map((w,i)=>`<option value="${i}">${w}</option>`).join('')}</select></div><div class="form-field"><label>课程名称</label><input id="newCourseName" placeholder="高等数学"></div><div class="form-field"><label>开始</label><input id="newCourseStart" type="time" value="08:00"></div><div class="form-field"><label>结束</label><input id="newCourseEnd" type="time" value="08:45"></div><div class="form-field full"><label>教室 / 地点</label><input id="newCoursePlace" placeholder="教学楼202"></div><div class="form-field full"><button class="form-btn primary" data-edit-add="course">添加课程</button></div></div>${editRows(editDraft.courses||[],(x)=>`${WEEK[number(x.weekday,1)]} ${esc(x.start)} · ${esc(x.name)}`,'course')}`;
  else if(widgetId==='progressTracker')html+=`<div class="form-section">自定义目标</div><div class="form-grid"><div class="form-field"><label>目标名称</label><input id="newProgressName" placeholder="例如：阅读计划"></div><div class="form-field"><label>当前进度 %</label><input id="newProgressValue" type="number" min="0" max="100" value="0"></div><div class="form-field full"><button class="form-btn primary" data-edit-add="progress">添加进度</button></div></div>${editRows(editDraft.progresses||[],(x)=>`${esc(x.name)} · ${number(x.value,0)}%`,'progress')}`;
  else if(widgetId==='simplePomodoro')html+=`<div class="form-section">专注设置</div><div class="form-grid"><div class="form-field full"><label>当前专注事项</label><input id="editFocusLabel" value="${esc(cfg.focusLabel||'')}"></div><div class="form-field"><label>专注分钟</label><input id="editFocusMin" type="number" min="1" max="180" value="${number(cfg.focusMin,25)}"></div><div class="form-field"><label>休息分钟</label><input id="editBreakMin" type="number" min="1" max="60" value="${number(cfg.breakMin,5)}"></div></div>`;
  else if(widgetId==='durationTimer')html+=`<div class="form-section">倒计时效率设置</div><div class="form-grid"><div class="form-field full"><label>任务名称</label><input id="editTimerLabel" value="${esc(cfg.label||'当前任务')}" maxlength="60"></div><div class="form-field"><label>默认分钟</label><input id="editTimerMinutes" type="number" min="1" max="720" value="${number(cfg.selectedMinutes,25)}"></div><div class="form-field"><label>到点后</label><select id="editTimerLoop"><option value="0"${!cfg.loop?' selected':''}>停止</option><option value="1"${cfg.loop?' selected':''}>自动循环</option></select></div><div class="form-field"><label>系统提醒</label><select id="editTimerNotify"><option value="1"${cfg.notify!==false?' selected':''}>开启</option><option value="0"${cfg.notify===false?' selected':''}>关闭</option></select></div><div class="form-field"><label>快捷时长（分钟）</label><input id="editTimerPresets" value="${esc((cfg.presets||[5,15,25,45]).join(', '))}" placeholder="5, 15, 25, 45"></div><div class="form-field full"><label>最近完成</label><input value="${esc((cfg.history||[]).slice(0,3).map((item)=>item.minutes+'分钟 '+(item.label||'')).join(' · ')||'暂无记录')}" readonly></div></div>`;
  else if(widgetId==='alarmClock'){
    const sound=alarmSoundConfig(editDraft&&editDraft.alarmSound);
    html+=`<div class="form-section">提示声音</div><div class="form-grid">
      <div class="form-field"><label>到点声音</label><select id="editAlarmSoundMode"><option value="system"${sound.mode==='system'?' selected':''}>Windows 系统提示音（默认）</option><option value="custom"${sound.mode==='custom'?' selected':''}>自定义音频</option><option value="none"${sound.mode==='none'?' selected':''}>静音</option></select></div>
      <div class="form-field"><label>播放方式</label><select id="editAlarmSoundRepeat"><option value="1"${sound.repeat?' selected':''}>重复至处理（最多 60 秒）</option><option value="0"${!sound.repeat?' selected':''}>仅播放一次</option></select></div>
      <div class="form-field full"><label>自定义声音</label><div class="inline-field"><input value="${esc(sound.fileName||'尚未选择音频；不可用时自动改用系统提示音')}" readonly><button class="form-btn soft" data-edit-add="alarm-sound">选择音频</button></div></div>
      <div class="form-field full"><label id="alarmVolumeLabel">自定义音量 ${Math.round(sound.volume*100)}%</label><input id="editAlarmSoundVolume" type="range" min="0" max="100" step="1" value="${Math.round(sound.volume*100)}"></div>
    </div><div class="form-section">添加闹钟</div><div class="form-grid"><div class="form-field"><label>时间</label><input id="newAlarmTime" type="time" value="07:30"></div><div class="form-field"><label>重复</label><select id="newAlarmRepeat"><option value="once">仅一次</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekends">周末</option></select></div><div class="form-field full"><label>标签</label><input id="newAlarmLabel" placeholder="例如：起床、开会、吃药"></div><div class="form-field"><label>默认推迟分钟</label><input id="editSnoozeMin" type="number" min="1" max="60" value="${number(cfg.snoozeMin,10)}"></div><div class="form-field"><label>&nbsp;</label><button class="form-btn primary" data-edit-add="alarm">添加闹钟</button></div></div>${editRows(editDraft.alarms||[],(alarm)=>`${esc(alarm.time)} · ${esc(alarm.label||'闹钟')} · ${alarmRepeatText(alarm)}`,'alarm')}`;
  }
  editorBody.innerHTML=html;
  const volume=get('editAlarmSoundVolume'),volumeLabel=get('alarmVolumeLabel');if(volume&&volumeLabel)volume.addEventListener('input',()=>{volumeLabel.textContent='自定义音量 '+volume.value+'%';});
}
function openEditor(){
  if(!settingsMode){if(!preview)ipcRenderer.send('studio:settings-open:'+instId);return;}
  editDraft=clone(cfg);renderEditor();editor.hidden=false;
}
function closeEditor(){
  if(settingsMode){ipcRenderer.send('studio:settings-close:'+instId);return;}
  editor.hidden=true;editDraft=null;
}
function saveEditor(){
  let refreshAlarmSound=false;
  cfg.theme=get('editTheme')?get('editTheme').value:cfg.theme; cfg.accent=get('editAccent')?get('editAccent').value:cfg.accent;
  if(widgetId==='quadrantTasks'){editorBody.querySelectorAll('[data-quad-title]').forEach((node)=>{editDraft.quadrants[Number(node.dataset.quadTitle)].title=node.value.trim().slice(0,20)||editDraft.quadrants[Number(node.dataset.quadTitle)].title;});editorBody.querySelectorAll('[data-quad-color]').forEach((node)=>{editDraft.quadrants[Number(node.dataset.quadColor)].color=node.value;});}
  if(['flipClock','digitalClockGlass','analogClock','clockCalendar'].includes(widgetId)){cfg.hour12=get('editHour12').value==='1';cfg.showSeconds=get('editSeconds').value==='1';}
  if(['miniCalendarGlass','clockCalendar'].includes(widgetId))cfg.showLunar=get('editShowLunar').value==='1';
  if(widgetId==='lineWeather'){cfg.autoLocation=get('editAutoLocation').value==='1';cfg.city=(get('editCity').value.trim().slice(0,80)||'北京');}
  if(widgetId==='markdownNote')cfg.title=get('editNoteTitle').value.trim().slice(0,80)||'Markdown 桌面笔记';
  if(widgetId==='simplePomodoro'){cfg.focusLabel=get('editFocusLabel').value.trim().slice(0,60);cfg.focusMin=number(get('editFocusMin').value,25,1,180);cfg.breakMin=number(get('editBreakMin').value,5,1,60);if(!cfg.running)cfg.remaining=cfg.focusMin*60;}
  if(widgetId==='durationTimer'){
    const minutes=number(get('editTimerMinutes').value,25,1,720);
    cfg.label=get('editTimerLabel').value.trim().slice(0,60)||'当前任务';cfg.selectedMinutes=minutes;cfg.loop=get('editTimerLoop').value==='1';cfg.notify=get('editTimerNotify').value==='1';
    const presets=get('editTimerPresets').value.split(/[,，\s]+/).map((value)=>number(value,0,1,720)).filter(Boolean);cfg.presets=[...new Set(presets)].slice(0,6);if(!cfg.presets.length)cfg.presets=[5,15,25,45];
    if(!cfg.running)cfg.remaining=minutes*60;
  }
  if(widgetId==='alarmClock'){
    const previousRinging=cfg.ringingId;
    cfg.snoozeMin=number(get('editSnoozeMin').value,10,1,60);
    const chosen=alarmSoundConfig(editDraft&&editDraft.alarmSound);
    chosen.mode=get('editAlarmSoundMode').value;
    chosen.repeat=get('editAlarmSoundRepeat').value==='1';
    chosen.volume=number(get('editAlarmSoundVolume').value,85,0,100)/100;
    if(chosen.mode==='custom'&&!chosen.filePath){chosen.mode='system';showToast('请先选择音频文件，当前保留 Windows 系统提示音');}
    cfg.alarmSound=chosen;
    if(previousRinging&&!(editDraft.alarms||[]).some((alarm)=>alarm.id===previousRinging)){cfg.ringingId='';stopAlarmSound();}
    else refreshAlarmSound=!!previousRinging;
  }
  ['tasks','quadrants','cycles','pages','events','counters','courses','progresses','alarms'].forEach((key)=>{if(editDraft&&key in editDraft)cfg[key]=editDraft[key];});
  save();
  if(refreshAlarmSound&&cfg.ringingId)startAlarmSound();
  if(settingsMode){closeEditor();return;}
  closeEditor();render();if(widgetId==='lineWeather')loadWeather();if(widgetId==='desktopFolder')loadFolder();
}

async function editorAdd(kind){
  if(kind==='task'){const text=get('newTaskText').value.trim();if(text){editDraft.tasks.push({id:uid(),text,date:get('newTaskDate').value||selectedDate,done:false});}}
  else if(kind==='cycle'){const name=get('newCycleName').value.trim();if(name){const cycle={id:uid(),name,kind:get('newCycleKind').value,month:number(get('newCycleMonth').value,1,0,12),day:number(get('newCycleDay').value,1,1,31)};if(cycle.kind==='weekly')cycle.weekday=number(get('newCycleMonth').value,6,0,6);editDraft.cycles.push(cycle);}}
  else if(kind==='folder'){const result=await ipcRenderer.invoke('studio:folder-choose:'+instId);if(result&&result.ok){folderData=result;cfg.folder=result.folder;editDraft.folder=result.folder;save();renderEditor();showToast('文件夹已更新');return;}}
  else if(kind==='page'){const name=get('newPageName').value.trim();if(name){const page={id:uid(),name:name.slice(0,12),text:''};editDraft.pages.push(page);editDraft.activePage=page.id;}}
  else if(kind==='event'){const title=get('newEventTitle').value.trim();if(title)editDraft.events.push({id:uid(),date:get('newEventDate').value,time:get('newEventTime').value,title,place:get('newEventPlace').value.trim(),note:get('newEventNote').value.trim()});}
  else if(kind==='copy-note'){clipboard.writeText(cfg.text||'');showToast('Markdown 已复制');return;}
  else if(kind==='counter'){const name=get('newCounterName').value.trim();if(name)editDraft.counters.push({id:uid(),name:name.slice(0,30),value:0});}
  else if(kind==='course'){const name=get('newCourseName').value.trim();if(name)editDraft.courses.push({id:uid(),weekday:number(get('newCourseWeek').value,1),name,start:get('newCourseStart').value,end:get('newCourseEnd').value,place:get('newCoursePlace').value.trim()});}
  else if(kind==='progress'){const name=get('newProgressName').value.trim();if(name)editDraft.progresses.push({id:uid(),name:name.slice(0,40),value:number(get('newProgressValue').value,0,0,100)});}
  else if(kind==='alarm-sound'){
    const result=await ipcRenderer.invoke('studio:alarm-sound-choose:'+instId);
    if(result&&result.ok){editDraft.alarmSound={...alarmSoundConfig(editDraft.alarmSound),mode:'custom',filePath:result.filePath,fileName:result.fileName};renderEditor();showToast('自定义提示声音已保存到 Widgetly');return;}
    if(result&&!result.canceled&&result.message)showToast(result.message);return;
  }
  else if(kind==='alarm'){const time=get('newAlarmTime').value,label=get('newAlarmLabel').value.trim().slice(0,60)||'闹钟',mode=get('newAlarmRepeat').value;const repeats={once:[],daily:[0,1,2,3,4,5,6],weekdays:[1,2,3,4,5],weekends:[0,6]};if(time)editDraft.alarms.push({id:uid('alarm'),time,label,repeat:repeats[mode]||[],enabled:true,lastFiredKey:'',snoozeUntil:0});}
  renderEditor();
}
function editorDelete(kind,index){const map={task:'tasks',cycle:'cycles',page:'pages',event:'events',counter:'counters',course:'courses',progress:'progresses',alarm:'alarms'};const key=map[kind];if(!key||!Array.isArray(editDraft[key]))return;if(kind==='page'&&editDraft.pages.length<=1){showToast('至少保留一个便签页面');return;}editDraft[key].splice(index,1);if(kind==='page'&&!editDraft.pages.some((p)=>p.id===editDraft.activePage))editDraft.activePage=editDraft.pages[0].id;renderEditor();}

content.addEventListener('click',async(event)=>{
  const target=event.target.closest('[data-action]'); if(!target)return; const action=target.dataset.action;
  if(action==='month-prev'){monthOffset--;render();}
  else if(action==='month-next'){monthOffset++;render();}
  else if(action==='month-today'){monthOffset=0;selectedDate=dateKey(new Date());render();}
  else if(action==='lunar-toggle'){cfg.showLunar=cfg.showLunar===false;save();render();}
  else if(action==='task-add'){const input=get('plannerQuick');const text=input&&input.value.trim();if(text){cfg.tasks.push({id:uid(),text:text.slice(0,160),date:selectedDate,done:false});save();renderPlanner();}}
  else if(action==='task-toggle'){const task=cfg.tasks.find((x)=>x.id===target.dataset.id);if(task){task.done=!task.done;save();renderPlanner();}}
  else if(action==='quad-toggle'){const q=cfg.quadrants[Number(target.dataset.q)],task=q&&q.tasks.find((x)=>x.id===target.dataset.id);if(task){task.done=!task.done;save();renderQuadrants();}}
  else if(action==='quad-delete'){event.stopPropagation();const q=cfg.quadrants[Number(target.dataset.q)];if(q){q.tasks=q.tasks.filter((x)=>x.id!==target.dataset.id);save();renderQuadrants();}}
  else if(action==='open-editor')openEditor();
  else if(action==='folder-choose'){const result=await ipcRenderer.invoke('studio:folder-choose:'+instId);if(result&&result.ok){folderData=result;folderCurrent=result.folder;folderQuery='';cfg.folder=result.root||result.folder;save();renderFolder();}}
  else if(action==='folder-refresh')loadFolder();
  else if(action==='folder-back'){if(folderData&&folderData.parent)loadFolder(folderData.parent);}
  else if(action==='folder-open-current'){if(folderData&&folderData.folder)openFolderItem({path:folderData.folder,isDirectory:true},true);}
  else if(action==='file-open')openFolderItem(visibleFolderItems[Number(target.dataset.index)]);
  else if(action==='file-more'){event.stopPropagation();folderSortOpen=false;folderPanel={type:'menu',item:visibleFolderItems[Number(target.dataset.index)]};renderFolder();}
  else if(action==='file-open-system'){event.stopPropagation();const item=(folderPanel&&folderPanel.item)||visibleFolderItems[Number(target.dataset.index)];folderPanel=null;renderFolder();openFolderItem(item,true);}
  else if(action==='folder-sort-toggle'){folderPanel=null;folderSortOpen=!folderSortOpen;renderFolder();}
  else if(action==='folder-sort-apply'){cfg.folderSort=target.dataset.value||'name-asc';folderSortOpen=false;save();renderFolder();}
  else if(action==='folder-create'){folderSortOpen=false;folderPanel={type:'create'};renderFolder();}
  else if(action==='folder-create-submit')createFolder();
  else if(action==='file-rename'){folderPanel={type:'rename',item:folderPanel&&folderPanel.item};renderFolder();}
  else if(action==='file-rename-submit')renameFolderItem();
  else if(action==='file-trash')trashFolderItem();
  else if(action==='folder-panel-close'){folderPanel=null;renderFolder();}
  else if(action==='sticky-add')openEditor();
  else if(action==='sticky-page'){cfg.activePage=target.dataset.id;save();renderSticky();}
  else if(action==='weather-refresh')loadWeather();
  else if(action==='schedule-prev'){scheduleOffset--;renderSchedule();}
  else if(action==='schedule-next'){scheduleOffset++;renderSchedule();}
  else if(action==='md-toggle'){markdownPreview=!markdownPreview;renderMarkdown();}
  else if(action.startsWith('counter-')){const item=cfg.counters.find((x)=>x.id===target.dataset.id);if(item){if(action==='counter-add')item.value=number(item.value,0)+1;else if(action==='counter-sub')item.value=number(item.value,0)-1;else item.value=0;save();renderCounters();}}
  else if(action==='pomo-mode'){if(cfg.running)return;cfg.mode=target.dataset.mode;cfg.remaining=cfg.focusMin*60;save();renderPomodoro();}
  else if(action==='pomo-toggle'){if(cfg.running){if(cfg.mode==='stopwatch')cfg.stopwatchSeconds=pomoRemaining();else cfg.remaining=pomoRemaining();cfg.running=false;cfg.endAt=0;}else{cfg.running=true;if(cfg.mode==='stopwatch')cfg.startedAt=Date.now();else cfg.endAt=Date.now()+number(cfg.remaining,cfg.focusMin*60)*1000;}save();renderPomodoro();}
  else if(action==='pomo-reset'){cfg.running=false;cfg.endAt=0;cfg.stopwatchSeconds=0;cfg.remaining=cfg.focusMin*60;save();renderPomodoro();}
  else if(action==='timer-preset'){const minutes=number(target.dataset.minutes,25,1,720);cfg.selectedMinutes=minutes;cfg.remaining=minutes*60;cfg.running=false;cfg.endAt=0;save();renderDurationTimer();}
  else if(action==='timer-toggle'){const remaining=timerRemaining();if(cfg.running){cfg.running=false;cfg.remaining=remaining;cfg.endAt=0;}else{cfg.remaining=remaining>0?remaining:number(cfg.selectedMinutes,25)*60;cfg.running=true;cfg.endAt=Date.now()+cfg.remaining*1000;}save();renderDurationTimer();}
  else if(action==='timer-reset'){cfg.running=false;cfg.endAt=0;cfg.remaining=number(cfg.selectedMinutes,25)*60;save();renderDurationTimer();}
  else if(action==='timer-loop'){cfg.loop=!cfg.loop;save();renderDurationTimer();}
  else if(action==='timer-info'){showToast('选择时长后开始；暂停可继续，停止会恢复所选时长');}
  else if(action==='alarm-toggle'){const alarm=(cfg.alarms||[]).find((item)=>item.id===target.dataset.id);if(alarm){alarm.enabled=!alarm.enabled;alarm.snoozeUntil=0;if(!alarm.enabled&&cfg.ringingId===alarm.id){cfg.ringingId='';stopAlarmSound();}save();renderAlarm();setTimeout(startNextQueuedAlarm,0);}}
  else if(action==='alarm-snooze'){const alarm=(cfg.alarms||[]).find((item)=>item.id===cfg.ringingId);if(alarm){const select=get('alarmSnoozeSelect'),minutes=number(select&&select.value,cfg.snoozeMin||10,1,60);cfg.snoozeMin=minutes;alarm.snoozeUntil=Date.now()+minutes*60000;cfg.ringingId='';stopAlarmSound();save();renderAlarm();showToast(`将在 ${minutes} 分钟后再次提醒`);setTimeout(startNextQueuedAlarm,0);}}
  else if(action==='alarm-dismiss'){const alarm=(cfg.alarms||[]).find((item)=>item.id===cfg.ringingId);if(alarm){if(!Array.isArray(alarm.repeat)||!alarm.repeat.length)alarm.enabled=false;alarm.snoozeUntil=0;}cfg.ringingId='';stopAlarmSound();save();renderAlarm();setTimeout(startNextQueuedAlarm,0);}
});
content.addEventListener('click',(event)=>{const day=event.target.closest('[data-date]');if(day){selectedDate=day.dataset.date;render();}});
content.addEventListener('keydown',(event)=>{if(event.target.id==='folderNameInput'&&event.key==='Enter'){event.preventDefault();if(folderPanel&&folderPanel.type==='create')createFolder();else renameFolderItem();return;}const file=event.target.closest('.file-row');if(file&&event.key==='Enter'){event.preventDefault();openFolderItem(visibleFolderItems[Number(file.dataset.index)]);return;}const input=event.target.closest('[data-quad-input]');if(input&&event.key==='Enter'){event.preventDefault();const text=input.value.trim();if(text){cfg.quadrants[Number(input.dataset.quadInput)].tasks.push({id:uid(),text:text.slice(0,120),done:false});save();renderQuadrants();}}if(event.target.id==='plannerQuick'&&event.key==='Enter'){event.preventDefault();const text=event.target.value.trim();if(text){cfg.tasks.push({id:uid(),text:text.slice(0,160),date:selectedDate,done:false});save();renderPlanner();}}});
content.addEventListener('input',(event)=>{
  if(event.target.id==='folderSearch'){folderQuery=event.target.value;renderFolder();setTimeout(()=>{const input=get('folderSearch');if(input){input.focus();input.setSelectionRange(folderQuery.length,folderQuery.length);}},0);}
  else if(event.target.id==='stickyText'){const page=activePage();if(page){page.text=event.target.value;save(null,false);const count=content.querySelector('.sticky-top span');if(count)count.textContent=`字数 ${page.text.length} / 10000`;}}
  else if(event.target.id==='mdText'){cfg.text=event.target.value;save(null,false);}
});
content.addEventListener('change',(event)=>{
  if(event.target.id==='durationPresetSelect'){
    const minutes=number(event.target.value,25,1,720);cfg.selectedMinutes=minutes;cfg.remaining=minutes*60;cfg.running=false;cfg.endAt=0;save();renderDurationTimer();
  }
});
// 所有临时浮层遵循同一关闭规则：点到浮层之外、按 Esc 或窗口失焦时立即收起。
// 直接移除浮层节点而不重绘整个组件，保证用户点到的文件、按钮和输入框仍能继续收到本次点击。
function dismissTransientPanels(event=null){
  let changed=false;
  if(folderSortOpen&&(!event||!event.target.closest('.folder-sort,.folder-sort-popover'))){folderSortOpen=false;const node=content.querySelector('.folder-sort-popover');if(node)node.remove();changed=true;}
  if(folderPanel&&(!event||!event.target.closest('.folder-panel,.file-open-btn'))){folderPanel=null;const node=content.querySelector('.folder-panel');if(node)node.remove();changed=true;}
  return changed;
}
document.addEventListener('pointerdown',(event)=>{if(widgetId==='desktopFolder')dismissTransientPanels(event);},true);
document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&dismissTransientPanels())event.preventDefault();});
window.addEventListener('blur',()=>dismissTransientPanels());

editorBody.addEventListener('click',(event)=>{const add=event.target.closest('[data-edit-add]');if(add)editorAdd(add.dataset.editAdd);const del=event.target.closest('[data-edit-del]');if(del)editorDelete(del.dataset.editDel,Number(del.dataset.index));});
get('editorClose').addEventListener('click',closeEditor);get('editorCancel').addEventListener('click',closeEditor);get('editorSave').addEventListener('click',saveEditor);
editor.addEventListener('mousedown',(event)=>{if(event.target===editor)closeEditor();});

let dragging=false;
document.addEventListener('mousedown',(event)=>{
  ipcRenderer.send('activate');
  if(preview||hostedByDock||event.button!==0||locked||event.target.closest('button,input,textarea,select,[data-action],.editor,[contenteditable]'))return;
  dragging=true;ipcRenderer.send('drag-start');
});
let dragBlurTimer=null;
window.addEventListener('mouseup',(event)=>{if(dragging){dragging=false;clearTimeout(dragBlurTimer);ipcRenderer.send('drag-end',{x:Number(event.screenX),y:Number(event.screenY)});}});
// 拖到组件坞上方时，Windows 有时会短暂把焦点交给下层窗口；此前这里立即结束拖动，
// 导致组件坞永远等不到“停留”判定。仅在窗口确实不可见一段时间后才做安全结束。
window.addEventListener('blur',()=>{if(dragging){clearTimeout(dragBlurTimer);dragBlurTimer=setTimeout(()=>{if(dragging&&document.hidden){dragging=false;ipcRenderer.send('drag-end');}},700);}});
window.addEventListener('focus',()=>clearTimeout(dragBlurTimer));

ipcRenderer.on('widgetly:advanced:'+instId,openEditor);
ipcRenderer.on('widgetly:common-state:'+instId,(_event,state)=>{locked=!!(state&&state.locked);});
ipcRenderer.on('widgetly:background-transparency:'+instId,(_event,data)=>{
  if(!data||!Number.isFinite(Number(data.alpha)))return;
  cfg.bgOpacity=number(data.alpha,.4,0,1);applyStyle();
});
ipcRenderer.on('cfg:updated:'+instId,(_event,next)=>{
  if(settingsMode)return;
  const wasRinging=widgetId==='alarmClock'&&!!cfg.ringingId;
  cfg=normalizeConfig(next);locked=!!cfg.locked;applyStyle();render();
  if(widgetId==='alarmClock'){
    if(cfg.ringingId)startAlarmSound();
    else if(wasRinging)stopAlarmSound();
  }
  if(widgetId==='desktopFolder'){folderCurrent='';loadFolder();}
  if(widgetId==='lineWeather')loadWeather();
});

setInterval(()=>{
  if(settingsMode)return;
  if(['flipClock','digitalClockGlass','analogClock','clockCalendar'].includes(widgetId))paintClock();
  else if(widgetId==='cycleCountdown')paintCycles();
  else if(widgetId==='progressTracker'&&new Date().getSeconds()===0)renderProgress();
  else if(widgetId==='simplePomodoro')paintPomodoro();
  else if(widgetId==='classSchedule'&&new Date().getSeconds()===0)renderClasses();
  else if(widgetId==='durationTimer')paintDurationTimer();
  else if(widgetId==='alarmClock')paintAlarm();
},1000);

window.addEventListener('beforeunload',()=>{
  if(widgetId==='alarmClock')stopAlarmSound();
});

(async()=>{
  let stored={}; if(!preview){try{stored=await ipcRenderer.invoke('cfg:'+instId);}catch(_){}}
  cfg=normalizeConfig(stored);locked=!!cfg.locked;applyStyle();
  if(settingsMode){content.hidden=true;openEditor();return;}
  render();
  if(widgetId==='alarmClock'&&cfg.ringingId)startAlarmSound();
  if(widgetId==='desktopFolder')loadFolder();
  if(widgetId==='lineWeather')loadWeather();
})();
