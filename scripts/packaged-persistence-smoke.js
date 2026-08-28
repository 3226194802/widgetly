const port = Number(process.argv[2] || 9391);
const mode = process.argv[3] || 'verify';

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
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result.value;
  }
  close() { this.socket.close(); }
}

const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((page) => page.type === 'page');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const targets = await pages();
  if (mode === 'quit') {
    const manager = targets.find((page) => page.url.includes('/manager/index.html'));
    if (!manager) throw new Error('manager target missing');
    const client = new Client(manager.webSocketDebuggerUrl);
    await client.ready;
    await client.evaluate("require('electron').ipcRenderer.send('quit-app'); true");
    client.close();
    console.log('PACKAGED_QUIT|sent');
    return;
  }

  if (mode === 'hide-lunar') {
    const target = targets.find((page) => page.url.includes('/widgets/studio/index.html') && page.url.includes('wid=miniCalendarGlass') && !page.url.includes('settings=1'));
    if (!target) throw new Error('miniCalendarGlass target missing');
    const client = new Client(target.webSocketDebuggerUrl);
    await client.ready;
    const state = await client.evaluate(`(()=>{
      if (cfg.showLunar !== false) document.querySelector('[data-action="lunar-toggle"]').click();
      return { showLunar: cfg.showLunar, lunarCells: document.querySelectorAll('.cal-lunar').length };
    })()`);
    client.close();
    console.log('PACKAGED_HIDE_LUNAR|' + JSON.stringify(state));
    if (state.showLunar !== false || state.lunarCells !== 0) throw new Error('lunar toggle failed');
    return;
  }

  const result = {};
  for (const wid of ['miniCalendarGlass', 'durationTimer', 'alarmClock']) {
    const target = targets.find((page) => page.url.includes(`/widgets/studio/index.html`) && page.url.includes(`wid=${wid}`) && !page.url.includes('settings=1'));
    if (!target) throw new Error(`${wid} target missing`);
    const client = new Client(target.webSocketDebuggerUrl);
    await client.ready;
    await wait(150);
    result[wid] = await client.evaluate(`({
      width: innerWidth,
      height: innerHeight,
      showLunar: typeof cfg.showLunar === 'boolean' ? cfg.showLunar : null,
      selected: Number.isFinite(cfg.selectedMinutes) ? cfg.selectedMinutes : null,
      loop: typeof cfg.loop === 'boolean' ? cfg.loop : null,
      alarmEnabled: Array.isArray(cfg.alarms) && cfg.alarms[0] ? cfg.alarms[0].enabled : null
    })`);
    client.close();
  }
  console.log('PACKAGED_PERSISTENCE|' + JSON.stringify(result));
  if (result.miniCalendarGlass.showLunar !== false
    || result.durationTimer.selected !== 15
    || result.durationTimer.loop !== true
    || result.alarmClock.alarmEnabled !== false) {
    throw new Error('packaged persistence regression');
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
