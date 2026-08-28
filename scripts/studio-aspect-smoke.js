const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 9381);
const output = process.argv[3] || 'F:\\Widgetly-test-studio\\aspects';
const cases = {
  plannerCalendar: [[900,360],[520,650]], quadrantTasks: [[680,280],[280,650]],
  miniCalendarGlass: [[620,250],[240,600]], flipClock: [[620,104],[190,320]],
  cycleCountdown: [[620,150],[210,520]], desktopFolder: [[680,250],[250,650]],
  analogClock: [[620,130],[130,600]], digitalClockGlass: [[620,92],[180,300]],
  stickyNote: [[680,190],[230,600]], lineWeather: [[700,230],[280,600]],
  desktopSchedule: [[700,200],[250,600]], markdownNote: [[700,260],[250,650]],
  desktopCounter: [[680,150],[240,560]], classSchedule: [[680,280],[240,650]],
  progressTracker: [[700,210],[270,600]], simplePomodoro: [[680,160],[230,520]],
  clockCalendar: [[700,400],[270,760]], durationTimer: [[680,160],[260,520]], alarmClock: [[680,200],[280,620]],
};

class Cdp {
  constructor(url) {
    this.next = 1; this.pending = new Map(); this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data); const slot = this.pending.get(data.id);
      if (!slot) return; this.pending.delete(data.id);
      if (data.error) slot.reject(new Error(data.error.message)); else slot.resolve(data.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.next++; this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}
async function screenshot(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((target) => target.type === 'page' && target.url.includes('/widgets/studio/index.html'));
  const results = [];
  for (const page of pages) {
    const url = new URL(page.url); const wid = url.searchParams.get('wid'); const inst = url.searchParams.get('inst');
    if (!cases[wid]) continue;
    const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.ready;
    for (const [index, size] of cases[wid].entries()) {
      await evaluate(cdp, `require('electron').ipcRenderer.send('resize:${inst}',{width:${size[0]},height:${size[1]}});true`);
      await wait(320);
      const state = await evaluate(cdp, `(() => {
        const card = document.getElementById('card').getBoundingClientRect();
        const content = document.getElementById('content');
        const visibleOverflow = [...content.querySelectorAll('*')].filter((el) => {
          const style = getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          if (!(r.right > innerWidth + 2 || r.bottom > innerHeight + 2 || r.left < -2 || r.top < -2)) return false;
          let parent = el.parentElement;
          while (parent && parent !== document.body) {
            const ps = getComputedStyle(parent); const pr = parent.getBoundingClientRect();
            if ((ps.overflowX !== 'visible' || ps.overflowY !== 'visible') &&
                (r.right > pr.right + 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.top < pr.top - 1)) return false;
            parent = parent.parentElement;
          }
          return true;
        }).slice(0, 6).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0,80) }));
        return { viewport:[innerWidth,innerHeight], document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight], card:[card.width,card.height], visibleOverflow };
      })()`);
      await screenshot(cdp, path.join(output, `${wid}-${index === 0 ? 'wide' : 'tall'}.png`));
      results.push({ wid, aspect:index === 0 ? 'wide' : 'tall', requested:size, ...state });
    }
    cdp.close();
  }
  results.sort((a,b) => a.wid.localeCompare(b.wid) || a.aspect.localeCompare(b.aspect));
  for (const result of results) console.log('ASPECT_SMOKE|' + JSON.stringify(result));
  console.log('ASPECT_COUNT|' + results.length);
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
