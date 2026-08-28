const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const port = Number(process.argv[2] || 9582);
const outputDir = path.join(appDir, '.widgetly-crash-test', `dock-debug-${Date.now()}`);
const profileDir = path.join(outputDir, 'profile');
const dockId = 'component-dock-debug';
const childIds = ['dbg-a', 'dbg-b', 'dbg-c'];
const widgetIds = ['digitalClockGlass', 'miniCalendarGlass', 'lineWeather'];
const INITIAL = [{ x: 0, y: 0, w: .30, h: .24 }, { x: .32, y: 0, w: .32, h: .24 }, { x: .66, y: 0, w: .32, h: .24 }];
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false, openManagerOnStart: false, closeToTray: true, pinToDesktop: false,
  instances: [
    { id: dockId, widgetId: 'componentDock', x: 60, y: 60, config: { layout: 'free', children: childIds.map((id, i) => ({ instanceId: id, slotId: 'slot-' + id, surface: 'inherit', rect: { ...INITIAL[i] }, manual: false })) } },
    ...childIds.map((id, i) => ({ id, widgetId: widgetIds[i], x: 0, y: 0, host: { type: 'componentDock', dockId }, config: {} })),
  ],
}, null, 2));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(url) { this.next = 1; this.pending = new Map(); this.socket = new WebSocket(url); this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); this.socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = this.pending.get(d.id); if (!p) return; this.pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }); }
  async send(method, params = {}) { await this.ready; return new Promise((resolve, reject) => { const id = this.next++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
  close() { try { this.socket.close(); } catch (_) {} }
}
async function pages() { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((i) => i.type === 'page'); }
async function waitFor(match, timeout = 25_000) { const started = Date.now(); while (Date.now() - started < timeout) { try { const f = (await pages()).find(match); if (f) return f; } catch (_) {} await wait(90); } throw new Error('timeout'); }
(async () => {
  let child = null; let dock = null;
  try {
    child = spawn(electronExe, [appDir, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--widgetly-test-mode'], { cwd: appDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const target = await waitFor((p) => { try { return new URL(p.url).pathname.endsWith('/widgets/componentDock/index.html'); } catch (_) { return false; } });
    dock = new Cdp(target.webSocketDebuggerUrl); await dock.ready;
    await wait(500);
    const scenarios = [
      { dockId, focusId: 'dbg-c', rect: { x: .66, y: 0, w: .5, h: .3 }, intent: 'resize-se' },
      { dockId, focusId: 'dbg-c', rect: { x: .66, y: 0, w: .44, h: .3 }, intent: 'resize-se' },
      { dockId, focusId: 'dbg-a', rect: { x: 0, y: 0, w: .3, h: .24 }, intent: 'resize-e' },
    ];
    const results = await dock.eval(`require('electron').ipcRenderer.invoke('componentDock:test-resolve', ${JSON.stringify(scenarios)})`);
    console.log(JSON.stringify(results, null, 2));
  } finally { if (dock) dock.close(); if (child && child.exitCode === null) { try { child.kill(); } catch (_) {} await wait(400); } }
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
