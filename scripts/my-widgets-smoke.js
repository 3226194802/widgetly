const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const outputDir = process.argv[2] || path.join(appDir, '.widgetly-local-test', 'my-widgets-smoke');
const profileDir = path.join(outputDir, 'profile');
const debugPort = Number(process.argv[3] || 9563);
const screenshot = path.join(outputDir, 'my-widgets.png');

fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false,
  openManagerOnStart: true,
  closeToTray: true,
  pinToDesktop: false,
  instances: [
    { id: 'clock-one', widgetId: 'clock', x: 80, y: 80, config: {} },
    { id: 'clock-two', widgetId: 'clock', x: 120, y: 120, config: {} },
    { id: 'calendar-one', widgetId: 'calendar', x: 180, y: 180, config: {} },
    { id: 'dock-child', widgetId: 'clock', x: 0, y: 0, config: {}, host: { type: 'componentDock', dockId: 'dock-one' } },
    { id: 'dock-one', widgetId: 'componentDock', x: 230, y: 220, config: { children: ['dock-child'] } },
  ],
}, null, 2));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pages() {
  try { return await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); } catch (_) { return []; }
}
async function waitFor(find, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const item = (await pages()).find(find);
    if (item) return item;
    await wait(100);
  }
  throw new Error('Timed out waiting for manager window');
}
class Client {
  constructor(url) {
    this.id = 1; this.pending = new Map(); this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data); const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.id++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) { return (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value; }
  close() { this.ws.close(); }
}

(async () => {
  if (!fs.existsSync(electronExe)) throw new Error('Electron runtime not found');
  const child = spawn(electronExe, [appDir, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, '--disable-gpu', '--widgetly-test-mode'], {
    cwd: appDir, windowsHide: true, stdio: 'ignore',
  });
  let client;
  try {
    const target = await waitFor((page) => String(page.url || '').includes('/manager/index.html'));
    client = new Client(target.webSocketDebuggerUrl);
    await client.ready;
    await client.evaluate(`new Promise(resolve => { const start = Date.now(); const tick = () => (typeof widgets !== 'undefined' && widgets.length ? resolve() : (Date.now() - start > 7000 ? resolve() : setTimeout(tick, 80))); tick(); })`);
    await client.evaluate(`document.getElementById('mineNav').click(); true`);
    await wait(900);
    const state = await client.evaluate(`(() => ({
      visible: !document.getElementById('myWidgetsView').hidden,
      groupedCards: document.querySelectorAll('#myWidgetsGrid .my-widget-card').length,
      clockBadge: document.querySelector('#myWidgetsGrid [data-wid="clock"] .repeat-badge')?.textContent || '',
      hostedClockCounted: document.querySelector('#myWidgetsGrid [data-wid="clock"] .item-meta')?.textContent || '',
      manageBefore: document.getElementById('manageWidgets').textContent,
    }))()`);
    await client.evaluate(`document.getElementById('manageWidgets').click(); true`);
    await wait(100);
    const managed = await client.evaluate(`(() => ({
      manageAfter: document.getElementById('manageWidgets').textContent,
      deleteButtons: document.querySelectorAll('#myWidgetsGrid .my-widget-remove').length,
      manageLayers: document.querySelectorAll('#myWidgetsGrid .my-widget-card.is-managing').length,
    }))()`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    const result = { ...state, ...managed, screenshot };
    if (!result.visible || result.groupedCards !== 3 || result.clockBadge !== '×2' || result.hostedClockCounted !== '桌面已有 2 个'
      || result.manageBefore !== '管理' || result.manageAfter !== '完成管理' || result.deleteButtons !== 4 || result.manageLayers !== 3) {
      throw new Error('My widgets UI regression: ' + JSON.stringify(result));
    }
    console.log('MY_WIDGETS_SMOKE|' + JSON.stringify(result));
  } finally {
    if (client) client.close();
    if (child.exitCode === null) child.kill();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
