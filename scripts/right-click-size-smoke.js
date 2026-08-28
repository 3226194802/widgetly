const port = Number(process.argv[2] || 9389);
const allStudio = process.argv[3] === 'all-studio';
const presentOnly = process.argv[3] === 'present';
const wanted = ['clock2Sec', 'miniCalendarGlass', 'clockCalendar', 'durationTimer', 'alarmClock'];

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
const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((page) => page.type === 'page');
async function waitFor(match, timeout = 5000) { const started = Date.now(); while (Date.now() - started < timeout) { const found = (await pages()).find(match); if (found) return found; await wait(70); } throw new Error('target timeout'); }

(async () => {
  const hosts = (await pages()).filter((page) => !page.url.includes('settings=1') && (allStudio ? page.url.includes('/widgets/studio/index.html') : wanted.some((wid) => page.url.includes(`wid=${wid}`))));
  const results = [];
  for (const target of hosts) {
    const url = new URL(target.url), wid = url.searchParams.get('wid'), inst = url.searchParams.get('inst');
    const host = new Client(target.webSocketDebuggerUrl); await host.ready;
    const before = await host.evaluate('({width:innerWidth,height:innerHeight})');
    await host.evaluate(`document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:Math.round(innerWidth/2),clientY:Math.round(innerHeight/2)}));true`);
    const menuTarget = await waitFor((page) => page.url.includes('/widgets/common/menu.html') && page.url.includes(`inst=${encodeURIComponent(inst)}`));
    const menu = new Client(menuTarget.webSocketDebuggerUrl); await menu.ready; await wait(180);
    const menuState = await menu.evaluate(`({items:document.querySelectorAll('.item').length,visible:!document.hidden})`);
    await menu.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
    await wait(260);
    const after = await host.evaluate('({width:innerWidth,height:innerHeight})');
    const menuClosed = !(await pages()).some((page) => page.url.includes('/widgets/common/menu.html') && page.url.includes(`inst=${encodeURIComponent(inst)}`));
    results.push({ wid, before, after, stable: before.width === after.width && before.height === after.height, menuState, menuClosed });
    menu.close(); host.close();
  }
  results.sort((a,b) => a.wid.localeCompare(b.wid));
  results.forEach((result) => console.log('RIGHT_CLICK|' + JSON.stringify(result)));
  const expectedCount = allStudio ? 19 : presentOnly ? hosts.length : wanted.length;
  if (results.length !== expectedCount || results.some((result) => !result.stable || !result.menuState.visible || result.menuState.items < 5 || !result.menuClosed)) throw new Error('right-click regression');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
