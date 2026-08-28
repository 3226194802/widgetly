const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const firstArg = process.argv[2] || '';
const attachMode = /^\d+$/.test(firstArg);
const port = attachMode ? Number(firstArg) : 9440;
let activePort = port;
const stamp = new Date().toISOString().replace(/[.:]/g, '-');
const outputRoot = attachMode
  ? (process.argv[3] || 'F:\\Widgetly-test-alarm-timer-reference\\screens')
  : (firstArg || path.join('F:\\', `Widgetly-test-alarm-timer-${stamp}`));
const output = attachMode ? outputRoot : path.join(outputRoot, 'screens');
const profileDir = attachMode ? '' : path.join(outputRoot, 'profile');
const customSound = attachMode ? '' : path.join(profileDir, 'alarm-sounds', 'validation-tone.wav');

function writeSilentWav(file) {
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * .22);
  const bytes = samples * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  fs.writeFileSync(file, wav);
}

function prepareProfile() {
  fs.mkdirSync(path.dirname(customSound), { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  writeSilentWav(customSound);
  fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
    theme: 'dark', autostart: false, openManagerOnStart: false, closeToTray: true,
    managerOpacity: .5, pinToDesktop: false,
    instances: [
      {
        id: 'reference-timer', widgetId: 'durationTimer', x: 60, y: 70,
        config: { label: '当前任务', notify: false },
        windowState: { windowSize: { width: 220, height: 130 } },
      },
      {
        id: 'reference-alarm', widgetId: 'alarmClock', x: 330, y: 70,
        config: { alarmSound: { mode: 'system', filePath: '', fileName: '', volume: .85, repeat: true } },
        windowState: { windowSize: { width: 240, height: 145 } },
      },
    ],
  }, null, 2));
}

class Client {
  constructor(url) {
    this.next = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message));
      else pending.resolve(data.result);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(detail || result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result.value;
  }
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  }
  close() { try { this.socket.close(); } catch (_) {} }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pages() {
  return (await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json()).filter((page) => page.type === 'page');
}

async function waitFor(match, timeout = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const target = (await pages()).find(match);
      if (target) return target;
    } catch (_) {}
    await wait(100);
  }
  throw new Error('DevTools target timeout');
}

async function openWidget(wid) {
  const expectedInst = wid === 'durationTimer' ? 'reference-timer' : wid === 'alarmClock' ? 'reference-alarm' : '';
  const target = await waitFor((page) => {
    try {
      const url = new URL(page.url);
      return url.searchParams.get('wid') === wid && url.searchParams.get('inst') === expectedInst && !url.searchParams.get('settings');
    } catch (_) { return false; }
  });
  const client = new Client(target.webSocketDebuggerUrl);
  await client.ready;
  await client.evaluate(`new Promise((resolve)=>{const started=Date.now();const check=()=>{if(typeof cfg==='object'&&Object.keys(cfg).length&&document.getElementById('content').children.length)resolve(true);else if(Date.now()-started>5000)resolve(false);else setTimeout(check,40);};check();})`);
  return client;
}

async function launch(prepare = true, debugPort = port) {
  if (attachMode) return null;
  activePort = debugPort;
  if (prepare) prepareProfile();
  const child = spawn(electronExe, [
    appDir,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--widgetly-test-mode',
  ], { cwd: appDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (part) => { logs += part; });
  child.stderr.on('data', (part) => { logs += part; });
  child.exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.logs = () => logs;
  await openWidget('durationTimer').then((client) => client.close());
  await openWidget('alarmClock').then((client) => client.close());
  return child;
}

async function quit(child) {
  if (!child) return;
  try {
    const target = (await pages()).find((page) => {
      try { const url=new URL(page.url);return url.searchParams.get('wid')==='alarmClock'&&url.searchParams.get('inst')==='reference-alarm'&&!url.searchParams.get('settings'); }
      catch (_) { return false; }
    });
    if (target) {
      const client = new Client(target.webSocketDebuggerUrl); await client.ready;
      await client.evaluate(`require('electron').ipcRenderer.send('quit-app');true`);
      client.close();
    }
  } catch (_) {}
  const exited = await Promise.race([child.exitPromise.then(() => true), wait(8000).then(() => false)]);
  if (!exited) child.kill();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function overflowExpression() {
  return `(() => {
    const visibleOverflow=[...document.querySelectorAll('#content *')].filter((el)=>{
      const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden')return false;
      const r=el.getBoundingClientRect();if(!(r.right>innerWidth+2||r.bottom>innerHeight+2||r.left<-2||r.top<-2))return false;
      let parent=el.parentElement;
      while(parent&&parent!==document.body){const ps=getComputedStyle(parent),pr=parent.getBoundingClientRect();if((ps.overflowX!=='visible'||ps.overflowY!=='visible')&&(r.right>pr.right+1||r.bottom>pr.bottom+1||r.left<pr.left-1||r.top<pr.top-1))return false;parent=parent.parentElement;}
      return true;
    }).slice(0,6).map((el)=>({tag:el.tagName,cls:String(el.className).slice(0,80)}));
    return {viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],visibleOverflow};
  })()`;
}

(async () => {
  if (!attachMode && !fs.existsSync(electronExe)) throw new Error('Electron runtime not found: ' + electronExe);
  fs.mkdirSync(output, { recursive: true });
  const child = await launch();
  let timer;
  let alarm;
  try {
    timer = await openWidget('durationTimer');
    await timer.evaluate(`require('electron').ipcRenderer.send('resize:'+instId,{width:220,height:130});true`);
    await timer.evaluate(`cfg.selectedMinutes=15;cfg.remaining=900;cfg.running=false;cfg.endAt=0;cfg.loop=false;cfg.notify=false;cfg.presets=[5,15,25,45];cfg.history=[];save();renderDurationTimer();true`);
    await wait(320);
    const timerMin = await timer.evaluate(`({layout:${overflowExpression()},title:document.querySelector('.duration-title-copy strong').textContent,value:document.getElementById('durationValue').textContent,buttons:[...document.querySelectorAll('.duration-actions button')].map((button)=>({text:button.textContent.trim(),width:button.offsetWidth,height:button.offsetHeight})),tools:document.querySelectorAll('.duration-tool:not(.info-tool)').length,surface:getComputedStyle(document.querySelector('.duration-timer')).backgroundImage,outer:getComputedStyle(document.getElementById('card')).backgroundColor})`);
    await timer.screenshot(path.join(output, 'duration-minimum-idle.png'));

    await timer.evaluate(`cfg.selectedMinutes=1;cfg.remaining=2;cfg.running=true;cfg.endAt=Date.now()+1600;cfg.loop=false;cfg.notify=false;cfg.history=[];save();renderDurationTimer();true`);
    await wait(2800);
    const timerFinished = await timer.evaluate(`({running:cfg.running,remaining:timerRemaining(),history:cfg.history.length,value:document.getElementById('durationValue').textContent,state:document.getElementById('durationState')&&document.getElementById('durationState').textContent,toastVisible:!toastNode.hidden})`);
    await timer.screenshot(path.join(output, 'duration-minimum-finished.png'));

    const timerLoop = await timer.evaluate(`(()=>{cfg.selectedMinutes=1;cfg.remaining=0;cfg.running=true;cfg.endAt=Date.now()-1000;cfg.loop=true;cfg.notify=false;paintDurationTimer();return {running:cfg.running,remaining:cfg.remaining,endAtFuture:cfg.endAt>Date.now(),history:cfg.history.length,value:document.getElementById('durationValue').textContent};})()`);
    await timer.evaluate(`cfg.running=false;cfg.endAt=0;cfg.remaining=60;cfg.loop=false;save();renderDurationTimer();true`);

    alarm = await openWidget('alarmClock');
    await alarm.evaluate(`require('electron').ipcRenderer.send('resize:'+instId,{width:240,height:145});true`);
    await alarm.evaluate(`cfg.snoozeMin=10;cfg.ringingId='';cfg.alarmSound={mode:'none',filePath:'',fileName:'',volume:.85,repeat:true};cfg.alarms=[{id:'alarm-reference',time:'11:58',label:'抢购闹钟',repeat:[],enabled:true,lastFiredKey:'',snoozeUntil:0}];alarmQueue=[];save();renderAlarm();true`);
    await wait(320);
    const alarmMinIdle = await alarm.evaluate(`({layout:${overflowExpression()},title:document.querySelector('.alarm-idle-head strong').textContent,rows:document.querySelectorAll('.alarm-row').length,next:document.getElementById('nextAlarm').textContent,add:{width:document.querySelector('.alarm-add').offsetWidth,height:document.querySelector('.alarm-add').offsetHeight},surface:getComputedStyle(document.querySelector('.alarm-widget')).backgroundImage,outer:getComputedStyle(document.getElementById('card')).backgroundColor})`);
    await alarm.screenshot(path.join(output, 'alarm-minimum-idle.png'));

    const defaultSound = await alarm.evaluate(`alarmSoundConfig(normalizeConfig({}).alarmSound)`);
    const routeSystem = await alarm.evaluate(`(async()=>{const bridge=require('electron').ipcRenderer,original=bridge.send,sent=[];bridge.send=function(channel,...args){sent.push({channel,args});};try{cfg.alarmSound={mode:'system',filePath:'',fileName:'',volume:.85,repeat:false};startAlarmSound();await new Promise((resolve)=>setTimeout(resolve,80));stopAlarmSound();return sent;}finally{bridge.send=original;}})()`);
    const routeNone = await alarm.evaluate(`(async()=>{const bridge=require('electron').ipcRenderer,original=bridge.send,sent=[];bridge.send=function(channel,...args){sent.push({channel,args});};try{cfg.alarmSound={mode:'none',filePath:'',fileName:'',volume:.85,repeat:true};startAlarmSound();await new Promise((resolve)=>setTimeout(resolve,80));stopAlarmSound();return sent;}finally{bridge.send=original;}})()`);

    let customPlayback = { skipped: true };
    let customFallback = { skipped: true };
    if (!attachMode) {
      const soundLiteral = JSON.stringify(customSound);
      customPlayback = await alarm.evaluate(`(async()=>{const bridge=require('electron').ipcRenderer,original=bridge.send,sent=[];bridge.send=function(channel,...args){sent.push({channel,args});};try{cfg.alarmSound={mode:'custom',filePath:${soundLiteral},fileName:'validation-tone.wav',volume:.42,repeat:true};startAlarmSound();await new Promise((resolve)=>setTimeout(resolve,500));const audio=alarmAudio;const state={exists:!!audio,src:audio&&audio.src,loop:audio&&audio.loop,volume:audio&&audio.volume,paused:audio&&audio.paused,error:audio&&audio.error&&audio.error.code,sent};stopAlarmSound();return state;}finally{bridge.send=original;}})()`);
      customFallback = await alarm.evaluate(`(async()=>{const bridge=require('electron').ipcRenderer,original=bridge.send,sent=[];bridge.send=function(channel,...args){sent.push({channel,args});};try{cfg.alarmSound={mode:'custom',filePath:${JSON.stringify(path.join(profileDir, 'missing.wav'))},fileName:'missing.wav',volume:.5,repeat:true};startAlarmSound();await new Promise((resolve)=>setTimeout(resolve,450));stopAlarmSound();return sent;}finally{bridge.send=original;}})()`);
      // Exercise the real main-process default Windows sound route once, without repetition.
      await alarm.evaluate(`require('electron').ipcRenderer.send('studio:alarm-system-start:'+instId,{repeat:false});true`);
      await wait(120);
      await alarm.evaluate(`require('electron').ipcRenderer.send('studio:alarm-system-stop:'+instId);true`);
    }

    const queuedFirst = await alarm.evaluate(`(()=>{const now=new Date(),time=pad(now.getHours())+':'+pad(now.getMinutes());cfg.alarmSound={mode:'none',filePath:'',fileName:'',volume:.85,repeat:true};cfg.ringingId='';alarmQueue=[];cfg.alarms=[{id:'first',time,label:'第一提醒',repeat:[],enabled:true,lastFiredKey:'',snoozeUntil:0},{id:'second',time,label:'第二提醒',repeat:[],enabled:true,lastFiredKey:'',snoozeUntil:0}];lastAlarmScanAt=Date.now()-70000;paintAlarm();return {ringingId:cfg.ringingId,queue:alarmQueue.map((item)=>item.id),enabled:cfg.alarms.map((item)=>item.enabled)};})()`);
    await alarm.evaluate(`document.querySelector('[data-action="alarm-dismiss"]').click();true`);
    await wait(120);
    const queuedSecond = await alarm.evaluate(`({ringingId:cfg.ringingId,queue:alarmQueue.map((item)=>item.id),dialog:!!document.querySelector('.alarm-dialog')})`);
    await alarm.evaluate(`document.querySelector('[data-action="alarm-dismiss"]').click();true`);

    await alarm.evaluate(`cfg.snoozeMin=10;cfg.alarmSound.mode='none';cfg.alarms=[{id:'snooze',time:'11:58',label:'稍后提醒',repeat:[],enabled:false,lastFiredKey:'',snoozeUntil:0}];cfg.ringingId='snooze';renderAlarm();true`);
    await wait(100);
    const alarmRinging = await alarm.evaluate(`({dialog:!!document.querySelector('.alarm-dialog'),label:document.querySelector('.alarm-alert-head small').textContent,time:document.querySelector('.alarm-alert-head b').textContent,snooze:document.getElementById('alarmSnoozeSelect').value,buttons:[...document.querySelectorAll('.alarm-alert-actions button')].map((button)=>({text:button.textContent.trim(),width:button.offsetWidth,height:button.offsetHeight})),toastVisible:!toastNode.hidden,layout:${overflowExpression()}})`);
    await alarm.screenshot(path.join(output, 'alarm-minimum-ringing.png'));
    await alarm.evaluate(`(()=>{const select=document.getElementById('alarmSnoozeSelect');select.value='15';document.querySelector('[data-action="alarm-snooze"]').click();return true;})()`);
    await wait(100);
    const alarmSnoozed = await alarm.evaluate(`({ringingId:cfg.ringingId,snoozeMin:cfg.snoozeMin,snoozeMinutes:Math.round((cfg.alarms[0].snoozeUntil-Date.now())/60000),enabled:cfg.alarms[0].enabled})`);
    await alarm.evaluate(`cfg.ringingId='snooze';renderAlarm();document.querySelector('[data-action="alarm-dismiss"]').click();true`);
    const alarmDismissed = await alarm.evaluate(`({ringingId:cfg.ringingId,enabled:cfg.alarms[0].enabled,snoozeUntil:cfg.alarms[0].snoozeUntil})`);

    let settingsSelection = { skipped: true };
    let settingsSaved = { skipped: true };
    if (!attachMode) {
      await alarm.evaluate(`require('electron').ipcRenderer.send('studio:settings-open:'+instId);true`);
      const settingsTarget = await waitFor((page)=>page.url.includes('wid=alarmClock')&&page.url.includes('settings=1'));
      const settings = new Client(settingsTarget.webSocketDebuggerUrl); await settings.ready;
      await settings.evaluate(`new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.getElementById('editAlarmSoundMode'))resolve(true);else if(Date.now()-started>5000)resolve(false);else setTimeout(check,40);};check();})`);
      await settings.screenshot(path.join(output, 'alarm-settings-sound.png'));
      settingsSelection = await settings.evaluate(`(async()=>{const bridge=require('electron').ipcRenderer,original=bridge.invoke;bridge.invoke=function(channel,...args){if(channel==='studio:alarm-sound-choose:'+instId)return Promise.resolve({ok:true,filePath:${JSON.stringify(customSound)},fileName:'validation-tone.wav'});return original.call(this,channel,...args);};try{document.querySelector('[data-edit-add="alarm-sound"]').click();await new Promise((resolve)=>setTimeout(resolve,100));return {mode:editDraft.alarmSound.mode,filePath:editDraft.alarmSound.filePath,fileName:editDraft.alarmSound.fileName,shown:[...document.querySelectorAll('.inline-field input')].map((input)=>input.value)};}finally{bridge.invoke=original;}})()`);
      await settings.evaluate(`(()=>{const bridge=require('electron').ipcRenderer,original=bridge.send;bridge.send=function(channel,...args){if(channel==='studio:settings-close:'+instId)return;return original.call(this,channel,...args);};try{document.getElementById('editAlarmSoundMode').value='custom';document.getElementById('editAlarmSoundRepeat').value='0';document.getElementById('editAlarmSoundVolume').value='42';document.getElementById('editSnoozeMin').value='17';saveEditor();return {sound:cfg.alarmSound,snoozeMin:cfg.snoozeMin};}finally{bridge.send=original;}})()`);
      await wait(250);
      await settings.evaluate(`require('electron').ipcRenderer.send('studio:settings-close:'+instId);true`).catch(()=>{});
      await wait(120);
      settings.close();
      settingsSaved = await alarm.evaluate(`({sound:cfg.alarmSound,snoozeMin:cfg.snoozeMin})`);
    }

    const adapterSource = fs.readFileSync(path.join(appDir, 'widgets', 'studio', 'adapter.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
    const sourceAudit = {
      max20Mb: adapterSource.includes('20 * 1024 * 1024'),
      copiedToPrivateStore: adapterSource.includes("app.getPath('userData'), 'alarm-sounds'") && adapterSource.includes('copyFile(source, target)'),
      audioFilter: /extensions:\s*\['wav', 'mp3', 'm4a', 'aac', 'ogg'\]/.test(adapterSource),
      defaultBeep: adapterSource.includes('shell.beep()'),
      repeatEvery1800: adapterSource.includes('}, 1800)'),
      maxRepeat60s: adapterSource.includes('60_000'),
      stopsOnClose: /win\.on\('closed',[\s\S]{0,180}stopSystemAlarm\(\)/.test(adapterSource),
      backgroundUnthrottled: /backgroundThrottling:\s*!\['alarmClock','durationTimer','simplePomodoro'\]\.includes\(instance\.widgetId\)/.test(mainSource),
    };

    assert(timerMin.layout.viewport[0] === 220 && timerMin.layout.viewport[1] === 130, 'timer minimum size was not applied');
    assert(timerMin.layout.document[0] === 220 && timerMin.layout.document[1] === 130 && timerMin.layout.visibleOverflow.length === 0, 'timer minimum layout overflow');
    assert(timerMin.title === '倒计时工具' && timerMin.value === '00:15:00', 'timer idle content regression');
    assert(timerMin.buttons.every((button)=>button.width>0&&button.height>=30), 'timer minimum actions are not usable');
    assert(timerMin.outer === 'rgba(0, 0, 0, 0)', 'timer still stacks a second translucent outer background');
    assert(!timerFinished.running && timerFinished.remaining === 0 && timerFinished.history === 1 && timerFinished.value === '00:00:00' && !timerFinished.toastVisible, 'timer did not finish cleanly from endAt');
    assert(timerLoop.running && timerLoop.remaining === 60 && timerLoop.endAtFuture && timerLoop.history === 2, 'timer loop did not start the next round');
    assert(alarmMinIdle.layout.viewport[0] === 240 && Math.abs(alarmMinIdle.layout.viewport[1]-145) <= 1, 'alarm minimum size was not applied: '+JSON.stringify(alarmMinIdle.layout.viewport));
    assert(alarmMinIdle.layout.document[0] === alarmMinIdle.layout.viewport[0] && alarmMinIdle.layout.document[1] === alarmMinIdle.layout.viewport[1] && alarmMinIdle.layout.visibleOverflow.length === 0, 'alarm minimum idle layout overflow');
    assert(alarmMinIdle.outer === 'rgba(0, 0, 0, 0)', 'alarm still stacks a second translucent outer background');
    assert(defaultSound.mode === 'system' && defaultSound.repeat === true && defaultSound.volume === .85, 'alarm default sound is not Windows/system repeat');
    assert(routeSystem.some((item)=>item.channel.includes('alarm-system-start')&&item.args[0]&&item.args[0].repeat===false), 'system sound route missing');
    assert(!routeNone.some((item)=>item.channel.includes('alarm-system-start')), 'mute mode still starts sound');
    if (!attachMode) {
      assert(customPlayback.exists && customPlayback.loop && Math.abs(customPlayback.volume-.42)<.001 && customPlayback.src.includes('validation-tone.wav'), 'custom audio did not load with repeat/volume');
      assert(!customPlayback.sent.some((item)=>item.channel.includes('alarm-system-start')), 'valid custom audio unexpectedly fell back to system sound');
      assert(customFallback.some((item)=>item.channel.includes('alarm-system-start')), 'invalid custom audio did not fall back to system sound');
      assert(settingsSelection.mode === 'custom' && settingsSelection.fileName === 'validation-tone.wav' && settingsSelection.filePath === customSound, 'custom sound chooser result was not retained in editor');
      assert(settingsSaved.sound.mode === 'custom' && settingsSaved.sound.filePath === customSound && settingsSaved.sound.repeat === false && Math.abs(settingsSaved.sound.volume-.42)<.001 && settingsSaved.snoozeMin === 17, 'custom sound settings were not saved');
    }
    assert(queuedFirst.ringingId === 'first' && queuedFirst.queue.join(',') === 'second' && queuedFirst.enabled[0] === false && queuedFirst.enabled[1] === true, 'same-minute alarms were not queued safely: '+JSON.stringify(queuedFirst));
    assert(queuedSecond.ringingId === 'second' && queuedSecond.queue.length === 0 && queuedSecond.dialog, 'queued alarm did not start after dismiss: '+JSON.stringify(queuedSecond));
    assert(alarmRinging.dialog && !alarmRinging.toastVisible && alarmRinging.buttons.map((button)=>button.text).join('/') === '推迟/取消' && alarmRinging.buttons.every((button)=>button.width>0&&button.height>=30), 'minimum ringing controls are not usable');
    assert(alarmRinging.layout.document[0] === alarmRinging.layout.viewport[0] && alarmRinging.layout.document[1] === alarmRinging.layout.viewport[1] && alarmRinging.layout.visibleOverflow.length === 0, 'alarm minimum ringing layout overflow');
    assert(!alarmSnoozed.ringingId && alarmSnoozed.snoozeMin === 15 && alarmSnoozed.snoozeMinutes === 15, 'snooze did not persist selected duration');
    assert(!alarmDismissed.ringingId && !alarmDismissed.enabled && alarmDismissed.snoozeUntil === 0, 'dismiss did not clear one-time alarm');
    assert(Object.values(sourceAudit).every(Boolean), 'alarm/timer source safety audit failed: '+JSON.stringify(sourceAudit));

    const result = { output, timerMin, timerFinished, timerLoop, alarmMinIdle, defaultSound, routeSystem, routeNone, customPlayback, customFallback, queuedFirst, queuedSecond, alarmRinging, alarmSnoozed, alarmDismissed, settingsSelection, settingsSaved, sourceAudit };
    fs.writeFileSync(path.join(outputRoot, 'alarm-timer-result.json'), JSON.stringify(result, null, 2));
    console.log('ALARM_TIMER_REFERENCE|' + JSON.stringify(result));
  } finally {
    if (timer) timer.close();
    if (alarm) alarm.close();
    await quit(child);
  }

  if (!attachMode) {
    const saved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const savedAlarm = saved.instances.find((item)=>item.id==='reference-alarm');
    assert(savedAlarm && savedAlarm.config && savedAlarm.config.alarmSound && savedAlarm.config.alarmSound.filePath === customSound, 'custom alarm sound did not persist to config.json');
    assert(fs.existsSync(customSound) && fs.statSync(customSound).isFile(), 'custom sound private copy is missing');
    const restartChild = await launch(false, 9441);
    let restartAlarm;
    let restartState;
    try {
      restartAlarm = await openWidget('alarmClock');
      restartState = await restartAlarm.evaluate(`({sound:cfg.alarmSound,snoozeMin:cfg.snoozeMin,ringingId:cfg.ringingId})`);
      assert(restartState.sound.mode === 'custom' && restartState.sound.filePath === customSound && restartState.sound.repeat === false && Math.abs(restartState.sound.volume-.42)<.001 && restartState.snoozeMin === 17, 'custom alarm sound did not survive a real restart');
    } finally {
      if (restartAlarm) restartAlarm.close();
      await quit(restartChild);
    }
    console.log('ALARM_TIMER_PERSISTENCE|' + JSON.stringify({ outputRoot, customSound, savedSound:savedAlarm.config.alarmSound, restartState }));
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
