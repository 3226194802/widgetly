const port = Number(process.argv[2] || 9389);

class Client {
  constructor(url) {
    this.next = 1; this.pending = new Map(); this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = (event) => {
      const data = JSON.parse(event.data), pending = this.pending.get(data.id);
      if (!pending) return; this.pending.delete(data.id);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    };
  }
  async send(method, params = {}) { await this.ready; return new Promise((resolve, reject) => { const id = this.next++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return result.result.value; }
  close() { this.socket.close(); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((page) => page.type === 'page');
  const open = async (wid) => {
    const target = pages.find((page) => page.url.includes(`wid=${wid}`) && !page.url.includes('settings=1'));
    if (!target) throw new Error(`Missing ${wid}`);
    const client = new Client(target.webSocketDebuggerUrl); await client.ready; return client;
  };

  const calendar = await open('miniCalendarGlass');
  await calendar.evaluate('location.reload();true'); await wait(350);
  const calendarInitial = await calendar.evaluate(`(() => {
    const title=document.querySelector('.month-head h3'),button=document.querySelector('[data-action="lunar-toggle"]');
    return {title:title.textContent,oneLine:title.scrollHeight<=title.getBoundingClientRect().height+1,lunarCells:document.querySelectorAll('.cal-lunar').length,hoverData:[...document.querySelectorAll('.cal-day')].filter((day)=>day.dataset.lunar.startsWith('农历')).length,toggleActive:button.classList.contains('active')};
  })()`);
  await calendar.evaluate(`document.querySelector('[data-action="lunar-toggle"]').click();true`); await wait(160);
  const calendarHidden = await calendar.evaluate(`({lunarCells:document.querySelectorAll('.cal-lunar').length,showLunar:cfg.showLunar})`);
  await calendar.evaluate(`document.querySelector('[data-action="lunar-toggle"]').click();true`); calendar.close();

  const combo = await open('clockCalendar');
  await combo.evaluate('location.reload();true'); await wait(350);
  const comboState = await combo.evaluate(`({clock:!!document.querySelector('.combo-clock'),calendar:!!document.querySelector('.combo-calendar'),days:document.querySelectorAll('.combo-calendar .cal-day').length,lunarToggle:!!document.querySelector('.combo-calendar [data-action="lunar-toggle"]'),time:document.getElementById('comboTime').textContent})`);
  combo.close();

  const timer = await open('durationTimer');
  await timer.evaluate('location.reload();true'); await wait(300);
  await timer.evaluate(`(()=>{const select=document.getElementById('durationPresetSelect');select.value='15';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-action="timer-toggle"]').click();return true;})()`);
  await wait(1250);
  const running = await timer.evaluate(`({selected:cfg.selectedMinutes,running:cfg.running,remaining:timerRemaining(),value:document.getElementById('durationValue').textContent,toggle:document.querySelector('[data-action="timer-toggle"]').textContent.trim(),stop:document.querySelector('[data-action="timer-reset"]').textContent.trim()})`);
  await timer.evaluate(`document.querySelector('[data-action="timer-toggle"]').click();document.querySelector('[data-action="timer-loop"]').click();true`); await wait(120);
  const paused = await timer.evaluate(`({running:cfg.running,loop:cfg.loop,remaining:timerRemaining(),history:Array.isArray(cfg.history),toggle:document.querySelector('[data-action="timer-toggle"]').textContent.trim(),format:document.getElementById('durationValue').textContent.split(':').length})`);
  timer.close();

  const alarm = await open('alarmClock');
  await alarm.evaluate(`cfg.alarms=[{id:'alarm-smoke',time:'07:30',label:'测试闹钟',repeat:[1,2,3,4,5],enabled:true,lastFiredKey:'',snoozeUntil:0}];cfg.ringingId='';save();renderAlarm();true`); await wait(120);
  const alarmRendered = await alarm.evaluate(`({rows:document.querySelectorAll('.alarm-row').length,label:document.querySelector('.alarm-row strong').textContent,enabled:cfg.alarms[0].enabled})`);
  await alarm.evaluate(`document.querySelector('.alarm-row').click();true`); await wait(100);
  const alarmToggled = await alarm.evaluate(`({enabled:cfg.alarms[0].enabled,button:document.querySelector('.alarm-row b').textContent})`);
  await alarm.evaluate(`cfg.alarms[0].enabled=true;cfg.ringingId='alarm-smoke';save();renderAlarm();true`);await wait(100);
  const alarmDialog = await alarm.evaluate(`({dialog:!!document.querySelector('.alarm-dialog'),select:document.getElementById('alarmSnoozeSelect').value,buttons:[...document.querySelectorAll('.alarm-alert-actions button')].map((button)=>button.textContent.trim()),label:document.querySelector('.alarm-alert-head small').textContent,time:document.querySelector('.alarm-alert-head b').textContent})`);
  await alarm.evaluate(`(()=>{const select=document.getElementById('alarmSnoozeSelect');select.value='15';document.querySelector('[data-action="alarm-snooze"]').click();return true;})()`);await wait(100);
  const alarmSnoozed = await alarm.evaluate(`({ringingId:cfg.ringingId,snoozeMin:cfg.snoozeMin,snoozeMinutes:Math.round((cfg.alarms[0].snoozeUntil-Date.now())/60000)})`);
  await alarm.evaluate(`cfg.ringingId='alarm-smoke';renderAlarm();document.querySelector('[data-action="alarm-dismiss"]').click();document.querySelector('.alarm-row').click();true`);await wait(100);
  const alarmDismissed = await alarm.evaluate(`({ringingId:cfg.ringingId,enabled:cfg.alarms[0].enabled})`);
  alarm.close();

  const result = { calendarInitial, calendarHidden, comboState, running, paused, alarmRendered, alarmToggled, alarmDialog, alarmSnoozed, alarmDismissed };
  console.log('NEW_WIDGETS|' + JSON.stringify(result));
  if (!calendarInitial.oneLine || calendarInitial.lunarCells !== 42 || calendarInitial.hoverData !== 42 || calendarHidden.lunarCells !== 0 || calendarHidden.showLunar !== false || !comboState.clock || !comboState.calendar || comboState.days !== 42 || !comboState.lunarToggle || running.selected !== 15 || !running.running || running.remaining >= 900 || running.toggle !== '暂停' || running.stop !== '停止' || paused.running || !paused.loop || paused.toggle !== '继续' || paused.format !== 3 || !alarmRendered.enabled || alarmToggled.enabled || !alarmDialog.dialog || alarmDialog.select !== '10' || alarmDialog.buttons.join('/') !== '推迟/取消' || alarmSnoozed.ringingId || alarmSnoozed.snoozeMin !== 15 || alarmSnoozed.snoozeMinutes !== 15 || alarmDismissed.ringingId || alarmDismissed.enabled) throw new Error('new widget interaction regression');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
