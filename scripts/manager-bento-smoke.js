const fs = require('fs');

const port = Number(process.argv[2] || 9386);
const output = process.argv[3] || 'F:\\Widgetly-test-manager\\manager-bento-large.png';

class Client {
  constructor(url) {
    this.nextId = 1;
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
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.url.includes('/manager/index.html'));
  if (!target) throw new Error('Manager target missing');

  const client = new Client(target.webSocketDebuggerUrl);
  await client.ready;
  await client.evaluate(`new Promise(resolve => {
    const started = Date.now();
    const poll = () => {
      if ((typeof widgets !== 'undefined' && widgets.length >= 49) || Date.now() - started > 8000) resolve();
      else setTimeout(poll, 80);
    };
    poll();
  })`);

  const samples = ['plannerCalendar', 'quadrantTasks', 'desktopFolder', 'flipClock', 'lineWeather', 'clockS'];
  const state = await client.evaluate(`(() => {
    const grid = document.getElementById('grid');
    const cards = [...grid.querySelectorAll('.item')];
    const tileCounts = cards.reduce((all, card) => {
      const key = card.dataset.tile || 'missing';
      all[key] = (all[key] || 0) + 1;
      return all;
    }, {});
    const rects = cards.map(card => {
      const r = card.getBoundingClientRect();
      return { id: card.dataset.wid, tile: card.dataset.tile, width: r.width, height: r.height, left: r.left, top: r.top + grid.scrollTop, right: r.right, bottom: r.bottom + grid.scrollTop };
    });
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps++;
      }
    }
    const sampleData = ${JSON.stringify(samples)}.map(id => {
      const card = grid.querySelector('[data-wid="' + id + '"]');
      if (!card) return { id, missing: true };
      const r = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        id,
        tile: card.dataset.tile,
        size: [Math.round(r.width), Math.round(r.height)],
        span: [style.gridColumnEnd, style.gridRowEnd],
        loaded: card.classList.contains('loaded')
      };
    });
    return {
      count: cards.length,
      tileCounts,
      overlaps,
      invalidTiles: rects.filter(card => !['square', 'large-square'].includes(card.tile)).map(card => card.id),
      nonSquare: rects.filter(card => Math.abs(card.width - card.height) > 1).map(card => ({ id: card.id, size: [Math.round(card.width), Math.round(card.height)] })),
      groupStarts: cards.filter(card => card.classList.contains('group-start')).map(card => card.dataset.tile),
      scrollHeight: grid.scrollHeight,
      clientHeight: grid.clientHeight,
      sampleData
    };
  })()`);

  const targetId = 'plannerCalendar';
  const scrolled = await client.evaluate(`(() => {
    const grid = document.getElementById('grid');
    const card = grid.querySelector('[data-wid="${targetId}"]');
    if (!card) return false;
    grid.scrollTop = Math.max(0, card.offsetTop - grid.offsetTop - 14);
    return true;
  })()`);
  if (!scrolled) throw new Error('Large widget card missing');

  await client.evaluate(`new Promise(resolve => {
    const started = Date.now();
    const poll = () => {
      const card = document.querySelector('[data-wid="${targetId}"]');
      if (card?.classList.contains('loaded') || Date.now() - started > 10000) resolve();
      else setTimeout(poll, 100);
    };
    poll();
  })`);
  await delay(900);

  const visible = await client.evaluate(`(() => {
    const grid = document.getElementById('grid');
    return [...grid.querySelectorAll('.item')]
      .filter(card => {
        const r = card.getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        return r.bottom > g.top && r.top < g.bottom;
      })
      .map(card => ({ id: card.dataset.wid, tile: card.dataset.tile, loaded: card.classList.contains('loaded') }));
  })()`);
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  });
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));

  console.log('MANAGER_BENTO|' + JSON.stringify({ ...state, visible, output }));
  if (state.count !== 49 || state.overlaps !== 0 || state.invalidTiles.length || state.nonSquare.length
    || state.tileCounts.square !== 39 || state.tileCounts['large-square'] !== 10
    || JSON.stringify(state.groupStarts) !== JSON.stringify(['square', 'large-square'])) {
    throw new Error('manager two-size square layout regression');
  }
  client.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
