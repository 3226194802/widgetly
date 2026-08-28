const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const stamp = new Date().toISOString().replace(/[.:]/g, '-');
const outputDir = process.argv[2] || path.join('F:\\', `Widgetly-test-transparency-${stamp}`);
const profileDir = path.join(outputDir, 'profile');
const screenshotDir = path.join(outputDir, 'screens');
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const defaultWidgets = [
  'clock', 'calendarMini', 'launcher', 'dock', 'galleryS', 'todo', 'memory', 'monitor',
  'sysmon', 'pomodoro', 'clock2', 'weather', 'countdownSingle', 'promptOptimizer',
  'durationTimer', 'alarmClock',
];
const widgets = process.env.WIDGETLY_TRANSPARENCY_WIDGETS
  ? process.env.WIDGETLY_TRANSPARENCY_WIDGETS.split(',').map((item) => item.trim()).filter(Boolean)
  : defaultWidgets;
const basePort = Number(process.env.WIDGETLY_TRANSPARENCY_PORT) || 9521;

const instances = widgets.map((widgetId, index) => ({
  id: `opacity-${widgetId}`,
  widgetId,
  x: 24 + (index % 6) * 205,
  y: 24 + Math.floor(index / 6) * 210,
  config: widgetId === 'alarmClock'
    ? { alarmSound: { mode: 'none', filePath: '', fileName: '', volume: .85, repeat: true } }
    : {},
}));

fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  theme: 'dark', autostart: false, openManagerOnStart: false, closeToTray: true,
  managerOpacity: .5, pinToDesktop: false, instances,
}, null, 2));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
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
      clearTimeout(pending.timer);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
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
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(detail || result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result.value;
  }
  close() { try { this.socket.close(); } catch (_) {} }
}

async function pages(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((page) => page.type === 'page');
}

async function waitFor(port, match, timeout = 18_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const target = (await pages(port)).find(match);
      if (target) return target;
    } catch (_) {}
    await wait(100);
  }
  throw new Error('Target timeout');
}

async function waitForWidgetCount(port, count, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const list = await pages(port);
      const hosts = list.filter((page) => {
        try {
          const url = new URL(page.url);
          return url.searchParams.get('inst') && !url.searchParams.get('settings') && !url.pathname.endsWith('/common/menu.html');
        } catch (_) { return false; }
      });
      if (hosts.length >= count) return hosts;
    } catch (_) {}
    await wait(120);
  }
  throw new Error(`Widget targets timeout: expected ${count}`);
}

function alphaExpression(widgetId) {
  if (widgetId === 'clock') return "Number(getComputedStyle(document.documentElement).getPropertyValue('--veil-opacity'))";
  if (widgetId.startsWith('calendar') || widgetId === 'launcher') return "Number(getComputedStyle(document.documentElement).getPropertyValue('--veil-opacity'))";
  if (widgetId === 'dock') return "Number(getComputedStyle(document.querySelector('.veil')).opacity)";
  if (widgetId === 'monitor') return "Number(getComputedStyle(document.getElementById('card')).getPropertyValue('--bg-a'))";
  if (widgetId === 'pomodoro') return "Number(getComputedStyle(document.getElementById('veil')).opacity)";
  if (widgetId === 'todo') return "Number(getComputedStyle(document.getElementById('veil')).opacity)";
  if (widgetId === 'memory') return "Number(getComputedStyle(document.documentElement).getPropertyValue('--widgetly-bg-alpha'))";
  if (widgetId === 'sysmon') return "(()=>{const value=getComputedStyle(document.getElementById('card')).backgroundColor;const match=value.match(/rgba?\\(([^)]+)\\)/i);if(!match)return NaN;const parts=match[1].split(/[,\\s/]+/).filter(Boolean);return parts.length>=4?Number(parts[3]):1;})()";
  if (['clock2','weather'].includes(widgetId)) return "Number(getComputedStyle(document.querySelector('.card')).getPropertyValue('--widgetly-bg-alpha'))";
  if (widgetId.startsWith('countdown')) return "Number(getComputedStyle(document.documentElement).getPropertyValue('--bg-opacity'))";
  if (widgetId === 'galleryS') return "Number(getComputedStyle(document.documentElement).getPropertyValue('--widgetly-bg-alpha'))";
  if (widgetId === 'promptOptimizer') return 'Number(state.bgOpacity)';
  return 'Number(cfg.bgOpacity)';
}

async function readVisualState(client, widgetId) {
  const alpha = await client.eval(`Number((${alphaExpression(widgetId)}).toFixed(4))`);
  let surface = '';
  if (widgetId === 'durationTimer') surface = await client.eval(`getComputedStyle(document.querySelector('.duration-timer')).backgroundImage`);
  if (widgetId === 'alarmClock') surface = await client.eval(`getComputedStyle(document.querySelector('.alarm-widget')).backgroundImage`);
  let debug;
  if (widgetId === 'pomodoro') debug = await client.eval(`({
    inline: document.getElementById('veil').style.opacity,
    listeners: require('electron').ipcRenderer.listenerCount('widgetly:background-transparency:' + new URLSearchParams(location.search).get('inst')),
  })`);
  return { alpha, surface, ...(debug ? { debug } : {}) };
}

function isZeroAlphaSurface(value) {
  const alphas = [...String(value || '').matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((match) => Number(match[1]));
  return alphas.length >= 2 && alphas.every((alpha) => alpha <= .001);
}

async function launch(port) {
  const child = spawn(electronExe, [
    appDir,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--widgetly-test-mode',
  ], { cwd: appDir, windowsHide: true, stdio: 'ignore' });
  child.exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  await waitForWidgetCount(port, widgets.length);
  return child;
}

async function quit(port, child) {
  try {
    const host = (await pages(port)).find((page) => page.url.includes('wid=alarmClock'))
      || (await pages(port)).find((page) => page.url.includes('wid='));
    if (host) {
      const client = new Cdp(host.webSocketDebuggerUrl); await client.ready;
      await client.eval(`require('electron').ipcRenderer.send('quit-app');true`);
      client.close();
    }
  } catch (_) {}
  const exited = await Promise.race([child.exitPromise.then(() => true), wait(8000).then(() => false)]);
  if (!exited) child.kill();
}

async function firstRun(port) {
  const child = await launch(port);
  const results = [];
  try {
    for (const widgetId of widgets) {
      console.log('TRANSPARENCY_START|' + widgetId);
      const inst = `opacity-${widgetId}`;
      const hostTarget = await waitFor(port, (page) => {
        try { return new URL(page.url).searchParams.get('inst') === inst && !new URL(page.url).searchParams.get('settings'); }
        catch (_) { return false; }
      });
      const host = new Cdp(hostTarget.webSocketDebuggerUrl); await host.ready;
      const hostReady = await host.eval(`new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.readyState==='complete'&&document.body&&window.__widgetlyCommonMenu)resolve(true);else if(Date.now()-started>6000)resolve(false);else setTimeout(check,40);};check();})`);
      if (!hostReady) throw new Error(`Widget renderer not ready: ${widgetId}`);
      const prevented = await host.eval(`(()=>{const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:40,clientY:40});document.body.dispatchEvent(event);return event.defaultPrevented;})()`);
      const menuTarget = await waitFor(port, (page) => {
        try { const url = new URL(page.url); return url.pathname.endsWith('/widgets/common/menu.html') && url.searchParams.get('inst') === inst; }
        catch (_) { return false; }
      }, 6000);
      const menu = new Cdp(menuTarget.webSocketDebuggerUrl); await menu.ready; await wait(90);
      await menu.eval(`new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.body&&document.querySelector('input[type=range]'))resolve(true);else if(Date.now()-started>4000)resolve(false);else setTimeout(check,40);};check();})`);
      const menuState = await menu.eval(`({slider:document.querySelectorAll('input[type=range]').length,text:document.body.innerText})`);
      const setTransparency = async (value) => {
        await menu.eval(`(()=>{const input=document.querySelector('input[type=range]');input.value='${value}';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
        // Several legacy families animate their background layer for 250 ms.
        // Read after the transition settles so this validates the final visual
        // alpha rather than an in-flight interpolation value.
        await wait(360);
        return readVisualState(host, widgetId);
      };
      const transparent = await setTransparency(100);
      if (widgetId === 'durationTimer' || widgetId === 'alarmClock') {
        const shot = await host.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        fs.writeFileSync(path.join(screenshotDir, `${widgetId}-transparent.png`), Buffer.from(shot.data, 'base64'));
      }
      const opaque = await setTransparency(0);
      const persisted = await setTransparency(63);
      if (results.length === 0) {
        const shot = await menu.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        fs.writeFileSync(path.join(screenshotDir, 'unified-menu.png'), Buffer.from(shot.data, 'base64'));
      }
      await menu.eval(`require('electron').ipcRenderer.send('widgetly-menu:close:${inst}');true`).catch(() => {});
      menu.close(); host.close();
      const result = { widgetId, prevented, menuState, transparent, opaque, persisted };
      results.push(result);
      console.log('TRANSPARENCY_FAMILY|' + JSON.stringify(result));
      if (!prevented || menuState.slider !== 1 || !menuState.text.includes('背景透明度')
        || !(transparent.alpha <= .01) || !(opaque.alpha >= .99) || Math.abs(persisted.alpha - .37) > .011
        || ((widgetId === 'durationTimer' || widgetId === 'alarmClock') && !isZeroAlphaSurface(transparent.surface))) {
        throw new Error(`Transparency regression: ${widgetId}`);
      }
      await wait(80);
    }
  } finally {
    await quit(port, child);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
  const persistence = saved.instances.map((item) => ({
    widgetId: item.widgetId,
    percent: item.windowState && item.windowState.backgroundTransparency,
  }));
  if (persistence.some((item) => item.percent !== 63)) throw new Error('Canonical transparency persistence regression');
  return { results, persistence };
}

async function restartRun(port) {
  const child = await launch(port);
  const states = [];
  try {
    for (const widgetId of widgets) {
      const inst = `opacity-${widgetId}`;
      const target = await waitFor(port, (page) => {
        try { return new URL(page.url).searchParams.get('inst') === inst && !new URL(page.url).searchParams.get('settings'); }
        catch (_) { return false; }
      });
      const client = new Cdp(target.webSocketDebuggerUrl); await client.ready;
      const ready = await client.eval(`new Promise((resolve)=>{const started=Date.now();const check=()=>{if(document.readyState==='complete'&&document.body)resolve(true);else if(Date.now()-started>6000)resolve(false);else setTimeout(check,40);};check();})`);
      if (!ready) throw new Error(`Restart renderer not ready: ${widgetId}`);
      // The main-process adapter pushes restored state just after did-finish-load.
      // With many windows launching together, wait for that concrete restored
      // alpha instead of assuming an arbitrary load delay.
      const restored = await client.eval(`new Promise((resolve)=>{const started=Date.now();const check=()=>{let alpha=NaN;try{alpha=Number(${alphaExpression(widgetId)});}catch(_){}if(Number.isFinite(alpha)&&Math.abs(alpha-.37)<=.011)resolve(true);else if(Date.now()-started>8000)resolve(false);else setTimeout(check,60);};check();})`);
      if (!restored) throw new Error(`Restart state delivery timeout: ${widgetId}`);
      const state = await readVisualState(client, widgetId); client.close();
      states.push({ widgetId, ...state });
      console.log('TRANSPARENCY_RESTART|' + JSON.stringify({ widgetId, ...state }));
      if (Math.abs(state.alpha - .37) > .011) throw new Error(`Restart transparency regression: ${widgetId}=${state.alpha}`);
    }
  } finally {
    await quit(port, child);
  }
  return states;
}

(async () => {
  if (!fs.existsSync(electronExe)) throw new Error('Electron runtime not found: ' + electronExe);
  const first = await firstRun(basePort);
  const restart = await restartRun(basePort + 1);
  const summary = { outputDir, families: first.results.length, persistence: first.persistence, restart };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(summary, null, 2));
  console.log('TRANSPARENCY_RESULT|' + JSON.stringify(summary));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
